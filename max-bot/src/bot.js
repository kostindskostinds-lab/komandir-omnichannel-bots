'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Bot, Keyboard } = require('@maxhub/max-bot-api');
const { STEPS, START_STEP } = require('./steps');

const BOT_TOKEN = process.env.BOT_TOKEN;
const MANAGER_USER_ID = process.env.MANAGER_USER_ID;
const MANAGER_CHAT_ID = process.env.MANAGER_CHAT_ID;
const COMPANY_PHONE = process.env.COMPANY_PHONE || '+7 (904) 797-94-20';
const COMPANY_PHONE_2 = process.env.COMPANY_PHONE_2 || '+7 (831) 275-89-49';
const COMPANY_EMAIL = process.env.COMPANY_EMAIL || 'progress@komandir-nn.ru';

if (!BOT_TOKEN) {
  console.error('Не задан BOT_TOKEN. Скопируйте .env.example в .env и укажите токен от MasterBot (MAX).');
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// ---------- Простое персистентное состояние (чтобы переживать перезапуск) ----------
// Тот же подход, что и в komandir-telegram-bot - отдельная папка data/ у этого проекта.

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const STUCK_LOG_FILE = path.join(DATA_DIR, 'stuck-log.jsonl');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const ROUTES_FILE = path.join(DATA_DIR, 'manager-routes.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let state = {};
try {
  state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
} catch (_) {
  state = {};
}

function saveState() {
  fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), () => {});
}

function setUserStep(chatId, stepId) {
  state[chatId] = { stepId, ts: Date.now() };
  saveState();
}

function logStuck(ctx, stepId) {
  const entry = {
    ts: new Date().toISOString(),
    chatId: ctx.chatId,
    username: ctx.user ? ctx.user.username : null,
    name: ctx.user ? [ctx.user.first_name, ctx.user.last_name].filter(Boolean).join(' ') : '',
    stepId,
  };
  fs.appendFile(STUCK_LOG_FILE, JSON.stringify(entry) + '\n', () => {});
}

// Журнал событий для статистики (data/events.jsonl, одна JSON-строка на событие).
// Разбор - скриптом bot_stats.py в корне проекта. Текст вопросов клиентов сюда
// НЕ пишем, только факт отправки. Ошибки записи журнала глотаем: статистика
// никогда не должна ломать работу бота.
function logEvent(ctx, event, extra) {
  try {
    const user = (ctx && ctx.user) || {};
    const entry = {
      ts: new Date().toISOString(),
      event,
      chatId: ctx ? ctx.chatId : null,
      username: user.username || null,
      name: [user.first_name, user.last_name].filter(Boolean).join(' '),
      ...extra,
    };
    fs.appendFile(EVENTS_FILE, JSON.stringify(entry) + '\n', () => {});
  } catch (_) {}
}

// ---------- Вспомогательные функции рендеринга шагов ----------
// Кнопки в MAX - Keyboard.inlineKeyboard([[Keyboard.button.callback(текст, payload)], ...]),
// см. https://github.com/max-messenger/max-bot-api-client-ts (examples/keyboard-bot.ts).
// Payload устроен так же, как в Telegram-версии: "ok|<id>", "fail|<id>", "go|<next>|<i>", "mgr|<id>".

function buildInstructionKeyboard(stepId) {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('✅ Получилось', `ok|${stepId}`), Keyboard.button.callback('❌ Не получилось', `fail|${stepId}`)],
  ]);
}

function buildChoiceKeyboard(options) {
  return Keyboard.inlineKeyboard(options.map((opt, i) => [Keyboard.button.callback(opt.label, `go|${opt.next}|${i}`)]));
}

function buildFailKeyboard(stepId, step) {
  const rows = [];
  if (step.extraFailOption) {
    rows.push([Keyboard.button.callback(step.extraFailOption.label, `go|${step.extraFailOption.next}|x`)]);
  }
  rows.push([Keyboard.button.callback('👉 Понял, идём дальше', `go|${step.next}|c`)]);
  rows.push([Keyboard.button.callback('🙋 Всё ещё не получается — позвать менеджера', `mgr|${stepId}`)]);
  return Keyboard.inlineKeyboard(rows);
}

