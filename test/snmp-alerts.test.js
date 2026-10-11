// node --test ile çalışır: npm test
const { test } = require('node:test');
const assert = require('node:assert');
const { parseAlertTable, parsePrinterErrors, OID } = require('../snmp-query');

// prtAlertEntry OID'i üretir: <alertSubtree>.{sutun}.{prtGeneralIndex}.{alertIndex}
function vb(sutun, alertIndex, value) {
    return { oid: `${OID.alertSubtree}.${sutun}.1.${alertIndex}`, value };
}

// Tek bir uyarı satırını dört sütunuyla kurar.
// sutunlar: 2=severity, 3=trainingLevel, 7=code, 8=description
function uyari(index, { severity, training, code, description } = {}) {
    const rows = [];
    if (severity !== undefined) rows.push(vb('2', index, severity));
    if (training !== undefined) rows.push(vb('3', index, training));
    if (code !== undefined) rows.push(vb('7', index, code));
    if (description !== undefined) rows.push(vb('8', index, Buffer.from(description, 'utf8')));
    return rows;
}

// ============================================
// parseAlertTable — şiddet ve müdahale seviyesi
// ============================================

test('critical + fieldService gerçek servis çağrısıdır', () => {
    const [a] = parseAlertTable(uyari(1, { severity: 3, training: 5, code: 1004 }));
    assert.strictEqual(a.seviye, 'error');
    assert.strictEqual(a.mudahale, 'fieldService');
    assert.strictEqual(a.mesaj, 'Fuser Termistör Arızası');
    assert.strictEqual(a.olay, false);
});

test('warning + untrained kullanıcının çözeceği iştir, error değil', () => {
    const [a] = parseAlertTable(uyari(1, { severity: 4, training: 3, code: 1104 }));
    assert.strictEqual(a.seviye, 'warning');
    assert.strictEqual(a.mudahale, 'untrained');
    assert.strictEqual(a.mesaj, 'Toner Azaldı');
});

test('cihazın kendi açıklaması kod tablosunu ezer', () => {
    const [a] = parseAlertTable(uyari(1, {
        severity: 4, training: 3, code: 1104, description: 'Tepsi 2: Sarı toner %8'
    }));
    assert.strictEqual(a.mesaj, 'Tepsi 2: Sarı toner %8');
});

test('açıklama boşsa kod tablosuna, o da yoksa ham koda düşer', () => {
    const [bos] = parseAlertTable(uyari(1, { severity: 4, code: 1104, description: '' }));
    assert.strictEqual(bos.mesaj, 'Toner Azaldı');

    const [bilinmeyen] = parseAlertTable(uyari(2, { severity: 4, code: 4242 }));
    assert.strictEqual(bilinmeyen.mesaj, 'Uyarı kodu 4242');
});

test('noInterventionRequired uyarıları hiç listelenmez', () => {
    const alerts = parseAlertTable(uyari(1, { severity: 4, training: 7, code: 507 }));
    assert.deepStrictEqual(alerts, []);
});

test('binaryChangeEvent kalıcı arıza değil, olay olarak işaretlenir', () => {
    const [a] = parseAlertTable(uyari(1, { severity: 5, training: 3, code: 503 }));
    assert.strictEqual(a.olay, true);
    assert.strictEqual(a.agirlik, 0, 'geçmiş olay rozeti belirlememeli');
});

test('şiddet ve kod birlikte eksikse satır atılır', () => {
    assert.deepStrictEqual(parseAlertTable(uyari(1, { training: 3 })), []);
});

test('şiddet gelmezse warning varsayılır (error değil)', () => {
    const [a] = parseAlertTable(uyari(1, { code: 8 }));
    assert.strictEqual(a.seviye, 'warning');
    assert.strictEqual(a.mesaj, 'Kağıt Sıkışması');
});

// ============================================
// Sıralama — rozete hangi uyarı çıkar
// ============================================

test('sıralama: servis çağrısı > kritik > uyarı > geçmiş olay', () => {
    const rows = [
        ...uyari(1, { severity: 5, training: 3, code: 503 }),   // geçmiş olay
        ...uyari(2, { severity: 4, training: 3, code: 1104 }),  // uyarı
        ...uyari(3, { severity: 3, training: 5, code: 1004 }),  // servis
        ...uyari(4, { severity: 3, training: 3, code: 8 })      // kritik, kullanıcı
    ];
    assert.deepStrictEqual(
        parseAlertTable(rows).map(a => a.mesaj),
        ['Fuser Termistör Arızası', 'Kağıt Sıkışması', 'Toner Azaldı', 'Cihaz Açıldı']);
});

