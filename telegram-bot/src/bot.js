'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');
const { STEPS, START_STEP } = require('./steps');

const BOT_TOKEN = process.env.BOT_TOKEN;
const MANAGER_CHAT_ID = process.env.MANAGER_CHAT_ID;
const COMPANY_PHONE = process.env.COMPANY_PHONE || '+7 (904) 797-94-20';
const COMPANY_PHONE_2 = process.env.COMPANY_PHONE_2 || '+7 (831) 275-89-49';
const COMPANY_EMAIL = process.env.COMPANY_EMAIL || 'progress@komandir-nn.ru';

if (!BOT_TOKEN) {
  console.error('Не задан BOT_TOKEN. Скопируйте .env.example в .env и укажите токен от @BotFather.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ---------- Простое персистентное состояние (чтобы переживать перезапуск) ----------

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
    chatId: ctx.chat.id,
    username: ctx.from.username || null,
    name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' '),
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
    const from = (ctx && ctx.from) || {};
    const entry = {
      ts: new Date().toISOString(),
      event,
      chatId: ctx && ctx.chat ? ctx.chat.id : null,
      username: from.username || null,
      name: [from.first_name, from.last_name].filter(Boolean).join(' '),
      ...extra,
    };
    fs.appendFile(EVENTS_FILE, JSON.stringify(entry) + '\n', () => {});
  } catch (_) {}
}

// ---------- Вспомогательные функции рендеринга шагов ----------

function buildInstructionKeyboard(stepId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Получилось', `ok|${stepId}`), Markup.button.callback('❌ Не получилось', `fail|${stepId}`)],
  ]);
}

function buildChoiceKeyboard(options) {
  return Markup.inlineKeyboard(options.map((opt, i) => [Markup.button.callback(opt.label, `go|${opt.next}|${i}`)]));
}

function buildFailKeyboard(stepId, step) {
  const rows = [];
  if (step.extraFailOption) {
    rows.push([Markup.button.callback(step.extraFailOption.label, `go|${step.extraFailOption.next}|x`)]);
  }
  rows.push([Markup.button.callback('👉 Понял, идём дальше', `go|${step.next}|c`)]);
  rows.push([Markup.button.callback('🙋 Всё ещё не получается — позвать менеджера', `mgr|${stepId}`)]);
  return Markup.inlineKeyboard(rows);
}

async function sendStep(ctx, stepId) {
  const step = STEPS[stepId];
  if (!step) {
    await ctx.reply('Что-то пошло не так — не нашёл этот шаг. Наберите /start, чтобы начать заново.');
    return;
  }

  setUserStep(ctx.chat.id, stepId);
  logEvent(ctx, 'step', { stepId, stepType: step.type });

  if (step.type === 'choice' || step.type === 'end') {
    await ctx.reply(step.text, buildChoiceKeyboard(step.options));
    return;
  }

  // instruction
  await ctx.reply(step.text, buildInstructionKeyboard(stepId));
}