async function sendStep(ctx, stepId) {
  const step = STEPS[stepId];
  if (!step) {
    await ctx.reply('Что-то пошло не так — не нашёл этот шаг. Наберите /start, чтобы начать заново.');
    return;
  }

  setUserStep(ctx.chatId, stepId);
  logEvent(ctx, 'step', { stepId, stepType: step.type });

  if (step.type === 'choice' || step.type === 'end') {
    await ctx.reply(step.text, { attachments: [buildChoiceKeyboard(step.options)] });
    return;
  }

  // instruction
  await ctx.reply(step.text, { attachments: [buildInstructionKeyboard(stepId)] });
}

// Достаёт номер телефона из вложения "контакт" (payload.vcf_info - vCard-текст,
// который MAX формирует сам при нажатии кнопки "Отправить номер"; готового поля
// с номером в приходящем вложении нет). Если строку TEL не нашли - возвращаем null,
// это не должно останавливать отправку вопроса менеджеру (см. sendQuestionToManager).
function parsePhoneFromVcf(vcfInfo) {
  if (!vcfInfo) return null;
  const m = /^TEL[^:]*:(.+)$/im.exec(vcfInfo);
  return m ? m[1].trim() : null;
}

// Возвращает { ok, messageId } - messageId (mid сообщения) нужен, чтобы потом узнать
// ответ менеджера (см. "Ответ менеджера клиенту" ниже): менеджер отвечает через
// "Ответить" прямо на это сообщение в чате менеджеров, а бот по mid понимает, какому
// клиенту переслать текст - без ручного поиска клиента по id в MAX (искать по id
// пользователей MAX не даёт).
async function notifyManager(ctx, stepId, reason, question, phone) {
  // Групповой чат (MANAGER_CHAT_ID) в приоритете над личным сообщением
  // конкретному человеку (MANAGER_USER_ID) - если задан чат, все заявки
  // видит вся группа, а не один человек. Ответ через "Ответить" работает только
  // для группового чата (см. message_created ниже) - в личном чате с одним
  // менеджером эта связка не реализована.
  if (!MANAGER_CHAT_ID && !MANAGER_USER_ID) return { ok: false, messageId: null };
  const step = STEPS[stepId];
  const user = ctx.user || {};
  const who = user.username ? '@' + user.username : `id ${user.user_id}`;
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  const text =
    `🙋 ${reason}\n` +
    `Пользователь: ${name} (${who})\n` +
    (phone ? `📞 ${phone}\n` : '') +
    (step ? `Шаг: ${step.title || stepId}\n` : '') +
    (question ? `Вопрос: ${question}\n` : '') +
    (step ? `Текст шага: ${step.text}\n` : '') +
    (MANAGER_CHAT_ID ? `↩️ Чтобы ответить клиенту — используйте «Ответить» на это сообщение.` : '');
  try {
    const sent = MANAGER_CHAT_ID
      ? await bot.api.sendMessageToChat(Number(MANAGER_CHAT_ID), text)
      : await bot.api.sendMessageToUser(Number(MANAGER_USER_ID), text);
    return { ok: true, messageId: sent && sent.body ? sent.body.mid : null };
  } catch (err) {
    console.error('Не удалось отправить сообщение менеджеру:', err.message);
    return { ok: false, messageId: null };
  }
}

// ---------- Ожидание вопроса перед вызовом менеджера ----------
// При нажатии "Позвать менеджера" сначала спрашиваем текст вопроса, а уже
// следующее ТЕКСТОВОЕ сообщение пользователя (не команду) считаем этим
// вопросом и включаем его в уведомление менеджеру. Состояние - только в
// памяти процесса (не переживает перезапуск бота) - это нормально, это
// короткий диалог в рамках одной сессии, а не долгоживущий прогресс.
const awaitingQuestion = new Map();

