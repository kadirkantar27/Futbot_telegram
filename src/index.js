require('dotenv').config(); 
const telegramBotApi = require('node-telegram-bot-api');
const TelegramBot = telegramBotApi.default || telegramBotApi; // Hem ESM hem CommonJS için çalışmasını garanti eder
const gameService = require('./services/gameService');
const db = require('./database/db');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const cron = require('node-cron');

// Token'ı .env dosyasından alıyoruz
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

console.log("Futbol Kart Botu aktif edildi ve dinlemede...");

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const text = `⚽ **FUT - Rüya Takım Botuna Hoş Geldin!** ⚽

    📌 **Komutlar:**
    /kartcek - 3 saatte beş rastgele kart kazan
    /kadrokur - En iyi 5'li kadronu otomatik kur
    /mac - Grupta meydan okuma başlat
    /puanim - Ligdeki puanını gör
    /kartlarim - Sahip olduğun kartları gör
    /top10 - Global liderlik tablosu (Güncel Hafta)
    /gecenhafta - Geçen haftanın şampiyonları

⚠️ **ÖNEMLİ:** Her Pazar gecesi saat 00:00'da sezon sıfırlanır, tüm kartlar silinir ve liderlik yarışı herkes için sıfırdan başlar! Yeni sezonda başarılar! 🏆`;

    bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
});

bot.onText(/\/kartcek/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.first_name || "Oyuncu";

    const result = await gameService.drawCard(userId, username);
    bot.sendMessage(chatId, result.message, { parse_mode: "Markdown" });
});

bot.onText(/\/kartlarim/, async (msg) => {
    const userId = msg.from.id;
    
    // gameService'den 1. sayfayı istiyoruz
    const result = await gameService.getUserInventory(userId, 1);
    
    if (!result.success) {
        return bot.sendMessage(msg.chat.id, result.message, { parse_mode: "Markdown" });
    }

    // Butonları oluşturma mantığı
    const inlineKeyboard = [];
    if (result.totalPages > 1) {
        // İleri butonu ekliyoruz. callback_data içine kimin envanteri olduğu ve gidilecek sayfayı yazıyoruz.
        inlineKeyboard.push([{ text: "Sonraki ➡️", callback_data: `inv_${result.targetUserId}_2` }]);
    }

    bot.sendMessage(msg.chat.id, result.message, {
        parse_mode: "Markdown",
        reply_markup: inlineKeyboard.length > 0 ? { inline_keyboard: inlineKeyboard } : undefined
    });
});

bot.onText(/\/kadrokur/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const message = await gameService.buildUniqueSquad(userId);
    bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
});

bot.onText(/\/top10/, async (msg) => {
    const chatId = msg.chat.id;
    
    const result = await gameService.getTop10();
    bot.sendMessage(chatId, result, { parse_mode: "Markdown" });
});

bot.onText(/\/puanim/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const user = await db.get("SELECT points FROM users WHERE user_id = ?", [userId]);
    const points = user ? user.points : 0;
    
    bot.sendMessage(chatId, `📊 Toplam Puanın: **${points}**`, { parse_mode: "Markdown" });
});

// GÜNCEL MAÇ KOMUTU (Meydan Okuma Butonu)
bot.onText(/\/mac/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.first_name;

    // Önce meydan okuyan kişinin kurulu bir kadrosu var mı kontrol edelim
    const squad = await db.all("SELECT id FROM inventory WHERE user_id = ? AND in_squad = 1", [userId]);
    if (squad.length < 5) {
        return bot.sendMessage(chatId, "❌ Sahaya çıkmak için önce `/kadrokur` komutuyla 5'li kadronu kurmalısın!", { parse_mode: "Markdown" });
    }

    const options = {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [{ text: "⚔️ Maçı Kabul Et!", callback_data: `mac_${userId}_${username}` }]
            ]
        }
    };

    bot.sendMessage(chatId, `🏟 **${username}** sahaya çıktı ve kendine rakip arıyor!\n\nMaçı kabul etmek için aşağıdaki butona tıkla!`, options);
});

