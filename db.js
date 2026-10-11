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

        -- Oturum jetonları (Bearer token). Ham jeton saklanmaz; yalnızca
        -- SHA-256 özeti tutulur, böylece DB sızsa bile jeton kullanılamaz.
        -- ISO 27001: A.5.17 Kimlik doğrulama bilgisi, A.8.5 Güvenli kimlik doğrulama.
        CREATE TABLE IF NOT EXISTS auth_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token_hash TEXT UNIQUE NOT NULL,
            user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
            issued_at TEXT NOT NULL DEFAULT (datetime('now')),
            expires_at TEXT NOT NULL,
            last_used_at TEXT,
            ip TEXT DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);
        CREATE INDEX IF NOT EXISTS idx_auth_tokens_exp ON auth_tokens(expires_at);

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
            -- NULL = sayaç okunamadı. Eskiden NOT NULL DEFAULT 0 idi ve SNMP'siz
            -- her cihaz için 0 yazılıyordu; "hiç basmadı" ile "bilinmiyor" aynı
            -- değere düşünce aylık tüketim hesabı bozuluyordu.
            total_printed INTEGER,
            toner_json TEXT DEFAULT '{}',                -- {"black":42,"cyan":80,...}
            captured_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_readings_ip_time
            ON printer_readings(printer_ip, captured_at);

        -- printer_ip çalışma zamanı tutamacıdır; KİMLİK serial_number > mac > ip
        -- sırasıyla belirlenir (DHCP ile IP değişse de aynı cihaz tek kayıtta kalır).
        CREATE TABLE IF NOT EXISTS known_printers (
            printer_ip TEXT PRIMARY KEY,
            name TEXT DEFAULT '',
            model TEXT DEFAULT '',
            open_ports TEXT DEFAULT '[]',
            serial_number TEXT DEFAULT '',               -- SNMP prtGeneralSerialNumber
            mac TEXT DEFAULT '',                         -- SNMP ifPhysAddress (ilk sıfır olmayan)
            first_seen TEXT DEFAULT '',                  -- ilk keşif (ISO)
            last_online TEXT DEFAULT '',                 -- son GERÇEK cevap (ISO) — budama bunu kullanır
            last_seen TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS printer_assets (
            printer_ip TEXT PRIMARY KEY,
            asset_tag TEXT DEFAULT '',                   -- demirbaş numarası
            custom_location TEXT DEFAULT '',             -- elle girilen konum (SNMP'yi geçersiz kılar)
            notes TEXT DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- Kişi IT envanteri: kullanıcıya atanmış cihazlar (ISO A.5.9)
        CREATE TABLE IF NOT EXISTS user_devices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sam TEXT NOT NULL,                           -- AD kullanıcı adı (sAMAccountName)
            hostname TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'manual',       -- ad | winrm | manual
            model TEXT DEFAULT '',
            serial TEXT DEFAULT '',
            cpu TEXT DEFAULT '',
            ram_gb REAL DEFAULT 0,
            disk_gb REAL DEFAULT 0,
            os TEXT DEFAULT '',
            asset_tag TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            last_seen TEXT DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(sam, hostname)
        );
        CREATE INDEX IF NOT EXISTS idx_user_devices_sam ON user_devices(sam);

        -- Cihazlardaki yüklü yazılım envanteri (WinRM ile toplanır)
        CREATE TABLE IF NOT EXISTS device_software (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id INTEGER NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            version TEXT DEFAULT '',
            publisher TEXT DEFAULT '',
            install_date TEXT DEFAULT '',
            captured_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_device_software_dev ON device_software(device_id);

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
try { db.exec("ALTER TABLE known_printers ADD COLUMN serial_number TEXT DEFAULT ''"); } catch (e) { /* kolon zaten var */ }
try { db.exec("ALTER TABLE known_printers ADD COLUMN mac TEXT DEFAULT ''"); } catch (e) { /* kolon zaten var */ }
try { db.exec("ALTER TABLE known_printers ADD COLUMN first_seen TEXT DEFAULT ''"); } catch (e) { /* kolon zaten var */ }
try { db.exec("ALTER TABLE known_printers ADD COLUMN last_online TEXT DEFAULT ''"); } catch (e) { /* kolon zaten var */ }
// Tedarikçi ve teslim alan GERÇEK alanlar olarak tutulur. Excel dışa aktarımı
// bunları eskiden hareket notundan / uygulama kullanıcı adından türetiyordu:
// "FİRMA" sütununa 'STOK GİRİŞİ' sabiti, "ALAN KİŞİ" sütununa ise tonerı
// teslim alan kişi değil işlemi giren operatörün adı yazılıyordu.
try { db.exec("ALTER TABLE stock_movements ADD COLUMN supplier TEXT DEFAULT ''"); } catch (e) { /* kolon zaten var */ }
try { db.exec("ALTER TABLE stock_movements ADD COLUMN recipient TEXT DEFAULT ''"); } catch (e) { /* kolon zaten var */ }

// ============================================
// TEK SEFERLİK VERİ DÜZELTMELERİ
// Kod artık uydurma değer üretmiyor; bu blok eski sürümlerin veritabanına
// yazdıklarını temizler. Hepsi idempotenttir.
// ============================================
function cleanupFabricatedData() {
    // 1) total_printed sütunu NOT NULL ise tabloyu yeniden kur (SQLite ALTER
    //    ile kısıt kaldırılamaz). NULL = "sayaç okunamadı" ayrımı bunu gerektirir.
    const kolonlar = db.prepare('PRAGMA table_info(printer_readings)').all();
    const totalCol = kolonlar.find(c => c.name === 'total_printed');
    if (totalCol && totalCol.notnull === 1) {
        db.exec(`
            CREATE TABLE printer_readings_yeni (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                printer_ip TEXT NOT NULL,
                serial TEXT DEFAULT '',
                name TEXT DEFAULT '',
                total_printed INTEGER,
                toner_json TEXT DEFAULT '{}',
                captured_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            INSERT INTO printer_readings_yeni (id, printer_ip, serial, name, total_printed, toner_json, captured_at)
                SELECT id, printer_ip, serial, name,
                       CASE WHEN total_printed > 0 THEN total_printed ELSE NULL END,
                       toner_json, captured_at
                FROM printer_readings;
            DROP TABLE printer_readings;
            ALTER TABLE printer_readings_yeni RENAME TO printer_readings;
            CREATE INDEX IF NOT EXISTS idx_readings_ip_time
                ON printer_readings(printer_ip, captured_at);
        `);
        console.log('[DB] printer_readings.total_printed artık NULL kabul ediyor (0 = "bilinmiyor" karışıklığı giderildi).');
    }

    // 2) İçinde ölçüm OLMAYAN okumalar silinir: sayfa sayacı yok ve toner
    //    JSON'unda negatif olmayan tek bir seviye bile yok. Bunlar SNMP'ye
    //    cevap vermeyen cihazlar için üretilmiş {"black":-1} kayıtlarıdır;
    //    kartuş değişimi tespitinde -1 → 88 sıçraması olarak okunup hayali
    //    kartuş değişimi ve maliyet üretiyorlardı.
    const bosOkuma = db.prepare(`
        DELETE FROM printer_readings
        WHERE (total_printed IS NULL OR total_printed <= 0)
          AND NOT EXISTS (
              SELECT 1 FROM json_each(printer_readings.toner_json)
              WHERE json_each.type = 'integer' AND json_each.value >= 0
          )
    `).run();
    if (bosOkuma.changes > 0) {
        console.log(`[DB] ${bosOkuma.changes} ölçümsüz yazıcı okuması silindi (SNMP yanıtı olmayan cihazlar için üretilmişti).`);
    }

    // 3) Kalan kayıtlarda "bilinmiyor" (negatif) toner seviyeleri JSON'dan
    //    çıkarılır — bilinmiyor bir ölçüm değildir, zaman serisinde durmamalı.
    const negatifli = db.prepare(`
        SELECT id, toner_json FROM printer_readings
        WHERE EXISTS (
            SELECT 1 FROM json_each(printer_readings.toner_json)
            WHERE json_each.type = 'integer' AND json_each.value < 0
        )
    `).all();
    if (negatifli.length > 0) {
        const guncelle = db.prepare('UPDATE printer_readings SET toner_json = ? WHERE id = ?');
        const tx = db.transaction((rows) => {
            for (const r of rows) {
                let obj;
                try { obj = JSON.parse(r.toner_json); } catch { continue; }
                const temiz = Object.fromEntries(
                    Object.entries(obj).filter(([, v]) => typeof v === 'number' && v >= 0)
                );
                guncelle.run(JSON.stringify(temiz), r.id);
            }
        });
        tx(negatifli);
        console.log(`[DB] ${negatifli.length} okumadan bilinmeyen (-1) toner seviyeleri çıkarıldı.`);
    }

    // 4) 'SNMP Yanıt Yok' bir teşhis mesajıdır, model değil — envanter
    //    sütununda kalmamalı.
    const model = db.prepare("UPDATE known_printers SET model = '' WHERE model = 'SNMP Yanıt Yok'").run();
    if (model.changes > 0) {
        console.log(`[DB] ${model.changes} yazıcının model alanından 'SNMP Yanıt Yok' teşhis metni temizlendi.`);
    }
}
cleanupFabricatedData();

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
        // Tarama hedefi için varsayılan YOKTUR. Burada bir zamanlar belirli bir
        // müşteri ağının adresi (192.168.2.18//22) sabit duruyordu; kurulan her
        // kopya, kullanıcının ağıyla ilgisi olmayan 1022 adresi tarıyordu.
        // Boşken /api/scan hata döner ve kullanıcıyı Ayarlar'a yönlendirir;
        // /api/network/suggest makinenin GERÇEK arayüzlerinden öneri verir.
        scan_base_ip: '',              // scan_targets boşsa kullanılır (geriye dönük uyum)
        scan_cidr: '24',               // "
        scan_targets: '',              // serbest CIDR listesi: "192.168.2.0/24, 10.1.5.0/24"
        printer_stale_days: '30',      // bu kadar gündür cevap vermeyen kayıt düşer (0 = kapalı)
        low_toner_percent: '10',       // düşük toner eşiği — sunucu ve arayüz ortak kaynağı
        snmp_community: 'public',    // SNMP v2c community string
        ad_url: '',
        ad_base_dn: '',
        ad_bind_dn: '',
        ad_password: '',            // safeStorage ile şifreli saklanabilir (main.js)
        ad_share_roots: '[]',       // JSON dizi: taranacak paylaşım kök yolları
        ad_tls_insecure: '0',       // 1 = LDAPS sertifika doğrulamasını atla (SADECE test)
        auto_refresh_minutes: '0',  // 0 = otomatik yenileme kapalı
        winrm_enabled: '0',         // 1 = WinRM ile uzak envanter toplama açık (yalnız Windows)
        app_access_map: '[]',       // JSON: [{group:"SAP_Users", app:"SAP ERP", note:""}]
        readings_retention_days: '90', // printer_readings ham veri saklama süresi (gün)
        snmp_version: '2c',         // '2c' veya '3'
        snmp_v3_user: '',           // SNMPv3 USM kullanıcı adı
        snmp_v3_auth_protocol: 'sha', // sha | md5 | none
        snmp_v3_auth_key: '',       // auth parolası (gizli)
        snmp_v3_priv_protocol: 'aes', // aes | des | none
        snmp_v3_priv_key: ''        // priv parolası (gizli)
    };
    const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(defaults)) insert.run(k, v);
}
seed();

