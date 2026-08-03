const db = require('../database/db');
const playersPool = require('../config/players.json');

const COOLDOWN_TIME = 1 * 60 * 60 * 1000;

// 1. KART ÇEKME MANTIĞI
async function drawCard(userId, username) {
    const now = Date.now();
    
    await db.run("INSERT OR IGNORE INTO users (user_id, username) VALUES (?, ?)", [userId, username]);
    
    // Eski veritabanına otomatik olarak "draw_count" (çekim hakkı) sütunu ekliyoruz (Varsa hata vermeden geçer)
    try {
        await db.run("ALTER TABLE users ADD COLUMN draw_count INTEGER DEFAULT 0");
    } catch (error) {
        // Sütun zaten ekliyse sessizce devam et
    }

    const user = await db.get("SELECT last_draw, draw_count FROM users WHERE user_id = ?", [userId]);

    let currentDrawCount = user ? (user.draw_count || 0) : 0;
    let lastDraw = user ? (user.last_draw || 0) : 0;

    // 1. KONTROL: 3 saat geçmişse hakları tamamen sıfırla (Yeni 5'li pakete hazır)
    if (lastDraw > 0 && (now - lastDraw) >= COOLDOWN_TIME) {
        currentDrawCount = 0;
        lastDraw = 0; 
    }

    // 2. KONTROL: Hakları bitmiş mi?
    
    if (lastDraw > 0 && (now - lastDraw) < COOLDOWN_TIME && currentDrawCount >= 5) {
        const timeLeft = COOLDOWN_TIME - (now - lastDraw);
        const hours = Math.floor(timeLeft / (1000 * 60 * 60));
        const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
        return { success: false, message: `⏳Yeni kartlar için beklemen gerek: ${hours} saat ${minutes} dakika.` };
    }
    
    // İlk çekimi yapıyorsa 3 saatlik süreyi (cooldown) tam bu anda başlatıyoruz
    if (currentDrawCount === 0) {
        lastDraw = now;
    }

    currentDrawCount++; // Çekilen kart sayısını 1 artır

    // --- TEKLİ KART ÇEKME MANTIĞI ---
    const chance = Math.floor(Math.random() * 100) + 1; 
    let selectedRarity = "Bronz"; 

    if (chance <= 5) selectedRarity = "İkon";             
    else if (chance <= 35) selectedRarity = "Altın";      
    else if (chance <= 50) selectedRarity = "Gümüş";      
    else selectedRarity = "Bronz";                        

    let filteredPool = playersPool.filter(p => p.rarity === selectedRarity);
    if (filteredPool.length === 0) filteredPool = playersPool;

    const randomPlayer = filteredPool[Math.floor(Math.random() * filteredPool.length)];
    
    // Kartı envantere ekle
    await db.run("INSERT INTO inventory (user_id, name, rarity, ovr) VALUES (?, ?, ?, ?)", [userId, randomPlayer.name, randomPlayer.rarity, randomPlayer.ovr]);
    
    // Çekim sayısını ve süreyi veritabanında güncelle
    await db.run("UPDATE users SET last_draw = ?, draw_count = ?, username = ? WHERE user_id = ?", [lastDraw, currentDrawCount, username, userId]);

    const remaining = 5 - currentDrawCount;

    return { 
        success: true, 
        message: `🎉 Yeni Kart Kazandın!\n\n**${randomPlayer.rarity} | ${randomPlayer.name} | OVR: ${randomPlayer.ovr}**\n\n*(Kalan Hakkın: ${remaining}/5)*` 
    };
}

// 2. KARTLARI LİSTELEME MANTIĞI
async function getUserInventory(targetUserId, page = 1) {
    const limit = 10; // Her sayfada gösterilecek oyuncu sayısı
    const offset = (page - 1) * limit; // Kaçıncı sıradan başlanacağı

    // Önce kullanıcının adını veritabanından bulalım (Başkası tıklarsa ismini bilebilmek için)
    const user = await db.get("SELECT username FROM users WHERE user_id = ?", [targetUserId]);
    const username = user ? user.username : "Oyuncu";

    // Toplam benzersiz kart sayısını bulup sayfa sayısını hesaplıyoruz
    const totalResult = await db.get(
        `SELECT COUNT(*) as totalCount FROM (
            SELECT name FROM inventory WHERE user_id = ? GROUP BY name, rarity, ovr
        )`, [targetUserId]
    );
    const totalItems = totalResult ? totalResult.totalCount : 0;
    const totalPages = Math.ceil(totalItems / limit) || 1;

    // Sayfaya ait 10 kartı veritabanından çekiyoruz (LIMIT ve OFFSET ile)
    const inventory = await db.all(
        `SELECT name, rarity, ovr, COUNT(*) as count 
         FROM inventory 
         WHERE user_id = ? 
         GROUP BY name, rarity, ovr 
         ORDER BY ovr DESC 
         LIMIT ? OFFSET ?`, 
        [targetUserId, limit, offset]
    );

    if (inventory.length === 0 && page === 1) {
        return { success: false, message: "❌ Henüz hiç kart yok! `/kartcek` komutuyla kart çekmeye başlayabilirsiniz." };
    }

    let message = `🎒 **${username} 'in Sahip Olduğu Kartlar:**\n`;
    message += `📄 *Sayfa: ${page} / ${totalPages}*\n\n`;
    
    inventory.forEach((card, index) => {
        const countText = card.count > 1 ? ` **(x${card.count})**` : "";
        const actualIndex = offset + index + 1; // Liste numarasının sayfaya göre devam etmesi için
        message += `${actualIndex}. **${card.rarity}** | ${card.name} | OVR: **${card.ovr}**${countText}\n`;
    });

    // Sadece metni değil, sayfa bilgilerini de dışarı aktarıyoruz
    return { success: true, message, totalPages, currentPage: page, targetUserId };
}

