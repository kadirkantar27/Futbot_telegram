const TelegramBot = require('node-telegram-bot-api');

console.log("Kütüphane Tipi:", typeof TelegramBot);

const bot = new TelegramBot('SAHTE_TOKEN_123', { polling: false });

console.log("✅ Constructor başarıyla çalıştı!");