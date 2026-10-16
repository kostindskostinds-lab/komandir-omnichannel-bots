#!/usr/bin/env node
'use strict';
/**
 * Разовая отправка сообщения клиенту по его MAX user_id - когда бот ещё не умел (или
 * не успел, из-за перезапуска) связать вопрос с ответом автоматически через "Ответить"
 * в чате менеджеров (см. src/bot.js, комментарий "Ответ менеджера клиенту"). Не требует
 * искать пользователя в MAX - именно этого штатными средствами MAX сделать нельзя,
 * зато бот может писать напрямую по user_id, если человек уже открывал с ним чат.
 *
 * user_id берите из сообщения-заявки, которое бот прислал в чат менеджеров, например:
 *   "Пользователь: Иван (id 123456789)"  ->  user_id = 123456789
 *
 * Запуск (из этой папки; нужен сертификат Минцифры, как и у самого бота):
 *   NODE_EXTRA_CA_CERTS="%cd%\russian-trusted-ca.pem" node reply-to-client.js 123456789 "Текст ответа"
 * В PowerShell:
 *   $env:NODE_EXTRA_CA_CERTS = "$PWD\russian-trusted-ca.pem"; node reply-to-client.js 123456789 "Текст ответа"
 */
require('dotenv').config();
const { Bot } = require('@maxhub/max-bot-api');

const [, , userIdArg, ...textParts] = process.argv;
const text = textParts.join(' ').trim();

if (!userIdArg || !text) {
  console.error('Использование: node reply-to-client.js <user_id> "текст ответа"');
  process.exit(1);
}
const userId = Number(userIdArg);
if (!Number.isFinite(userId)) {
  console.error(`user_id должен быть числом, получено: "${userIdArg}"`);
  process.exit(1);
}
if (!process.env.BOT_TOKEN) {
  console.error('Не задан BOT_TOKEN (проверьте .env рядом со скриптом).');
  process.exit(1);
}

const bot = new Bot(process.env.BOT_TOKEN);

bot.api
  .sendMessageToUser(userId, text)
  .then(() => {
    console.log(`Готово: сообщение отправлено пользователю id ${userId}.`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(
      `Не удалось отправить (id ${userId}): ${err.message}\n` +
        'Возможные причины: пользователь никогда не открывал чат с ботом, либо не установлен NODE_EXTRA_CA_CERTS.'
    );
    process.exit(1);
  });
