// Toner Takip Excel dışa aktarma testleri.
// Geçici bir DB üzerinde örnek veri kurup üretilen çalışma kitabının
// orijinal Toner_Takip.xlsx yapısına uygunluğunu doğrular.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// db.js modül yüklenirken DB yolunu okur — require'dan ÖNCE ayarla
const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'printhub-test-')), 'test.db');
process.env.PRINTHUB_DB_PATH = TMP_DB;

const XLSX = require('xlsx');
const { db } = require('../db');
const { buildWorkbook, buildFileName, toExcelSerial } = require('../toner-export');

// --- Örnek veri ---
function seedFixture() {
    db.prepare(`INSERT INTO toner_types (id, name, color, printer_model, unit_cost, min_stock)
                VALUES (1, 'BROTHER TN-2355', 'black', 'DCP-7040 8070', 500, 2)`).run();
    db.prepare(`INSERT INTO toner_types (id, name, color, printer_model, unit_cost, min_stock)
                VALUES (2, 'HP CE285A', 'black', 'm254-m280-m281', 400, 1)`).run();
    // Tanınan dört markanın hiçbirine uymayan model — 'DİĞER' sütununa düşmeli
    db.prepare(`INSERT INTO toner_types (id, name, color, printer_model, unit_cost, min_stock)
                VALUES (3, 'Konica Minolta TN-227K', 'black', 'bizhub C257i', 4850, 2)`).run();

    db.prepare(`INSERT INTO known_printers (printer_ip, name, model) VALUES ('10.0.0.5', 'Muhasebe Yazıcı', 'DCP-7040')`).run();
    db.prepare(`INSERT INTO printer_assets (printer_ip, custom_location) VALUES ('10.0.0.5', 'Mali İşler')`).run();

    // supplier / recipient artık GERÇEK sütunlardır; not alanından türetilmez.
    const mv = db.prepare(`INSERT INTO stock_movements
        (toner_type_id, direction, quantity, unit_cost, printer_ip, note, actor, movement_date, supplier, recipient)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    // Girişler
    mv.run(1, 'in', 6, 500, null, 'fatura 123', 'admin', '2024-01-10', 'ABC Bilişim', '');
    mv.run(2, 'in', 4, 400, null, '', 'admin', '2024-02-01', 'XYZ Ofis', '');
    // Çıkışlar (toner değişimi) — aynı yazıcıya iki kez
    mv.run(1, 'out', 1, 500, '10.0.0.5', '', 'operator', '2024-03-01', '', 'Esra Serpan');
    mv.run(1, 'out', 1, 500, '10.0.0.5', '', 'operator', '2024-04-15', '', 'Esra Serpan');
    mv.run(2, 'out', 2, 400, null, '', 'operator', '2024-05-01', '', 'Ozan Kansu');
    // Tedarikçisi bilinmeyen giriş — FİRMA hücresi BOŞ kalmalı, uydurulmamalı
    mv.run(3, 'in', 3, 4850, null, 'depo sayımı', 'admin', '2024-06-01', '', '');
}
seedFixture();

const wb = XLSX.read(buildWorkbook().buffer, { type: 'buffer' });
const rowsOf = (name) => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });

test('sheet adları ve sırası orijinal Toner_Takip.xlsx ile aynı', () => {
    assert.deepStrictEqual(wb.SheetNames,
        ['Toner_Degisim', 'StokDurum', 'StokGirisCikis', 'Uyumluluk Tablosu', 'Sayfa1']);
});

test('Toner_Degisim başlıkları ve satırları doğru', () => {
    const rows = rowsOf('Toner_Degisim');
    assert.deepStrictEqual(rows[0],
        ['', 'Tarih', 'Departman', 'Alan Kişi', 'Toner Tipi', 'KaçGünSonraAldı']);

    // 1 + 1 + 2 = 4 değişim satırı (adet kadar satır açılır)
    assert.strictEqual(rows.length - 1, 4);

    // İlk çıkış: özel konum departman, recipient sütunu "Alan Kişi" olur
    assert.strictEqual(rows[1][2], 'Mali İşler');
    assert.strictEqual(rows[1][3], 'Esra Serpan');
    assert.strictEqual(rows[1][4], 'BROTHER TN-2355');
    assert.strictEqual(rows[1][5], 'ilk');

    // Tarih Excel seri numarası olarak yazılır
    assert.strictEqual(rows[1][1], toExcelSerial('2024-03-01'));

    // İkinci alım: aynı departman+kişi+toner → gün farkı hesaplanır
    assert.strictEqual(rows[2][5], toExcelSerial('2024-04-15') - toExcelSerial('2024-03-01'));
});

test('StokDurum giriş/çıkış/mevcut değerleri tutarlı', () => {
    const rows = rowsOf('StokDurum');
    assert.strictEqual(rows[0][0], 'TONER MODELİ');
    assert.strictEqual(rows[0][3], 'MEVCUT');
    assert.strictEqual(rows[0][9], 'SON KULLANIMDAN SONRA GEÇEN GÜN');

    const brother = rows.find(r => r[0] === 'BROTHER TN-2355');
    assert.strictEqual(brother[1], 6);           // giriş
    assert.strictEqual(brother[2], 2);           // çıkış
    assert.strictEqual(brother[3], 4);           // mevcut
    assert.strictEqual(brother[5], 2);           // toplam değişim adedi

    const hp = rows.find(r => r[0] === 'HP CE285A');
    assert.strictEqual(hp[3], 2);                // 4 giriş - 2 çıkış
});

test('StokGirisCikis yalnızca girişleri firma bilgisiyle listeler', () => {
    const rows = rowsOf('StokGirisCikis');
    assert.deepStrictEqual(rows[0], ['TONER MODELİ', 'FİRMA', 'ADET']);
    assert.strictEqual(rows.length - 1, 3);
    assert.deepStrictEqual(rows[1], ['BROTHER TN-2355', 'ABC Bilişim', 6]);
    assert.deepStrictEqual(rows[2], ['HP CE285A', 'XYZ Ofis', 4]);
});

test('tedarikçi bilinmiyorsa FİRMA hücresi boş kalır (nottan türetilmez)', () => {
    const rows = rowsOf('StokGirisCikis');
    const konica = rows.find(r => r[0] === 'Konica Minolta TN-227K');
    // Hareketin notu 'depo sayımı' — eskiden FİRMA sütununa o yazılır, o da
    // boşsa 'STOK GİRİŞİ' sabiti basılırdı. Artık bilinmeyen tedarikçi boştur.
    assert.deepStrictEqual(konica, ['Konica Minolta TN-227K', '', 3]);
});

test('Uyumluluk Tablosu markayı doğru sütuna yerleştirir', () => {
    // Orijinalde 1. satır boştur, başlıklar 2. satırdan başlar (dim A2:E8) —
    // bu yüzden satır dizisi yerine hücre referansıyla doğrulanır.
    const ws = wb.Sheets['Uyumluluk Tablosu'];
    const at = (ref) => (ws[ref] ? ws[ref].v : undefined);

    assert.strictEqual(at('A2'), 'TONER');
    assert.strictEqual(at('B2'), 'YAZICI MARKA MODEL');
    assert.deepStrictEqual(['B3', 'C3', 'D3', 'E3', 'F3'].map(at),
        ['HP', 'CANON', 'SAMSUNG', 'BROTHER', 'DİĞER']);

    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const brother = rows.find(r => r[0] === 'BROTHER TN-2355');
    assert.strictEqual(brother[4], 'DCP-7040 8070'); // BROTHER sütunu
    const hp = rows.find(r => r[0] === 'HP CE285A');
    assert.strictEqual(hp[1], 'm254-m280-m281');     // HP sütunu
});

test('tanınmayan marka HP sütununa değil DİĞER sütununa yazılır', () => {
    const ws = wb.Sheets['Uyumluluk Tablosu'];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const konica = rows.find(r => r[0] === 'Konica Minolta TN-227K');

    // Eskiden eşleşmeyen her model ilk sütuna (HP) yazılıyordu — yani bir
    // Konica Minolta, sipariş için kullanılacak belgede "HP uyumlu" görünüyordu.
    assert.strictEqual(konica[1], '', 'HP sütunu boş kalmalı');
    assert.strictEqual(konica[5], 'bizhub C257i', 'DİĞER sütununa yazılmalı');
});

test('Sayfa1 mevcut stok miktarlarını listeler', () => {
    const rows = rowsOf('Sayfa1');
    assert.deepStrictEqual(rows[0], ['TONER MODELİ', 'Miktar (adet)']);
    assert.deepStrictEqual(rows.find(r => r[0] === 'BROTHER TN-2355'), ['BROTHER TN-2355', 4]);
});

test('dosya adı Toner_Takip_YYYY-MM-DD_HHmm.xlsx biçiminde', () => {
    const name = buildFileName(new Date(2026, 6, 27, 9, 5));
    assert.strictEqual(name, 'Toner_Takip_2026-07-27_0905.xlsx');
});

test.after(() => {
    try { db.close(); } catch (e) { /* zaten kapalı */ }
    try { fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true }); } catch (e) { /* ok */ }
});