// Возвращает { ok, messageId } - messageId нужен, чтобы потом узнать ответ менеджера
// (см. "Ответ менеджера клиенту" ниже): менеджер отвечает через "Ответить" прямо на
// это сообщение в чате менеджеров, а бот по messageId понимает, какому клиенту
// переслать текст - без ручного поиска клиента по имени или id.
async function notifyManager(ctx, stepId, reason, question, phone) {
  if (!MANAGER_CHAT_ID) return { ok: false, messageId: null };
  const step = STEPS[stepId];
  const who = ctx.from.username ? '@' + ctx.from.username : `id ${ctx.from.id}`;
  const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');
  const text =
    `🙋 ${reason}\n` +
    `Пользователь: ${name} (${who})\n` +
    (phone ? `📞 ${phone}\n` : '') +
    (step ? `Шаг: ${step.title || stepId}\n` : '') +
    (question ? `Вопрос: ${question}\n` : '') +
    (step ? `Текст шага: ${step.text}\n` : '') +
    `↩️ Чтобы ответить клиенту — используйте «Ответить» на это сообщение.`;
  try {
    const sent = await ctx.telegram.sendMessage(MANAGER_CHAT_ID, text);
    return { ok: true, messageId: sent.message_id };
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

// Сообщения-заявки в чате менеджеров: message_id -> { chatId клиента }. По ней бот
// понимает, кому переслать ответ, когда менеджер отвечает через "Ответить" (см. ниже,
// обработчик bot.on('text', ...)). В памяти процесса, ограничено по размеру - это
// не долгоживущее хранилище, а способ связать вопрос с ответом в рамках одной сессии.
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
function rememberManagerRoute(messageId, route) {
  if (!messageId) return;
  if (managerMessageRoutes.size >= MAX_MANAGER_ROUTES) {
    managerMessageRoutes.delete(managerMessageRoutes.keys().next().value);
  }
  managerMessageRoutes.set(messageId, route);
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
  awaitingQuestion.set(ctx.chat.id, { stepId, reason, wantsPhone, phone: null });
  logEvent(ctx, 'manager_request', { stepId });
  if (wantsPhone) {
    await ctx.reply(
      prompt || PHONE_STUCK_PROMPT,
      Markup.keyboard([Markup.button.contactRequest('📞 Отправить номер')]).resize().oneTime()
    );
  } else {
    await ctx.reply(prompt || 'Напишите ваш вопрос одним сообщением - я перешлю его менеджеру.');
  }
}

// Пересылает менеджеру всё, что прислал клиент: текст (он попадает в заявку) и вложения
// (фото, файлы, голосовые, контакт) - вложение копируем отдельным сообщением под заявкой.
// Обе связки "сообщение в чате менеджеров -> клиент" запоминаем, чтобы ответ на любое из них
// ушёл клиенту.
async function relayToManager(ctx, { stepId, reason, phone }) {
  const msg = ctx.message;
  const question = (msg.text || msg.caption || '').trim() || null;
  const { ok, messageId } = await notifyManager(ctx, stepId, reason, question, phone);
  if (!ok) return false;
  rememberManagerRoute(messageId, { chatId: ctx.chat.id });
  if (!msg.text) {
    try {
      const copied = await ctx.telegram.copyMessage(MANAGER_CHAT_ID, ctx.chat.id, msg.message_id);
      rememberManagerRoute(copied.message_id, { chatId: ctx.chat.id });
    } catch (err) {
      console.error('Не удалось переслать вложение менеджеру:', err.message);
    }
  }
  return true;
}

// Ответ на вопрос, который бот сам спрашивал после "Позвать менеджера".
async function sendQuestionToManager(ctx, pending) {
  awaitingQuestion.delete(ctx.chat.id);
  const ok = await relayToManager(ctx, { stepId: pending.stepId, reason: pending.reason, phone: pending.phone });
  logEvent(ctx, 'manager_question', { stepId: pending.stepId, delivered: ok, kind: ctx.message.text ? 'text' : 'media', hasPhone: !!pending.phone });
  const replyText = ok
    ? 'Передал ваш вопрос менеджеру, с вами скоро свяжутся здесь же, в Telegram или по телефону.'
    : `Не получилось передать вопрос менеджеру автоматически.\n${fallbackContactText()}`;
  // Если до этого показывали клавиатуру "Отправить номер" - убираем её вместе с ответом.
  await ctx.reply(replyText, pending.wantsPhone ? Markup.removeKeyboard() : undefined);
}

// Любое сообщение клиента вне ожидания вопроса - это продолжение диалога: уходит менеджеру,
// ответ менеджера придёт обратно в этот же чат.
async function relayClientDialog(ctx) {
  const ok = await relayToManager(ctx, { stepId: null, reason: 'Клиент написал в чат бота' });
  logEvent(ctx, 'client_message', { delivered: ok, kind: ctx.message.text ? 'text' : 'media' });
  await ctx.reply(
    ok
      ? 'Передал менеджеру, ответим здесь же, в Telegram.'
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

// Параметр из ссылки https://t.me/<бот>?start=registered Telegraf кладёт в
// ctx.startPayload - так клиент, только что зарегистрировавшийся на сайте, получает
// приветствие с предложением помощи вместо обычного стартового вопроса.
const REGISTERED_PAYLOAD = 'registered';

bot.start(async (ctx) => {
  const payload = ctx.startPayload || null;
  logEvent(ctx, 'start', { payload });
  await sendStep(ctx, payload === REGISTERED_PAYLOAD ? 'welcome_registered' : START_STEP);
});

bot.command('order', async (ctx) => {
  logEvent(ctx, 'order_command');
  // Быстрый переход сразу к оформлению заказа для тех, у кого уже есть аккаунт.
  await sendStep(ctx, 'order_login');
});

bot.help(async (ctx) => {
  await ctx.reply(
    'Я провожу вас шаг за шагом через регистрацию и оформление заказа на komandir-nn.ru.\n\n' +
      '/start — начать сначала\n' +
      '/order — сразу перейти к оформлению заказа (если аккаунт уже есть)\n\n' +
      fallbackContactText()
  );
});

// ---------- Обработка кнопок ----------

bot.action(/^ok\|(.+)$/, async (ctx) => {
  const stepId = ctx.match[1];
  const step = STEPS[stepId];
  await ctx.answerCbQuery();
  if (!step) return;
  logEvent(ctx, 'ok', { stepId });
  await sendStep(ctx, step.next);
});

bot.action(/^fail\|(.+)$/, async (ctx) => {
  const stepId = ctx.match[1];
  const step = STEPS[stepId];
  await ctx.answerCbQuery();
  if (!step) return;
  logStuck(ctx, stepId);
  logEvent(ctx, 'fail', { stepId });
  const tipText = step.tip ? `💡 ${step.tip}` : 'Попробуйте ещё раз или позовите менеджера.';
  await ctx.reply(tipText, buildFailKeyboard(stepId, step));
});

bot.action(/^go\|([^|]+)\|.+$/, async (ctx) => {
  const nextId = ctx.match[1];
  await ctx.answerCbQuery();
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
  await ctx.answerCbQuery();
  await askForQuestion(ctx, stepId, 'Пользователь застрял и просит помощи менеджера', null, { wantsPhone: true });
});

// Клиент поделился телефоном через кнопку (см. askForQuestion/PHONE_STUCK_PROMPT).
// Если в этот момент его не ждали (pending нет) или уже не просили телефон - просто
// пропускаем дальше, ничего не ломаем.
bot.on('contact', async (ctx, next) => {
  const pending = awaitingQuestion.get(ctx.chat.id);
  if (!pending || !pending.wantsPhone || pending.phone) return next();
  pending.phone = ctx.message.contact.phone_number;
  logEvent(ctx, 'manager_phone_shared', { stepId: pending.stepId });
  await ctx.reply('Спасибо! Теперь опишите ваш вопрос одним сообщением — и я передам его менеджеру.', Markup.removeKeyboard());
});

// Ответ менеджера клиенту. Менеджер отвечает через "Ответить" прямо на пересланную боту
// заявку или вложение в чате менеджеров (см. relayToManager) - бот по messageId сам знает
// chatId клиента, искать его никому не нужно. Текст уходит как текст, фото/файлы - копией.
// Обычные сообщения внутри группы менеджеров (без "Ответить" на заявку) бот не трогает.
async function handleManagerChatMessage(ctx) {
  const replyTo = ctx.message.reply_to_message;
  const route = replyTo && managerMessageRoutes.get(replyTo.message_id);
  if (!route) return;
  try {
    if (ctx.message.text) {
      await ctx.telegram.sendMessage(route.chatId, ctx.message.text);
    } else {
      await ctx.telegram.copyMessage(route.chatId, ctx.chat.id, ctx.message.message_id);
    }
    await ctx.reply('✅ Отправлено клиенту.');
    logEvent(ctx, 'manager_reply', { customerChatId: route.chatId, kind: ctx.message.text ? 'text' : 'media' });
  } catch (err) {
    console.error('Не удалось переслать ответ клиенту:', err.message);
    await ctx.reply(`⚠️ Не удалось отправить клиенту (возможно, заблокировал бота). Ошибка: ${err.message}`);
  }
}

// Все сообщения клиентов (текст, фото, файлы, голосовые, стикеры...), которые не обработаны
// командами, кнопками и ожиданием телефона выше. Команды уже отработали раньше, сюда попадают
// только обычные сообщения.
bot.on('message', async (ctx) => {
  if (MANAGER_CHAT_ID && String(ctx.chat.id) === String(MANAGER_CHAT_ID)) {
    return handleManagerChatMessage(ctx);
  }
  const pending = awaitingQuestion.get(ctx.chat.id);
  if (pending) return sendQuestionToManager(ctx, pending);
  return relayClientDialog(ctx);
});

// ---------- Запуск ----------

// launch() резолвится только когда бот ОСТАНОВЛЕН (внутри он ждёт цикл поллинга),
// поэтому статус "запущен" логируем через onLaunch-колбэк, который вызывается
// сразу после успешного подключения к Telegram (getMe), до начала поллинга.
//
// ВАЖНО: если само подключение (getMe) не удалось (например, сеть/VPN
// моргнули на момент старта - ETIMEDOUT и т.п.), launch() просто падает с
// ошибкой один раз и дальше ничего не делает - без этой обвязки бот молча
// зависает "живым" процессом, который на самом деле не подключён к Telegram
// (реальный случай, который уже был). Поэтому оборачиваем в повтор с
// задержкой: если подключиться не удалось - пробуем снова, пока не получится.
// Само основное соединение polling'а (после успешного launch) telegraf уже
// умеет переподключать самостоятельно - эта обвязка нужна только для сбоя
// на самом первом подключении.
const RECONNECT_DELAY_MS = 60000;

async function startWithRetry() {
  for (;;) {
    try {
      await bot.launch({}, () => {
        console.log(`Бот @${bot.botInfo.username} запущен (long polling). Нажмите Ctrl+C для остановки.`);
      });
      // Сюда доходим только при штатной остановке (SIGINT/SIGTERM) - выходим из цикла.
      break;
    } catch (err) {
      console.error(
        `Не удалось подключиться к Telegram: ${err.message}. Повтор через ${RECONNECT_DELAY_MS / 1000} сек...`
      );
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
    }
  }
}

startWithRetry();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