test('çok sayıda uyarı MAX_ALERTS ile sınırlanır', () => {
    const rows = [];
    for (let i = 1; i <= 120; i++) rows.push(...uyari(i, { severity: 4, code: 1104 }));
    assert.strictEqual(parseAlertTable(rows).length, 50);
});

test('MAX_ALERTS kırpması EN KRİTİK uyarıyı atmaz (sıralamadan sonra kırpılır)', () => {
    // Regresyon: kırpma ham anahtar listesine uygulanıyordu. JS tam-sayı
    // benzeri anahtarları artan sırada döndürdüğü için index 1-50 tutulup
    // üstü atılıyordu. Birçok üretici prtAlertIndex'i döngüsel günlük gibi
    // kullanır — yani atılanlar tam olarak en yeni kayıtlardı. 60 tane
    // "Cihaz Açıldı" olayının ardından index 61'de gelen fuser arızası hiç
    // görünmüyordu.
    const rows = [];
    for (let i = 1; i <= 60; i++) rows.push(...uyari(i, { severity: 5, code: 503 })); // binaryChangeEvent
    rows.push(...uyari(61, { severity: 3, training: 5, code: 1004 }));                // critical + fieldService

    const uyarilar = parseAlertTable(rows);
    assert.strictEqual(uyarilar.length, 50);
    assert.strictEqual(uyarilar[0].mudahale, 'fieldService', 'servis çağrısı en üstte olmalı');
    assert.strictEqual(uyarilar[0].kod, 1004);
    assert.ok(uyarilar.some(u => u.kod === 1004), 'kritik uyarı kırpmada düşmemeli');
});

test('aynı alertIndex farklı hrDeviceIndex altında ayrı uyarıdır', () => {
    // Regresyon: gruplama anahtarı yalnızca son OID bileşeniydi. Çok fonksiyonlu
    // bir cihazın iki alt-yazıcısındaki 1 numaralı uyarılar (…1.2.1.1 ve
    // …1.2.2.1) tek kovaya düşüp birbirinin şiddet/kod değerini eziyordu.
    const cihaz = (dev, alertIndex, sutun, value) =>
        ({ oid: `${OID.alertSubtree}.${sutun}.${dev}.${alertIndex}`, value });

    const rows = [
        cihaz(1, 1, '2', 4), cihaz(1, 1, '7', 1104),   // cihaz 1: warning, Toner Azaldı
        cihaz(2, 1, '2', 3), cihaz(2, 1, '7', 8),      // cihaz 2: critical, Kağıt Sıkışması
    ];

    const uyarilar = parseAlertTable(rows);
    assert.strictEqual(uyarilar.length, 2, 'iki ayrı satır olmalı, biri diğerini ezmemeli');
    assert.deepStrictEqual(uyarilar.map(u => u.kod).sort((a, b) => a - b), [8, 1104]);
});

// ============================================
// Bit dizisi — alert tablosu yokken kullanılan yedek kaynak
// ============================================

test('parsePrinterErrors: bit 7 serviceRequested olarak okunur', () => {
    // 0b00000001 → bit 7 (ilk baytın en anlamsız biti)
    const errors = parsePrinterErrors(Buffer.from([0b00000001, 0x00]));
    assert.deepStrictEqual(errors.map(e => e.mesaj), ['Servis Gerekiyor']);
});

test('parsePrinterErrors: bit sırası RFC 3805 ile uyumlu (MSB önce)', () => {
    // 0b10100000 → bit 0 (lowPaper) + bit 2 (lowToner)
    const errors = parsePrinterErrors(Buffer.from([0b10100000, 0x00]));
    assert.deepStrictEqual(errors.map(e => e.mesaj), ['Kağıt Azaldı', 'Toner Azaldı']);
});

test('parsePrinterErrors: tek baytlık cevapta taşma olmaz', () => {
    // 0b00000100 → bit 5 (jammed); ikinci bayt hiç gelmese de patlamamalı
    const errors = parsePrinterErrors(Buffer.from([0b00000100]));
    assert.deepStrictEqual(errors.map(e => e.mesaj), ['Kağıt Sıkışması']);
});

test('parsePrinterErrors: boş değer uyarı üretmez', () => {
    assert.deepStrictEqual(parsePrinterErrors(null), []);
    assert.deepStrictEqual(parsePrinterErrors(Buffer.alloc(0)), []);
});