// 3. BENZERSİZ KADRO KURMA MANTIĞI (Klonları Engeller)
async function buildUniqueSquad(userId) {
    // Önce kullanıcının mevcut kadrosunu sıfırla
    await db.run("UPDATE inventory SET in_squad = 0 WHERE user_id = ?", [userId]);

    // Sadece benzersiz isimlere sahip en yüksek reytingli 5 kartı getir
    const topUniqueCards = await db.all(`
        SELECT id, name, ovr 
        FROM inventory 
        WHERE user_id = ? 
        GROUP BY name 
        ORDER BY MAX(ovr) DESC 
        LIMIT 5
    `, [userId]);

    if (topUniqueCards.length < 5) {
        return `❌ Kadro kurmak için en az 5 **farklı** futbolcuya ihtiyacın var. Sende şu an ${topUniqueCards.length} farklı oyuncu var.`;
    }

    // Seçilen 5 benzersiz kartı "kadroda" olarak işaretle
    for (const card of topUniqueCards) {
        await db.run("UPDATE inventory SET in_squad = 1 WHERE id = ?", [card.id]);
    }

    const totalOvr = topUniqueCards.reduce((sum, p) => sum + p.ovr, 0);

    let msg = `✅ **En İyi 5'li Kadron Kuruldu!** (Toplam Güç: ${totalOvr})\n\n`;
    topUniqueCards.forEach(p => msg += `👕 ${p.name} (OVR: ${p.ovr})\n`);
    return msg;
}

