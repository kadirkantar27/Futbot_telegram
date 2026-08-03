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


// GİZLİ ADMİN KOMUTU: Geceyi beklemeden haftayı bitirir
bot.onText(/\/sezonbitir/, async (msg) => {
    const ADMIN_ID = 7365398035; // Kendi ID'ni yazmayı unutma!
    if (msg.from.id !== ADMIN_ID) return;

    try {
        // 1. ESKİ TABLOYU KÖKTEN SİL VE YENİ SÜTUNLARLA OLUŞTUR (Hata Çözümü)
        await db.run("DROP TABLE IF EXISTS gecen_hafta");
        await db.run("CREATE TABLE gecen_hafta (user_id INTEGER, username TEXT, points INTEGER)");
        
        // 2. Mevcut haftanın puan sıralamasını çek
        const top10 = await db.all("SELECT user_id, username, points FROM users WHERE points > 0 ORDER BY points DESC LIMIT 10");
        
        // 3. Geçmiş haftaya isimleri ve puanlarıyla birlikte kaydet
        for (const user of top10) {
            await db.run("INSERT INTO gecen_hafta (user_id, username, points) VALUES (?, ?, ?)", [user.user_id, user.username, user.points]);
        }
        
        // 4. Hem envanteri hem de puanları SIFIRLA
        await db.run("DELETE FROM inventory"); 
        await db.run("UPDATE users SET points = 0"); 
        
        bot.sendMessage(msg.chat.id, "✅ Sezon bitirildi! Envanterler ve PUANLAR tamamen sıfırlandı, sonuçlar /gecenhafta'ya eklendi.");
    } catch (err) {
        bot.sendMessage(msg.chat.id, "❌ Hata: " + err.message);
    }
});

// KULLANICI KOMUTU: Geçen Haftanın Şampiyonları
bot.onText(/\/gecenhafta/, async (msg) => {
    const chatId = msg.chat.id;

    try {
        await db.run("CREATE TABLE IF NOT EXISTS gecen_hafta (user_id INTEGER, username TEXT, points INTEGER)");

        // Geçen haftanın verilerini çek
        const eskiTop10 = await db.all("SELECT username, points FROM gecen_hafta ORDER BY points DESC");

        if (eskiTop10.length === 0) {
            return bot.sendMessage(chatId, "🤷‍♂️ Henüz tamamlanmış bir hafta yok. İlk şampiyonlar bu Pazar belli olacak!");
        }

        // Şık liste formatı
        let mesaj = "🏆 **GEÇEN HAFTANIN ŞAMPİYONLARI** 🏆\n\n";
        
        eskiTop10.forEach((user, index) => {
            // İlk 3'e özel madalya emojileri
            let madalya = "🏅";
            if (index === 0) madalya = "🥇";
            if (index === 1) madalya = "🥈";
            if (index === 2) madalya = "🥉";

            // İsim yoksa 'Bilinmeyen Menajer' yaz
            const isim = user.username ? user.username : "Gizemli Menajer";
            
            mesaj += `${madalya} **${index + 1}. ${isim}** - ${user.points} Puan\n`;
        });

        bot.sendMessage(chatId, mesaj, { parse_mode: "Markdown" });

    } catch (err) {
        bot.sendMessage(chatId, "❌ Sonuçlar getirilirken hata oluştu.");
        console.error("Geçen hafta hatası:", err);
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
        // Eski tabloyu kökten sil ve yeni yapıyla oluştur
        await db.run("DROP TABLE IF EXISTS gecen_hafta");
        await db.run("CREATE TABLE gecen_hafta (user_id INTEGER, username TEXT, points INTEGER)");

        // Puanlara göre Top 10'u bul
        const top10 = await db.all("SELECT user_id, username, points FROM users WHERE points > 0 ORDER BY points DESC LIMIT 10");

        for (const user of top10) {
            await db.run("INSERT INTO gecen_hafta (user_id, username, points) VALUES (?, ?, ?)", [user.user_id, user.username, user.points]);
        }

        // Hem envanteri hem de kullanıcı puanlarını sıfırla
        await db.run("DELETE FROM inventory");
        await db.run("UPDATE users SET points = 0");
        
        console.log("✅ Haftalık sıfırlama yapıldı, puanlar 0'landı.");
    } catch (err) {
        console.error("Sıfırlama sırasında kritik hata:", err);
    }
}, {
    scheduled: true,
    timezone: "Europe/Istanbul"
});