// KULLANICI KOMUTU: Geçen Haftanın Şampiyonları
bot.onText(/\/gecenhafta/, async (msg) => {
    const chatId = msg.chat.id;

    try {
        // Hata vermemesi için tablonun varlığını garantiye alalım
        await db.run("CREATE TABLE IF NOT EXISTS gecen_hafta (user_id TEXT, toplam_guc INTEGER)");

        // Geçen haftanın verilerini çek
        const eskiTop10 = await db.all("SELECT user_id, toplam_guc FROM gecen_hafta ORDER BY toplam_guc DESC");

        // Eğer tablo boşsa (henüz hiç pazar gecesi geçmediyse)
        if (eskiTop10.length === 0) {
            return bot.sendMessage(chatId, "🤷‍♂️ Henüz tamamlanmış bir hafta yok. İlk şampiyonlar bu Pazar belli olacak!");
        }

        // Liste doluysa mesajı oluştur
        let mesaj = "🏆 **GEÇEN HAFTANIN ŞAMPİYONLARI** 🏆\n\n";
        
        eskiTop10.forEach((user, index) => {
            mesaj += `${index + 1}. [ID: ${user.user_id}] - ${user.toplam_guc} Puan\n`;
        });

        bot.sendMessage(chatId, mesaj, { parse_mode: "Markdown" });

    } catch (err) {
        bot.sendMessage(chatId, "❌ Sonuçlar getirilirken hata oluştu.");
        console.error("Geçen hafta hatası:", err);
    }
});

// GİZLİ ADMİN KOMUTU: Geceyi beklemeden haftayı bitirir
bot.onText(/\/sezonbitir/, async (msg) => {
    const ADMIN_ID = 7365398035; // Kendi ID'ni yaz
    if (msg.from.id !== ADMIN_ID) return;

    try {
        await db.run("CREATE TABLE IF NOT EXISTS gecen_hafta (user_id TEXT, toplam_guc INTEGER)");
        await db.run("DELETE FROM gecen_hafta");
        
        const top10 = await db.all("SELECT user_id, SUM(ovr) as toplam_guc FROM inventory GROUP BY user_id ORDER BY toplam_guc DESC LIMIT 10");
        
        for (const user of top10) {
            await db.run("INSERT INTO gecen_hafta (user_id, toplam_guc) VALUES (?, ?)", [user.user_id, user.toplam_guc]);
        }
        await db.run("DELETE FROM inventory");
        
        bot.sendMessage(msg.chat.id, "✅ Manuel sezon bitirme başarılı! Kartlar sıfırlandı, sonuçlar /gecenhafta komutuna aktarıldı.");
    } catch (err) {
        bot.sendMessage(msg.chat.id, "❌ Hata: " + err.message);
    }
});


// Telegram API hatalarını yut ve botu kapatma
bot.on('polling_error', (error) => {
    console.log("Telegram Bağlantı Dalgalanması:", error.message);
});