// 4. CANLI MAÇ MANTIĞI (Animasyon ve Gol Olayları Dahil)
async function simulateLiveMatch(playerA_Id, playerA_Name, playerB_Id, playerB_Name) {
    const squadA = await db.all("SELECT * FROM inventory WHERE user_id = ? AND in_squad = 1", [playerA_Id]);
    const squadB = await db.all("SELECT * FROM inventory WHERE user_id = ? AND in_squad = 1", [playerB_Id]);

   

    // --- YENİ DENGELİ MAÇ MATEMATİĞİ ---

    // 1. TEMEL GÜÇ TOPLAMI VE FORM (Form dalgalanmasını %3'e düşürdük, daha istikrarlı oynayacaklar)
    let powerA = squadA.reduce((sum, p) => sum + p.ovr, 0);
    let powerB = squadB.reduce((sum, p) => sum + p.ovr, 0);

    // 2. TEMEL ŞANS (Maç başı standart 0, 1 veya 2 gol atma potansiyeli)
    let goalsA = Math.floor(Math.random() * 4); 
    let goalsB = Math.floor(Math.random() * 4);

    // 3. GÜÇ FARKI ETKİSİ (Böleni 50 yaptık - 50 fark sadece 1 gol etki edecek)
    const diff = powerA - powerB;
    
    let diffBoostA = Math.round(diff / 40);
    let diffBoostB = Math.round(-diff / 40);
    
    // REKABET KİLİDİ: Güç farkı avantajını maksimum +2 ile sınırlandırdık
    goalsA += Math.min(2, Math.max(-2, diffBoostA));
    goalsB += Math.min(2, Math.max(-2, diffBoostB));

    // 4. DENGELEYİCİ MOMENTUM (Maçta sadece tek bir kırılma anı olur)
    const momentum = Math.random();
    if (momentum > 0.80) {
        goalsA += 1; // %15 ihtimalle A takımı ekstra gol bulur
    } else if (momentum < 0.20) {
        goalsB += 1; // %15 ihtimalle B takımı ekstra gol bulur
    }
    // %70 ihtimalle maçta ekstra momentum golü olmaz, skorlar normal kalır.

    // 5. SÜRPRİZ / TESELLİ GOLÜ (Gerçekten ezilen ve eksilere düşen takım için %50 şans)
    if (goalsA <= 0 && diffBoostA < 0 && Math.random() > 0.50) goalsA = 1;
    if (goalsB <= 0 && diffBoostB < 0 && Math.random() > 0.50) goalsB = 1;

    // Negatifleri sıfırlama
    goalsA = Math.max(0, goalsA);
    goalsB = Math.max(0, goalsB);

    // --- GOL DAKİKALARI VE ATAN OYUNCULARI OLUŞTURMA ---

    // --- GOL DAKİKALARI VE ATAN OYUNCULARI OLUŞTURMA ---
    const matchEvents = [];
    const usedMinutes = new Set();

    // Takımlardaki oyunculardan rastgele golcü seçmek için havuz
    const getScorer = (squad) => {
        if (squad.length === 0) return "Bilinmeyen Oyuncu";
        return squad[Math.floor(Math.random() * squad.length)].name;
    };

    // A Takımının golleri için dakika ve golcü ata
    for (let i = 0; i < goalsA; i++) {
        let minute;
        do {
            minute = Math.floor(Math.random() * 89) + 1; // 1 ile 89 arası rastgele dakika
        } while (usedMinutes.has(minute));
        usedMinutes.add(minute);

        matchEvents.push({
            minute: minute,
            team: "A",
            teamName: playerA_Name,
            scorer: getScorer(squadA)
        });
    }

    // B Takımının golleri için dakika ve golcü ata
    for (let i = 0; i < goalsB; i++) {
        let minute;
        do {
            minute = Math.floor(Math.random() * 89) + 1;
        } while (usedMinutes.has(minute));
        usedMinutes.add(minute);

        matchEvents.push({
            minute: minute,
            team: "B",
            teamName: playerB_Name,
            scorer: getScorer(squadB)
        });
    }

    // Golleri dakikalarına göre sıralıyoruz (Maç sırasına göre aksın diye)
    matchEvents.sort((a, b) => a.minute - b.minute);

    let finalMessage = `🏟 **MAÇ SONUCU** 🏟\n\n`;
    finalMessage += `**${playerA_Name}** (${powerA} Güç)  🆚  **${playerB_Name}** (${powerB} Güç)\n\n`;
    finalMessage += `⚽ **SKOR:** ${playerA_Name} **${goalsA} - ${goalsB}** ${playerB_Name}\n\n`;

    // --- GOL DAKİKALARI VE GOLCÜLERİ LİSTELEME ---
    if (matchEvents.length > 0) {
        finalMessage += `⏱ **Goller:**\n`;
        matchEvents.forEach(event => {
            // Hangi takımın attığına göre ikon ve etiket belirliyoruz
            const teamBadge = event.team === "A" ? "🔵" : "🔴";
            finalMessage += `⚽ ` + `\`${event.minute}. dk\`` + ` | ${teamBadge} **${event.teamName}** (${event.scorer})\n`;
        });
        finalMessage += `\n`;
    } else {
        finalMessage += `🛡️ *Karşılaşma golsüz sona erdi.*\n\n`;
    }

    if (goalsA > goalsB) {
        await db.run("UPDATE users SET points = points + 3 WHERE user_id = ?", [playerA_Id]);
        finalMessage += `🏆 **KAZANAN:** ${playerA_Name} (+3 Puan)`;
    } else if (goalsB > goalsA) {
        await db.run("UPDATE users SET points = points + 3 WHERE user_id = ?", [playerB_Id]);
        finalMessage += `🏆 **KAZANAN:** ${playerB_Name} (+3 Puan)`;
    } else {
        await db.run("UPDATE users SET points = points + 1 WHERE user_id = ?", [playerA_Id]);
        await db.run("UPDATE users SET points = points + 1 WHERE user_id = ?", [playerB_Id]);
        finalMessage += `🤝 **BERABERLİK!** İki taraf da 1 puan aldı.`;
    }

    return { matchEvents, finalMessage };
}
// 5. LİDERLİK TABLOSU
async function getTop10() {
    const users = await db.all("SELECT username, points FROM users ORDER BY points DESC LIMIT 10");
    if (users.length === 0) return "Henüz kimse puan kazanmadı.";

    let msg = "🏆 **GLOBAL LİDERLİK TABLOSU** 🏆\n\n";
    users.forEach((u, index) => {
        msg += `${index + 1}. ${u.username} - ${u.points} Puan\n`;
    });
    return msg;
}

module.exports = { drawCard, getUserInventory, buildUniqueSquad, simulateLiveMatch, getTop10 };