// Сообщения-заявки в чате менеджеров: mid -> { chatId клиента }. По ней бот понимает,
// кому переслать ответ, когда менеджер отвечает через "Ответить" (см. message_created
// ниже). В памяти процесса, ограничено по размеру - это не долгоживущее хранилище,
// а способ связать вопрос с ответом в рамках одной сессии.
// Сохраняем на диск (data/manager-routes.json): иначе после перезапуска pm2 менеджер
// не сможет ответить клиентам по старым заявкам, а диалог должен переживать перезапуск.
function loadManagerRoutes() {
  try {
    return new Map(JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf8')));
  } catch (_) {
    return new Map();
  }
}
const managerMessageRoutes = loadManagerRoutes();
const MAX_MANAGER_ROUTES = 500;
function rememberManagerRoute(mid, route) {
  if (!mid) return;
  if (managerMessageRoutes.size >= MAX_MANAGER_ROUTES) {
    managerMessageRoutes.delete(managerMessageRoutes.keys().next().value);
  }
  managerMessageRoutes.set(mid, route);
  fs.writeFile(ROUTES_FILE, JSON.stringify([...managerMessageRoutes]), () => {});
}

const PICK_PROMPT =
  'Напишите одним сообщением: марку, модель и год выпуска авто (лучше VIN) и что нужно подобрать — ' +
  'я перешлю менеджеру.';

// Просьба поделиться телефоном - только в сценарии "Застрял" (кнопка "Всё ещё не
// получается — позвать менеджера" после ❌ на инструкции, см. bot.action(/^mgr\|.../)
// ниже). Для обычных вопросов через меню ("Просто вопрос менеджеру", подбор запчасти)
// телефон не спрашиваем - это осознанный выбор владельца бота: не создавать лишнее
// трение там, где человек просто хочет что-то узнать (например, цену).
const PHONE_STUCK_PROMPT =
  '🙋 Понял, зову менеджера! Если оставите номер — он сможет перезвонить сразу, это быстрее. ' +
  'Без номера тоже поможем: просто опишите вопрос одним сообщением.';

async function askForQuestion(ctx, stepId, reason, prompt, opts) {
  const wantsPhone = !!(opts && opts.wantsPhone);
  awaitingQuestion.set(ctx.chatId, { stepId, reason, wantsPhone, phone: null });
  logEvent(ctx, 'manager_request', { stepId });
  if (wantsPhone) {
    await ctx.reply(prompt || PHONE_STUCK_PROMPT, {
      attachments: [Keyboard.inlineKeyboard([[Keyboard.button.requestContact('📞 Отправить номер')]])],
    });
  } else {
    await ctx.reply(prompt || 'Напишите ваш вопрос одним сообщением - я перешлю его менеджеру.');
  }
}

// Пересылает менеджеру всё, что прислал клиент: текст (он попадает в заявку) и вложения
// (фото, файлы, голосовые, контакт) - вложение пересылаем отдельным сообщением под заявкой
// (link type "forward"). Обе связки "сообщение в чате менеджеров -> клиент" запоминаем.
async function relayToManager(ctx, { stepId, reason, phone }) {
  const body = (ctx.message && ctx.message.body) || {};
  const text = body.text ? body.text.trim() : '';
  const hasAttachments = !!(body.attachments && body.attachments.length);
  const { ok, messageId } = await notifyManager(ctx, stepId, reason, text || null, phone);
  if (!ok) return false;
  rememberManagerRoute(messageId, { chatId: ctx.chatId });
  // Вложение пересылаем всегда, даже если к нему есть текст: текст уйдёт и в заявке, и в пересылке.
  if (hasAttachments && MANAGER_CHAT_ID && body.mid) {
    try {
      const forwarded = await bot.api.sendMessageToChat(Number(MANAGER_CHAT_ID), undefined, {
        link: { type: 'forward', mid: body.mid },
      });
      if (forwarded && forwarded.body) rememberManagerRoute(forwarded.body.mid, { chatId: ctx.chatId });
    } catch (err) {
      console.error('Не удалось переслать вложение менеджеру:', err.message);
    }
  }
  return true;
}

// Ответ на вопрос, который бот сам спрашивал после "Позвать менеджера".
async function sendQuestionToManager(ctx, pending) {
  awaitingQuestion.delete(ctx.chatId);
  const ok = await relayToManager(ctx, { stepId: pending.stepId, reason: pending.reason, phone: pending.phone });
  const hasText = !!(ctx.message && ctx.message.body && ctx.message.body.text);
  logEvent(ctx, 'manager_question', { stepId: pending.stepId, delivered: ok, kind: hasText ? 'text' : 'media', hasPhone: !!pending.phone });
  await ctx.reply(
    ok
      ? 'Передал ваш вопрос менеджеру, с вами скоро свяжутся здесь же, в MAX или по телефону.'
      : `Не получилось передать вопрос менеджеру автоматически.\n${fallbackContactText()}`
  );
}

// Любое сообщение клиента вне ожидания вопроса - продолжение диалога: уходит менеджеру,
// ответ менеджера придёт обратно в этот же чат.
async function relayClientDialog(ctx) {
  const ok = await relayToManager(ctx, { stepId: null, reason: 'Клиент написал в чат бота' });
  const hasText = !!(ctx.message && ctx.message.body && ctx.message.body.text);
  logEvent(ctx, 'client_message', { delivered: ok, kind: hasText ? 'text' : 'media' });
  await ctx.reply(
    ok
      ? 'Передал менеджеру, ответим здесь же, в MAX.'
      : `Не получилось передать сообщение менеджеру автоматически.\n${fallbackContactText()}`
  );
}

function fallbackContactText() {
  return (
    `Пока связывайтесь напрямую:\n` +
    `📞 ${COMPANY_PHONE}\n` +
    `📞 ${COMPANY_PHONE_2}\n` +
    `✉️ ${COMPANY_EMAIL}`
  );
}

// ---------- Команды ----------
// 'bot_started' срабатывает, когда пользователь впервые открывает чат с ботом
// (аналог /start в Telegram, но происходит автоматически) - дублируем той же
// логикой, что и команду /start, на случай если пользователь всё равно её наберёт.

// Параметр из ссылки https://max.ru/<бот>?start=registered приходит в ctx.startPayload -
// так клиент, только что зарегистрировавшийся на сайте, получает приветствие с
// предложением помощи вместо обычного стартового вопроса.
const REGISTERED_PAYLOAD = 'registered';

bot.on('bot_started', async (ctx) => {
  const payload = ctx.startPayload || null;
  logEvent(ctx, 'start', { via: 'bot_started', payload });
  await sendStep(ctx, payload === REGISTERED_PAYLOAD ? 'welcome_registered' : START_STEP);
});

// Срабатывает автоматически, когда бота добавляют в групповой чат - удобный
// способ узнать chat_id этого чата для MANAGER_CHAT_ID (см. README): просто
// добавьте бота в чат, он сам пришлёт туда своё ID.
bot.on('bot_added', async (ctx) => {
  await ctx.reply(`Бот добавлен в этот чат. ID чата для MANAGER_CHAT_ID: ${ctx.chatId}`);
});

bot.command('start', async (ctx) => {
  // Если у человека уже есть диалог с ботом, ссылка со start-параметром может прийти
  // обычным сообщением "/start registered" - обрабатываем и такой вариант.
  const text = ctx.message && ctx.message.body ? ctx.message.body.text || '' : '';
  const payload = /^\/start\s+registered\b/i.test(text) ? REGISTERED_PAYLOAD : null;
  logEvent(ctx, 'start', { via: 'command', payload });
  await sendStep(ctx, payload ? 'welcome_registered' : START_STEP);
});

bot.command('order', async (ctx) => {
  logEvent(ctx, 'order_command');
  // Быстрый переход сразу к оформлению заказа для тех, у кого уже есть аккаунт.
  await sendStep(ctx, 'order_login');
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    'Я провожу вас шаг за шагом через регистрацию и оформление заказа на komandir-nn.ru.\n\n' +
      '/start — начать сначала\n' +
      '/order — сразу перейти к оформлению заказа (если аккаунт уже есть)\n\n' +
      fallbackContactText()
  );
});

