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

// ============================================
// recordReading — uydurma okuma yazmama
// ============================================

const sayim = (ip) =>
    db.prepare('SELECT COUNT(*) c FROM printer_readings WHERE printer_ip = ?').get(ip).c;

test('recordReading: SNMP yanıtsız cihaz için satır YAZMAZ', { skip: !nativeOk }, () => {
    // Regresyon: server.js recordAll'ı çevrim dışı yazıcılar dahil tüm listeyle
    // çağırıyor. Eskiden her yenilemede erişilemeyen her cihaz için
    // total_printed=0, toner {"black":-1} satırı ekleniyordu.
    readings.recordReading({
        ip: '10.9.9.1', name: 'Kapalı Yazıcı', snmpAvailable: false,
        totalPrinted: null, toner: { black: -1 }
    });
    assert.strictEqual(sayim('10.9.9.1'), 0);
});

test('recordReading: hiçbir ölçüm yoksa satır yazmaz', { skip: !nativeOk }, () => {
    readings.recordReading({
        ip: '10.9.9.2', name: 'Ölçümsüz', snmpAvailable: true,
        totalPrinted: 0, toner: { black: -1, cyan: -1 }
    });
    assert.strictEqual(sayim('10.9.9.2'), 0);
});

test('recordReading: bilinmeyen (-1) seviyeler JSON\'a girmez', { skip: !nativeOk }, () => {
    readings.recordReading({
        ip: '10.9.9.3', name: 'Kısmi', snmpAvailable: true,
        totalPrinted: 1200, toner: { black: 64, cyan: -1, magenta: -2 }
    });
    const row = db.prepare('SELECT total_printed, toner_json FROM printer_readings WHERE printer_ip = ?').get('10.9.9.3');
    assert.strictEqual(row.total_printed, 1200);
    assert.deepStrictEqual(JSON.parse(row.toner_json), { black: 64 });
});

test('recordReading: sayaç yoksa toner ölçümü tek başına kaydedilir (total NULL)', { skip: !nativeOk }, () => {
    readings.recordReading({
        ip: '10.9.9.4', name: 'Sayaçsız', snmpAvailable: true,
        totalPrinted: 0, toner: { black: 88 }
    });
    const row = db.prepare('SELECT total_printed, toner_json FROM printer_readings WHERE printer_ip = ?').get('10.9.9.4');
    assert.strictEqual(row.total_printed, null, 'sayaç okunamadıysa 0 değil NULL olmalı');
    assert.deepStrictEqual(JSON.parse(row.toner_json), { black: 88 });
});

// ============================================
// Kartuş değişimi & maliyet doğruluğu
// ============================================

test('getTonerUsageReport: -1 → 88 geçişi HAYALİ kartuş değişimi saymaz', { skip: !nativeOk }, () => {
    // Regresyon: -1 de bir sayı olduğu için 88 - (-1) = 89 >= 30 ve 88 >= 75
    // koşulları sağlanıyor, çevrim dışı olup dönen her yazıcı bir sahte kartuş
    // değişimi (ve maliyet) üretiyordu.
    const ym = new Date().toISOString().slice(0, 7);
    insertReading('10.9.8.1', `${ym}-05 08:00:00`, 5000, { black: -1 });
    insertReading('10.9.8.1', `${ym}-06 08:00:00`, 5010, { black: 88 });

    const report = readings.getTonerUsageReport();
    const p = report.byPrinter.find(x => x.ip === '10.9.8.1');
    assert.ok(p);
    assert.deepStrictEqual(p.replacements, {}, 'bilinmiyor→bilinen geçişi değişim değildir');
});

test('getTonerUsageReport: gerçek seviye sıçraması değişim sayar', { skip: !nativeOk }, () => {
    const ym = new Date().toISOString().slice(0, 7);
    insertReading('10.9.8.2', `${ym}-05 08:00:00`, 7000, { black: 8 });
    insertReading('10.9.8.2', `${ym}-06 08:00:00`, 7050, { black: 97 });

    const report = readings.getTonerUsageReport();
    const p = report.byPrinter.find(x => x.ip === '10.9.8.2');
    assert.strictEqual(p.replacements.black, 1);
});

// Rapor tüm veritabanı genelinde toplanır; bu yüzden önceki testlerin
// bıraktığı değişimlerden etkilenmemek için taban çizgisine göre karşılaştırılır.
test('maliyet: model eşleşmesi yoksa UYDURULMAZ, unpriced olarak sayılır', { skip: !nativeOk }, () => {
    // Regresyon: eskiden o renkteki İLK toner tipi kullanılıyordu, yani bir
    // Konica değişimi tabloda ilk sırada duran siyah tonerin fiyatıyla
    // faturalanıyordu.
    db.prepare(`INSERT INTO toner_types (name, color, printer_model, unit_cost, min_stock)
                VALUES ('HP CF287X', 'black', 'LaserJet M506', 7900, 2)`).run();

    const taban = readings.getTonerUsageReport();

    db.prepare(`INSERT INTO known_printers (printer_ip, name, model)
                VALUES ('10.9.7.1', 'Konica', 'KONICA MINOLTA bizhub C257i')`).run();
    const ym = new Date().toISOString().slice(0, 7);
    insertReading('10.9.7.1', `${ym}-05 08:00:00`, 9000, { black: 5 });
    insertReading('10.9.7.1', `${ym}-06 08:00:00`, 9020, { black: 99 });

    const report = readings.getTonerUsageReport();
    assert.strictEqual(report.byPrinter.find(x => x.ip === '10.9.7.1').replacements.black, 1);
    assert.strictEqual(report.unpricedReplacements - taban.unpricedReplacements, 1);
    assert.strictEqual(report.pricedReplacements - taban.pricedReplacements, 0);
    assert.strictEqual(report.estimatedCost - taban.estimatedCost, 0,
        'eşleşmeyen değişime, başka bir tonerin fiyatı yazılmamalı');
});

test('maliyet: model eşleşen değişim doğru birim maliyetle fiyatlanır', { skip: !nativeOk }, () => {
    const taban = readings.getTonerUsageReport();

    // Aynı Konica değişimi artık modeli eşleşen bir toner türü bulacak.
    db.prepare(`INSERT INTO toner_types (name, color, printer_model, unit_cost, min_stock)
                VALUES ('Konica TN-227K', 'black', 'bizhub C257i', 4850, 2)`).run();

    const report = readings.getTonerUsageReport();
    assert.strictEqual(report.pricedReplacements - taban.pricedReplacements, 1);
    assert.strictEqual(report.unpricedReplacements - taban.unpricedReplacements, -1);
    assert.strictEqual(report.estimatedCost - taban.estimatedCost, 4850,
        'HP CF287X (7900) değil, modeli eşleşen Konica (4850) kullanılmalı');
});
