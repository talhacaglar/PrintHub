// node --test ile çalışır: npm test
//
// Sunucunun kimlik doğrulaması gerektirmeden HANGİ dosyaları verdiğini
// doğrular. Regresyon: `express.static(__dirname)` repo KÖKÜNÜ sunuyordu ve
// /api kimlik kapısının ÜSTÜNDEYDİ; GET /printhub.db oturum gerektirmeden
// tüm veritabanını (bcrypt parola özetleri, safeStorage ile şifreli AD
// parolası, ISO 27001 denetim kaydı) indirilebilir yapıyordu.
//
// Sunucu gerçekten ayağa kaldırılıp HTTP isteği atılır; yönlendirme sırasına
// dair varsayım yapılmaz.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

// db.js modül yüklenirken DB yolunu okur — require'dan ÖNCE ayarla.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'printhub-sec-'));
process.env.PRINTHUB_DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.PRINTHUB_PORT = '0'; // rastgele boş port

let sunucu, port, nativeOk = true;

before(async () => {
    let app;
    try {
        ({ app } = require('../server'));
    } catch (e) {
        nativeOk = false;
        console.log(`# static-security testleri atlandı: ${e.message}`);
        return;
    }
    await new Promise((resolve) => {
        sunucu = app.listen(0, '127.0.0.1', () => {
            port = sunucu.address().port;
            resolve();
        });
    });
});

after(() => {
    try { sunucu && sunucu.close(); } catch { /* ok */ }
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ok */ }
});

// Oturum AÇMADAN istek atar (Authorization başlığı ve çerez yok).
function get(yol) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: yol }, (res) => {
            res.resume(); // gövdeyi boşalt
            res.on('end', () => resolve(res.statusCode));
        }).on('error', reject);
    });
}

// Kimliksiz erişime ASLA açılmaması gereken kök dosyalar.
const YASAK = [
    '/printhub.db',
    '/printhub.db-wal',
    '/server.js',
    '/auth.js',
    '/db.js',
    '/ad.js',
    '/package.json',
    '/package-lock.json',
    '/nohup.out',
    '/.gitignore',
];

for (const yol of YASAK) {
    test(`kimliksiz GET ${yol} sunulmaz`, { skip: !nativeOk }, async () => {
        const kod = await get(yol);
        assert.ok(kod === 404 || kod === 403,
            `${yol} → ${kod} (404/403 bekleniyordu; bu dosya kimliksiz sunulmamalı)`);
    });
}

test('dizin geçişi ile kök dosyalara ulaşılamaz', { skip: !nativeOk }, async () => {
    for (const yol of ['/js/../printhub.db', '/assets/../server.js', '/js/../../etc/passwd']) {
        const kod = await get(yol);
        assert.ok(kod !== 200, `${yol} → ${kod} (200 olmamalı)`);
    }
});

// Giriş ekranının çalışabilmesi için bunlar kimliksiz sunulmak ZORUNDA.
test('istemci varlıkları kimliksiz sunulmaya devam eder', { skip: !nativeOk }, async () => {
    assert.strictEqual(await get('/'), 200, 'giriş ekranı yüklenebilmeli');
    assert.strictEqual(await get('/index.html'), 200);
    assert.strictEqual(await get('/style.css'), 200);
    assert.strictEqual(await get('/js/core.js'), 200);
    assert.strictEqual(await get('/js/pages-ui.js'), 200);
});

test('API uçları kimliksiz erişimi reddeder', { skip: !nativeOk }, async () => {
    for (const yol of ['/api/printers', '/api/settings', '/api/audit', '/api/stock']) {
        const kod = await get(yol);
        assert.ok(kod === 401 || kod === 403, `${yol} → ${kod} (401/403 bekleniyordu)`);
    }
});