// ---------- Обработка кнопок ----------
// ctx.answerOnCallback(...) убирает "часики" на кнопке (аналог Telegram
// ctx.answerCbQuery()) - сообщение при этом НЕ редактируется, шаг отправляется
// отдельным новым сообщением через ctx.reply(), как и в Telegram-версии.
//
// ВАЖНО (реальный баг, найденный на живом боте): вызов с пустым объектом
// ctx.answerOnCallback({}) у реального API MAX падает с ошибкой "400: Invalid
// request. `message` or `notification` required" - несмотря на то, что поле
// message в типах SDK помечено необязательным. Поскольку это было НЕ обёрнуто
// в try/catch, ошибка обрывала весь обработчик кнопки до того, как он успевал
// сделать что-то ещё (например уведомить менеджера) - то есть НИ ОДНА кнопка
// в боте реально не работала. safeAnswerCallback проглатывает такую ошибку -
// сама по себе она не критична (в худшем случае "часики" на кнопке останутся
// на секунду дольше), а вот прерывать из-за неё остальную логику нельзя.
async function safeAnswerCallback(ctx) {
  try {
    await ctx.answerOnCallback({});
  } catch (err) {
    console.error('answerOnCallback не удался (не критично, продолжаем):', err.message);
  }
}

bot.action(/^ok\|(.+)$/, async (ctx) => {
  const stepId = ctx.match[1];
  const step = STEPS[stepId];
  await safeAnswerCallback(ctx);
  if (!step) return;
  logEvent(ctx, 'ok', { stepId });
  await sendStep(ctx, step.next);
});