// ============================================
// TEK SEFERLİK TEMİZLİK — Test/simülasyon AD ayarları
// Geliştirme sırasında kullanılan AD simülasyonuna (staj.local /
// 192.168.137.10) ait bağlantı bilgileri veritabanında kalmışsa
// açılışta otomatik temizlenir. Gerçek şirket AD ayarlarına dokunmaz.
// ============================================
function cleanupSimulationAdConfig() {
    const get = (k) => {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
        return row ? String(row.value || '') : '';
    };
    const url = get('ad_url');
    const baseDn = get('ad_base_dn');
    const bindDn = get('ad_bind_dn');
    const isSim = url.includes('192.168.137.10')
        || /dc=staj\b/i.test(baseDn)
        || /@staj\.local$/i.test(bindDn);
    if (!isSim) return;
    const clear = db.prepare(`INSERT INTO settings (key, value) VALUES (?, '')
                              ON CONFLICT(key) DO UPDATE SET value = ''`);
    for (const key of ['ad_url', 'ad_base_dn', 'ad_bind_dn', 'ad_password', 'ad_tls_insecure']) {
        clear.run(key);
    }
    console.log('[DB] Simülasyon AD ayarları (staj.local) temizlendi — Ayarlar > Active Directory boş.');
}
cleanupSimulationAdConfig();

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
// GÜVENLİ (ŞİFRELİ) AYARLAR — Electron safeStorage
// AD servis hesabı parolası gibi sırlar DB'de düz metin yerine
// işletim sistemi anahtar deposuyla (DPAPI/Keychain/kwallet) şifrelenir.
// Electron dışı çalıştırmada (node server.js) düz metne düşer.
// ============================================
const SECURE_PREFIX = 'enc:v1:';

