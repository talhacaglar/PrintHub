// node --test ile çalışır: npm test
// readings.js saf mantık testleri — geçici SQLite DB ile.
process.env.PRINTHUB_DB_PATH = require('path').join(require('os').tmpdir(), `printhub-readings-test-${process.pid}.db`);

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

// better-sqlite3 Electron ABI'siyle derlenmiş olabilir; sistem Node'u ile
// yüklenemezse bu dosyadaki testler atlanır (npm run rebuild sonrası Electron için tekrar derlenir).
let db, readings, nativeOk = true;
try {
    ({ db } = require('../db'));
    readings = require('../readings');
} catch (e) {
    nativeOk = false;
    console.log('# readings testleri atlandı: better-sqlite3 bu Node sürümü için derli değil.');
}

after(() => {
    try { db && db.close(); } catch { }
    try { fs.unlinkSync(process.env.PRINTHUB_DB_PATH); } catch { }
});

function insertReading(ip, capturedAt, total, toner) {
    db.prepare(`INSERT INTO printer_readings (printer_ip, name, total_printed, toner_json, captured_at)
                VALUES (?, ?, ?, ?, ?)`).run(ip, 'Test', total, JSON.stringify(toner || { black: 50 }), capturedAt);
}

test('getTonerUsageReport: tek sorgu ile aylık tüketimi hesaplar', { skip: !nativeOk }, () => {
    const now = new Date();
    const ym = now.toISOString().slice(0, 7);
    insertReading('10.0.0.1', `${ym}-01 08:00:00`, 1000);
    insertReading('10.0.0.1', `${ym}-15 08:00:00`, 1500);
    const report = readings.getTonerUsageReport();
    const p = report.byPrinter.find(x => x.ip === '10.0.0.1');
    assert.ok(p, 'yazıcı raporda olmalı');
    assert.strictEqual(p.monthlyPages, 500); // 1500 - 1000
});

test('getTonerUsageReport: SNMP yanıtsız (0) okumalar tüketimi şişirmez', { skip: !nativeOk }, () => {
    // Regresyon: SNMP cevap vermeyince total_printed=0 kaydedilir. Bu sıfır ay içi
    // "min" olarak alınırsa aylık tüketim, cihazın ömür sayacı kadar şişer
    // (gerçek vakada 8.358 yerine 1.070.993 sayfa görünüyordu).
    const ym = new Date().toISOString().slice(0, 7);
    insertReading('10.0.0.9', `${ym}-02 08:00:00`, 100000);
    insertReading('10.0.0.9', `${ym}-03 08:00:00`, 0);      // SNMP yanıt yok
    insertReading('10.0.0.9', `${ym}-04 08:00:00`, 100450);

    const report = readings.getTonerUsageReport();
    const p = report.byPrinter.find(x => x.ip === '10.0.0.9');
    assert.ok(p, 'yazıcı raporda olmalı');
    assert.strictEqual(p.monthlyPages, 450); // 100450 - 100000, sıfır yok sayılır
});

test('pruneReadings: eski ham kayıtları günlük özete indirger', { skip: !nativeOk }, () => {
    // 200 gün önce aynı güne 3 kayıt — yalnız sonuncusu kalmalı
    const old = new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 10);
    insertReading('10.0.0.2', `${old} 08:00:00`, 100);
    insertReading('10.0.0.2', `${old} 12:00:00`, 110);
    insertReading('10.0.0.2', `${old} 16:00:00`, 120);
    const before = db.prepare(`SELECT COUNT(*) c FROM printer_readings WHERE printer_ip='10.0.0.2'`).get().c;
    assert.strictEqual(before, 3);

    const { deleted } = readings.pruneReadings(90);
    assert.strictEqual(deleted, 2); // günün son kaydı kalır

    const rows = db.prepare(`SELECT total_printed FROM printer_readings WHERE printer_ip='10.0.0.2'`).all();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].total_printed, 120);
});

test('pruneReadings: yeni kayıtlara dokunmaz', { skip: !nativeOk }, () => {
    insertReading('10.0.0.3', new Date().toISOString().replace('T', ' ').slice(0, 19), 42);
    readings.pruneReadings(90);
    const c = db.prepare(`SELECT COUNT(*) c FROM printer_readings WHERE printer_ip='10.0.0.3'`).get().c;
    assert.strictEqual(c, 1);
});

test('pruneReadings: 0 veya negatif gün hiçbir şey silmez', { skip: !nativeOk }, () => {
    assert.deepStrictEqual(readings.pruneReadings(0), { deleted: 0 });
});