bot.action(/^fail\|(.+)$/, async (ctx) => {
  const stepId = ctx.match[1];
  const step = STEPS[stepId];
  await safeAnswerCallback(ctx);
  if (!step) return;
  logStuck(ctx, stepId);
  logEvent(ctx, 'fail', { stepId });
  const tipText = step.tip ? `💡 ${step.tip}` : 'Попробуйте ещё раз или позовите менеджера.';
  await ctx.reply(tipText, { attachments: [buildFailKeyboard(stepId, step)] });
});

bot.action(/^go\|([^|]+)\|.+$/, async (ctx) => {
  const nextId = ctx.match[1];
  await safeAnswerCallback(ctx);
  logEvent(ctx, 'choice', { to: nextId });
  if (nextId === '__manager__') {
    await askForQuestion(ctx, null, 'Пользователь запросил помощь менеджера');
    return;
  }
  if (nextId === '__manager_pick__') {
    // Тот же путь до менеджера (MANAGER_CHAT_ID), что и у «Вопрос менеджеру», но с другим
    // текстом просьбы и пометкой в заявке.
    await askForQuestion(ctx, 'welcome_registered', 'Клиент после регистрации просит помощь с подбором запчасти', PICK_PROMPT);
    return;
  }
  await sendStep(ctx, nextId);
});

bot.action(/^mgr\|(.*)$/, async (ctx) => {
  const stepId = ctx.match[1] || null;
  await safeAnswerCallback(ctx);
  await askForQuestion(ctx, stepId, 'Пользователь застрял и просит помощи менеджера', null, { wantsPhone: true });
});

// Перехватываем следующее сообщение пользователя, если только что спросили его
// вопрос менеджеру (см. askForQuestion выше). Команды (текст, начинающийся с "/")
// пропускаем как есть - next() отдаёт их дальше по цепочке обработчиков bot.command(...).
//
// Первая ветка ниже: ответ менеджера клиенту. Менеджер отвечает через "Ответить" прямо
// на пересланное боту сообщение-заявку в чате менеджеров (см. notifyManager) - это и
// есть решение проблемы "не могу найти клиента по id в MAX": искать никого не нужно,
// бот сам знает chatId клиента по mid заявки. Работает только для группового чата
// менеджеров (MANAGER_CHAT_ID), не для личного диалога с одним менеджером.
// Ответ менеджера клиенту. Менеджер отвечает через "Ответить" на пересланную боту заявку
// или вложение в чате менеджеров (см. relayToManager) - бот по mid сам знает клиента.
// Текст уходит текстом, фото/файлы - пересылкой. Обычные сообщения в группе бот не трогает.
async function handleManagerChatMessage(ctx) {
  const link = ctx.message && ctx.message.link;
  const route = link && link.type === 'reply' ? managerMessageRoutes.get(link.message.mid) : null;
  if (!route) return;
  const body = ctx.message.body || {};
  const replyText = body.text ? body.text.trim() : '';
  const hasAttachments = !!(body.attachments && body.attachments.length);
  try {
    // С вложением пересылаем сообщение целиком (вместе с его текстом), иначе только текст.
    if (hasAttachments) {
      await bot.api.sendMessageToChat(route.chatId, undefined, { link: { type: 'forward', mid: body.mid } });
    } else {
      await bot.api.sendMessageToChat(route.chatId, replyText);
    }
    await ctx.reply('✅ Отправлено клиенту.');
    logEvent(ctx, 'manager_reply', { customerChatId: route.chatId, kind: replyText ? 'text' : 'media' });
  } catch (err) {
    console.error('Не удалось переслать ответ клиенту:', err.message);
    await ctx.reply(`⚠️ Не удалось отправить клиенту. Ошибка: ${err.message}`);
  }
}