function getSafeStorage() {
    try {
        const { safeStorage } = require('electron');
        if (safeStorage && safeStorage.isEncryptionAvailable()) return safeStorage;
    } catch (e) { /* Electron dışı ortam */ }
    return null;
}

function setSecureSetting(key, value) {
    const plain = String(value ?? '');
    const ss = getSafeStorage();
    if (ss && plain) {
        const enc = ss.encryptString(plain).toString('base64');
        setSetting(key, SECURE_PREFIX + enc);
    } else {
        setSetting(key, plain);
    }
}

function getSecureSetting(key) {
    const raw = getSetting(key);
    if (raw == null || raw === '') return raw;
    if (!raw.startsWith(SECURE_PREFIX)) return raw; // eski düz metin kayıt
    const ss = getSafeStorage();
    if (!ss) return null; // şifreli veri var ama çözülemiyor
    try {
        return ss.decryptString(Buffer.from(raw.slice(SECURE_PREFIX.length), 'base64'));
    } catch (e) {
        console.error(`[DB] Güvenli ayar çözülemedi (${key}):`, e.message);
        return null;
    }
}

function isSecureValue(raw) {
    return typeof raw === 'string' && raw.startsWith(SECURE_PREFIX);
}

// Fırsatçı geçiş: daha önce düz metin kaydedilmiş AD parolasını
// safeStorage kullanılabilir olur olmaz şifreli biçime taşı.
function migratePlaintextSecrets() {
    const ss = getSafeStorage();
    if (!ss) return;
    for (const key of ['ad_password']) {
        const raw = getSetting(key);
        if (raw && !raw.startsWith(SECURE_PREFIX)) {
            setSecureSetting(key, raw);
            console.log(`[DB] '${key}' ayarı şifreli depolamaya taşındı.`);
        }
    }
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
    setSecureSetting,
    getSecureSetting,
    isSecureValue,
    migratePlaintextSecrets,
    audit,
};
