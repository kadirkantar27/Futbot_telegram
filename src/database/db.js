const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Veritabanı dosyasını ana proje klasöründe 'futbol_bot.db' adıyla oluştururuz.
const dbPath = path.resolve(__dirname, '../../futbol_bot.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error("Veritabanı bağlantı hatası:", err.message);
    } else {
        console.log("Veritabanına başarıyla bağlanıldı.");
    }
});

// Tabloları kuruyoruz
db.serialize(() => {
    // Kullanıcıların genel verileri (Puan ve son kart çekim zamanı)
    db.run(`CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY, 
        username TEXT, 
        last_draw INTEGER DEFAULT 0, 
        points INTEGER DEFAULT 0
    )`);

    // Kullanıcıların kazandığı kartlar (Benzersiz ID, kime ait olduğu ve kadroda olup olmadığı)
    db.run(`CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        user_id INTEGER, 
        name TEXT, 
        rarity TEXT, 
        ovr INTEGER, 
        in_squad INTEGER DEFAULT 0
    )`);
});

// Callback cehenneminden kurtulmak için Async/Await uyumlu veritabanı yardımcı fonksiyonları
const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) { 
        if (err) reject(err); 
        else resolve(this); 
    });
});

const get = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
        if (err) reject(err); 
        else resolve(row); 
    });
});

const all = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
        if (err) reject(err); 
        else resolve(rows); 
    });
});

module.exports = { run, get, all };