// Все остальные сообщения клиентов (текст, фото, файлы, голосовые...). Команды обработаны
// выше, сюда попадают обычные сообщения.
bot.on('message_created', async (ctx) => {
  if (MANAGER_CHAT_ID && ctx.chatId === Number(MANAGER_CHAT_ID)) {
    return handleManagerChatMessage(ctx);
  }

  const pending = awaitingQuestion.get(ctx.chatId);

  // Клиент поделился телефоном через кнопку (см. askForQuestion/PHONE_STUCK_PROMPT):
  // приходит не текстом, а вложением "контакт".
  if (pending && pending.wantsPhone && !pending.phone) {
    const attachments = (ctx.message && ctx.message.body && ctx.message.body.attachments) || [];
    const contact = attachments.find((a) => a.type === 'contact');
    if (contact) {
      pending.phone = parsePhoneFromVcf(contact.payload && contact.payload.vcf_info) || 'указан, не распознан';
      logEvent(ctx, 'manager_phone_shared', { stepId: pending.stepId });
      await ctx.reply('Спасибо! Теперь опишите ваш вопрос одним сообщением — и я передам его менеджеру.');
      return;
    }
  }

  if (pending) return sendQuestionToManager(ctx, pending);
  return relayClientDialog(ctx);
});

// ---------- Обработка ошибок ----------
// ВАЖНО: без этого одна неудачная попытка API (например кратковременный сбой
// сети на answerOnCallback/reply) могла бы уронить обработку апдейта без
// понятного следа в логах. Реальный похожий случай уже был у Telegram-версии
// этого бота (см. src/bot.js в komandir-telegram-bot) - там из-за отсутствия
// аналога этой обвязки одна такая ошибка на 60 секунд останавливала ВЕСЬ
// polling для всех пользователей сразу, пока не сработал внешний retry.
bot.catch((err, ctx) => {
  console.error(`Ошибка при обработке апдейта (${ctx ? ctx.updateType : '?'}):`, err && err.message ? err.message : err);
});

// ---------- Запуск ----------
// ВАЖНО (реально найдено при отладке на живом боте): bot.start({mode:'polling'})
// в этом SDK устроен как Telegraf'овский launch() - его promise резолвится
// ТОЛЬКО когда polling ОСТАНОВЛЕН (ошибкой или явно), а не в момент успешного
// подключения. Раньше здесь лежал console.log("подключён") СРАЗУ после
// await bot.start(...) - он физически не мог напечататься, пока бот жив и
// нормально работает, из-за чего 20+ минут полной тишины в логе выглядели
// как зависание, хотя бот всё это время исправно отвечал. Поэтому момент
// подключения теперь логируется через отдельный вызов bot.api.getMyInfo()
// ДО bot.start() - он не блокируется на весь polling и возвращается сразу
// после реальной проверки связи. options.retry у SDK тоже выключен (см. ниже
// про его собственную "тихую" причину) - весь цикл повторов свой, видимый.
//
// options.retry: true у SDK есть встроенный повтор при сбоях ВНУТРИ polling,
// но он тоже ничего не логирует - поэтому используем retry: false и всегда
// переподключаемся через свой видимый цикл, даже если bot.start() однажды
// вернулся (значит polling по какой-то причине остановился - это ненормально
// при нормальной работе, и достойно попытки переподключиться, а не выхода
// из процесса).
const RECONNECT_DELAY_MS = 60000;
// ВАЖНО (реально найдено на живом боте): бывает, что TCP-соединение до
// platform-api2.max.ru технически устанавливается, но дальше зависает без
// ответа - обычный connect-таймаут fetch'а (10 сек) это НЕ ловит, потому что
// само соединение уже открыто, просто данные не идут. Без явного таймаута
// getMyInfo() в таком случае мог виснуть на много минут, и весь цикл
// переподключения замирал вместе с ним. GET_MY_INFO_TIMEOUT_MS - защита
// именно от этого случая.
const GET_MY_INFO_TIMEOUT_MS = 15000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: таймаут ${ms / 1000} сек`)), ms)),
  ]);
}

async function startWithRetry() {
  for (;;) {
    try {
      const info = await withTimeout(bot.api.getMyInfo(), GET_MY_INFO_TIMEOUT_MS, 'getMyInfo');
      console.log(`Бот @${info.username} подключён к MAX, запускаю long polling...`);
      await bot.start({ mode: 'polling', options: { retry: false } });
      console.log('Polling MAX неожиданно остановился - переподключаюсь...');
    } catch (err) {
      console.error(`Не удалось подключиться к MAX: ${err.message}.`);
    }
    console.log(`Повтор через ${RECONNECT_DELAY_MS / 1000} сек...`);
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
  }
}

startWithRetry();

process.once('SIGINT', () => bot.stopPolling());
process.once('SIGTERM', () => bot.stopPolling());