// CALLBACK QUERY (Buton Tıklamalarını Yakalama ve Animasyon)
bot.on('callback_query', async (query) => {
    const data = query.data; // Eksik olan tanım buraya eklendi!
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    
    const clickerId = query.from.id;          
    const clickerName = query.from.first_name;

    const dataParts = data.split('_');

    // ==========================================
    // 1. MAÇ SİSTEMİ MANTIĞI
    // ==========================================
    if (dataParts[0] === 'mac') {
        const challengerId = parseInt(dataParts[1]); 
        const challengerName = dataParts[2];

        if (clickerId === challengerId) {
            return bot.answerCallbackQuery(query.id, { text: "Kendi kendine maç yapamazsın!", show_alert: true });
        }

        const clickerSquad = await db.all("SELECT id FROM inventory WHERE user_id = ? AND in_squad = 1", [clickerId]);
        if (clickerSquad.length < 5) {
            return bot.answerCallbackQuery(query.id, { text: "Maçı kabul etmek için önce /kadrokur ile kadronu kurmalısın!", show_alert: true });
        }

        bot.answerCallbackQuery(query.id, { text: "Sahaya iniyorsun! Maç başlıyor... ⚽" });

        // Önce sonucu arka planda hemen hesaplıyoruz
        const matchData = await gameService.simulateLiveMatch(challengerId, challengerName, clickerId, clickerName);

        // --- DİNAMİK ANİMASYON SİSTEMİ ---
        const animationFrames = [];
        let currentScoreA = 0;
        let currentScoreB = 0;

        animationFrames.push(`⏱ **1'** Hakem düdüğü çaldı, dev maç başladı!\n\n**${challengerName}** 0 - 0 **${clickerName}**`);

        for (const event of matchData.matchEvents) {
            if (event.team === "A") currentScoreA++;
            else currentScoreB++;

            animationFrames.push(
                `⚽ **${event.minute}' GOOOLLL!**\n` +
                `${event.teamName} atağında **${event.scorer}** topu ağlara gönderiyor!\n\n` +
                `**${challengerName}** ${currentScoreA} - ${currentScoreB} **${clickerName}**`
            );
        }

        if (matchData.matchEvents.length === 0) {
            animationFrames.push(`⏱ **45'** İlk yarı golsüz tamamlandı.\n\n**${challengerName}** 0 - 0 **${clickerName}**`);
            animationFrames.push(`⏱ **75'** İki takımın da kalecileri devleşti, maçta gol yok.\n\n**${challengerName}** 0 - 0 **${clickerName}**`);
        }

        animationFrames.push(`🏁 **90'** Hakem maçı bitiren düdüğü çalıyor! Sonuçlar hesaplanıyor...`);

        for (const frame of animationFrames) {
            await bot.editMessageText(frame, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: "Markdown"
            });
            await sleep(2000); 
        }

        await bot.editMessageText(matchData.finalMessage, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown"
        });
    }

    // ==========================================
    // 2. ENVANTER SAYFALANDIRMA MANTIĞI
    // ==========================================
    if (data.startsWith("inv_")) {
        // ÇÖZÜM 1: "query is too old" hatasını engellemek için tıklandığı an yanıt veriyoruz.
        // Böylece butondaki saat ikonu (yükleniyor) anında kaybolur.
        bot.answerCallbackQuery(query.id).catch(() => {});

        const parts = data.split("_");
        const targetUserId = parseInt(parts[1]);
        const targetPage = parseInt(parts[2]);

        try {
            const result = await gameService.getUserInventory(targetUserId, targetPage);

            if (result.success) {
                const inlineKeyboard = [];
                const navButtons = [];

                if (result.currentPage > 1) {
                    navButtons.push({ text: "⬅️ Önceki", callback_data: `inv_${result.targetUserId}_${result.currentPage - 1}` });
                }
                if (result.currentPage < result.totalPages) {
                    navButtons.push({ text: "Sonraki ➡️", callback_data: `inv_${result.targetUserId}_${result.currentPage + 1}` });
                }

                if (navButtons.length > 0) {
                    inlineKeyboard.push(navButtons);
                }

                // ÇÖZÜM 2: Mesajı güncellerken "message is not modified" hatası gelirse görmezden gel.
                try {
                    await bot.editMessageText(result.message, {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: "Markdown",
                        reply_markup: { inline_keyboard: inlineKeyboard }
                    });
                } catch (editError) {
                    // Hata "not modified" ise hiçbir şey yapma (çift tıklanmıştır), farklı bir hataysa konsola yaz
                    if (!editError.message.includes("is not modified")) {
                        console.error("Mesaj güncellenirken hata:", editError);
                    }
                }
            }
        } catch (error) {
            console.error("Sayfa değiştirilirken hata:", error);
        }
        
        bot.answerCallbackQuery(query.id).catch(err => console.log(err));
    }
});

// Tüm beklenmeyen hataları yakala ve botun çökmesini engelle
process.on('uncaughtException', (err) => {
    console.error('Ölümcül Hata Yakalandı:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Yakalanmayan Promise Hatası:', reason);
});

// HER PAZAR SAAT 00:00'DA ÇALIŞACAK GİZLİ SIFIRLAMA GÖREVİ
cron.schedule('0 0 * * 0', async () => {
    try {
        console.log("Haftalık sıfırlama işlemi başladı...");

        // 1. Geçmişi tutacağımız tabloyu hazırla (Eğer yoksa otomatik oluşturur)
        await db.run("CREATE TABLE IF NOT EXISTS gecen_hafta (user_id TEXT, toplam_guc INTEGER)");

        // 2. Bir önceki haftanın eski verilerini temizle
        await db.run("DELETE FROM gecen_hafta");

        // 3. Güncel (Biten) haftanın Top 10'unu bul
        const top10 = await db.all(`
            SELECT user_id, SUM(ovr) as toplam_guc 
            FROM inventory 
            GROUP BY user_id 
            ORDER BY toplam_guc DESC 
            LIMIT 10
        `);

        // 4. Yeni Top 10'u "gecen_hafta" tablosuna kaydet
        for (const user of top10) {
            await db.run("INSERT INTO gecen_hafta (user_id, toplam_guc) VALUES (?, ?)", [user.user_id, user.toplam_guc]);
        }

        // 5. Oyuncuların envanterini (Kartları) tamamen sıfırla
        await db.run("DELETE FROM inventory");
        
        console.log("✅ Geçen hafta sonuçları kaydedildi ve tüm envanterler sıfırlandı!");

    } catch (err) {
        console.error("Sıfırlama sırasında kritik hata:", err);
    }
}, {
    scheduled: true,
    timezone: "Europe/Istanbul"
});