// Конфиг pm2 для этого бота. Нужен в первую очередь из-за переменной
// NODE_EXTRA_CA_CERTS: MAX (max.ru) использует TLS-сертификаты, выданные
// российским удостоверяющим центром "Russian Trusted Root/Sub CA" (Минцифры) -
// Windows им доверяет (поэтому curl/браузер работают), а Node.js использует
// свой отдельный список доверенных сертификатов (Mozilla), где российского УЦ
// нет - без этой переменной Node падает с UNABLE_TO_GET_ISSUER_CERT_LOCALLY.
// Сертификаты экспортированы из хранилища Windows в russian-trusted-ca.pem
// рядом с этим файлом. Задавать через `pm2 start` разово ненадёжно - демон pm2
// не всегда подхватывает переменные окружения вызывающей сессии, поэтому здесь,
// в конфиге, который pm2 хранит у себя постоянно.
const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "komandir-max-bot",
      script: "src/bot.js",
      cwd: __dirname,
      env: {
        NODE_EXTRA_CA_CERTS: path.join(__dirname, "russian-trusted-ca.pem"),
      },
    },
  ],
};
