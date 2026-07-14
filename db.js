// ============================================
// PrintHub — SQLite Veri Katmanı (db.js)
// better-sqlite3 ile tek dosyalık yerel veritabanı.
// Şema: toner türleri, stok hareketleri, yazıcı okumaları,
// denetim logu (ISO 27001 A.8.15), uygulama kullanıcıları (RBAC), ayarlar.
// ============================================

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

// DB yolu: Electron main.js bunu userData altına ayarlar (PRINTHUB_DB_PATH),
// doğrudan `node server.js` çalıştırılırsa proje klasörüne düşer.
const DB_PATH = process.env.PRINTHUB_DB_PATH || path.join(__dirname, 'printhub.db');

// Klasörün var olduğundan emin ol
try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
} catch (e) { /* zaten var */ }

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ============================================
// ŞEMA (migration — idempotent)
// ============================================
function migrate() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS app_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'viewer',        -- admin | operator | viewer
            must_change_password INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS toner_types (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,                          -- ör: "HP 26X CF226X"
            color TEXT NOT NULL DEFAULT 'black',         -- black | cyan | magenta | yellow
            printer_model TEXT DEFAULT '',               -- uyumlu yazıcı modeli
            yield_pages INTEGER NOT NULL DEFAULT 0,      -- kartuş başına tahmini sayfa
            unit_cost REAL NOT NULL DEFAULT 0,           -- birim maliyet
            currency TEXT NOT NULL DEFAULT 'TRY',
            min_stock INTEGER NOT NULL DEFAULT 2,        -- düşük stok eşiği
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS stock_movements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            toner_type_id INTEGER NOT NULL REFERENCES toner_types(id) ON DELETE CASCADE,
            direction TEXT NOT NULL,                     -- 'in' (giriş) | 'out' (çıkış)
            quantity INTEGER NOT NULL,
            unit_cost REAL NOT NULL DEFAULT 0,           -- bu hareketteki birim maliyet
            printer_ip TEXT,                             -- çıkış bir yazıcıya yapıldıysa
            note TEXT DEFAULT '',
            actor TEXT DEFAULT '',                       -- işlemi yapan kullanıcı
            movement_date TEXT,                          -- gerçek işlem tarihi (geriye dönük giriş için)
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS printer_readings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            printer_ip TEXT NOT NULL,
            serial TEXT DEFAULT '',
            name TEXT DEFAULT '',
            total_printed INTEGER NOT NULL DEFAULT 0,
            toner_json TEXT DEFAULT '{}',                -- {"black":42,"cyan":80,...}
            captured_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_readings_ip_time
            ON printer_readings(printer_ip, captured_at);

        CREATE TABLE IF NOT EXISTS known_printers (
            printer_ip TEXT PRIMARY KEY,
            name TEXT DEFAULT '',
            model TEXT DEFAULT '',
            open_ports TEXT DEFAULT '[]',
            last_seen TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS printer_assets (
            printer_ip TEXT PRIMARY KEY,
            asset_tag TEXT DEFAULT '',                   -- demirbaş numarası
            custom_location TEXT DEFAULT '',             -- elle girilen konum (SNMP'yi geçersiz kılar)
            notes TEXT DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            actor TEXT DEFAULT '',
            action TEXT NOT NULL,                        -- login, create, update, delete, ...
            entity TEXT DEFAULT '',                      -- toner_type, stock, user, ...
            entity_id TEXT DEFAULT '',
            detail TEXT DEFAULT '',
            ip TEXT DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at);
    `);
}
migrate();

// Var olan kurulumlara sonradan eklenen kolonlar (idempotent)
try { db.exec("ALTER TABLE stock_movements ADD COLUMN movement_date TEXT"); } catch (e) { /* kolon zaten var */ }

// ============================================
// SEED — ilk çalıştırmada varsayılan admin + ayarlar
// ============================================
function seed() {
    const userCount = db.prepare('SELECT COUNT(*) AS c FROM app_users').get().c;
    if (userCount === 0) {
        const hash = bcrypt.hashSync('admin123', 10);
        db.prepare(`INSERT INTO app_users (username, password_hash, role, must_change_password)
                    VALUES (?, ?, 'admin', 1)`).run('admin', hash);
        console.log('[DB] Varsayılan yönetici oluşturuldu → kullanıcı: admin / parola: admin123 (ilk girişte değiştirin)');
    }

    const defaults = {
        currency: 'TRY',
        scan_base_ip: '192.168.2.18',
        scan_cidr: '22',
        ad_url: '',
        ad_base_dn: '',
        ad_bind_dn: '',
        ad_password: '',            // safeStorage ile şifreli saklanabilir (main.js)
        ad_share_roots: '[]',       // JSON dizi: taranacak paylaşım kök yolları
        auto_refresh_minutes: '0'   // 0 = otomatik yenileme kapalı
    };
    const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(defaults)) insert.run(k, v);
}
seed();

// ============================================
// AYAR YARDIMCILARI
// ============================================
function getSetting(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
}
function setSetting(key, value) {
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value ?? ''));
}
function getAllSettings() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
}

// ============================================
// DENETİM LOGU (ISO 27001 A.8.15)
// ============================================
function audit({ actor = '', action, entity = '', entity_id = '', detail = '', ip = '' }) {
    db.prepare(`INSERT INTO audit_log (actor, action, entity, entity_id, detail, ip)
                VALUES (?, ?, ?, ?, ?, ?)`).run(actor, action, entity, String(entity_id), detail, ip);
}

module.exports = {
    db,
    DB_PATH,
    getSetting,
    setSetting,
    getAllSettings,
    audit,
};
