#!/usr/bin/env node
'use strict';
/**
 * Разовая отправка сообщения клиенту по его Telegram chat_id - когда бот ещё не умел
 * (или не успел, из-за перезапуска) связать вопрос с ответом автоматически через
 * "Ответить" в чате менеджеров (см. src/bot.js, комментарий "Ответ менеджера клиенту").
 *
 * chat_id берите из сообщения-заявки, которое бот прислал в чат менеджеров, например:
 *   "Пользователь: Иван (id 123456789)"  ->  chat_id = 123456789
 * (в личном чате с ботом id пользователя Telegram совпадает с chat_id).
 *
 * Запуск (из этой папки):
 *   node reply-to-client.js 123456789 "Текст ответа"
 */
require('dotenv').config();
const { Telegraf } = require('telegraf');

const [, , chatIdArg, ...textParts] = process.argv;
const text = textParts.join(' ').trim();

if (!chatIdArg || !text) {
  console.error('Использование: node reply-to-client.js <chat_id> "текст ответа"');
  process.exit(1);
}
const chatId = Number(chatIdArg);
if (!Number.isFinite(chatId)) {
  console.error(`chat_id должен быть числом, получено: "${chatIdArg}"`);
  process.exit(1);
}
if (!process.env.BOT_TOKEN) {
  console.error('Не задан BOT_TOKEN (проверьте .env рядом со скриптом).');
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.telegram
  .sendMessage(chatId, text)
  .then(() => {
    console.log(`Готово: сообщение отправлено в чат ${chatId}.`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(
      `Не удалось отправить (chat_id ${chatId}): ${err.message}\n` +
        'Возможная причина: пользователь заблокировал бота или никогда не писал ему.'
    );
    process.exit(1);
  });
