// node --test ile çalışır: npm test
// snmp-query.js saf yardımcıları — cihazdan okunmayan hiçbir değerin
// uydurulmadığını doğrular. Ağ/SNMP bağımlılığı yoktur.
const { test } = require('node:test');
const assert = require('node:assert');
const { tonerPercent, detectPrinterType, detectTonerColor, selectToners } = require('../snmp-query');

// ============================================
// tonerPercent — RFC 3805 prtMarkerSupplies
// ============================================

test('tonerPercent: normal seviye/kapasite yüzdeye çevrilir', () => {
    assert.strictEqual(tonerPercent({ currentLevel: 50, maxCapacity: 200 }), 25);
    assert.strictEqual(tonerPercent({ currentLevel: 100, maxCapacity: 100 }), 100);
    assert.strictEqual(tonerPercent({ currentLevel: 0, maxCapacity: 100 }), 0);
});

test('tonerPercent: kapasite hiç gelmezse 100 VARSAYILMAZ', () => {
    // Regresyon: `supply.maxCapacity || 100` ile kapasite bilinmiyorken 100
    // kabul ediliyordu; seviyesi 40 birim olan bir kartuş "%40 dolu" diye
    // gösteriliyordu, oysa gerçek kapasite 400 de olabilirdi.
    assert.strictEqual(tonerPercent({ currentLevel: 40 }), -1);
    assert.strictEqual(tonerPercent({ currentLevel: 40, maxCapacity: null }), -1);
    assert.strictEqual(tonerPercent({ currentLevel: 40, maxCapacity: 0 }), -1);
});

test('tonerPercent: maxCapacity -2 (unknown) ham birimi yüzde diye döndürmez', () => {
    // Regresyon: -2 || 100 → -2, ardından `max > 0` yanlış olunca kod
    // `percent = current` yoluna düşüyordu. 4200 birim bildiren bir kartuş
    // 0-100 kırpması sonrası "%100 dolu" görünüyordu.
    assert.strictEqual(tonerPercent({ currentLevel: 4200, maxCapacity: -2 }), -1);
    assert.strictEqual(tonerPercent({ currentLevel: 4200, maxCapacity: -1 }), -1);
});

test('tonerPercent: negatif seviye kodları bilinmiyor demektir, boş değil', () => {
    // -1 other, -2 unknown, -3 "bir miktar var ama seviye bilinmiyor".
    // Bunları 0 saymak yanlış "Düşük Toner" alarmı üretiyordu (Canon MF serisi
    // tüm tonerleri için -2 bildirir).
    for (const kod of [-1, -2, -3]) {
        assert.strictEqual(tonerPercent({ currentLevel: kod, maxCapacity: 100 }), -1);
    }
});

test('tonerPercent: 0-100 aralığına kırpar', () => {
    assert.strictEqual(tonerPercent({ currentLevel: 150, maxCapacity: 100 }), 100);
});

test('tonerPercent: sayı olmayan girdi bilinmiyor döner', () => {
    assert.strictEqual(tonerPercent({ currentLevel: '50', maxCapacity: 100 }), -1);
    assert.strictEqual(tonerPercent({}), -1);
    assert.strictEqual(tonerPercent(null), -1);
});

// ============================================
// detectPrinterType — sysDescr metninden
// ============================================

test('detectPrinterType: eşleşme yoksa "laser" VARSAYMAZ', () => {
    // Regresyon: type 'laser' ile başlıyor ve yalnızca inkjet/deskjet/pixma
    // eşleşirse değişiyordu; yani tanınmayan HER cihaz arayüzde "Lazer" yazıyordu.
    assert.strictEqual(detectPrinterType('Brother DCP-7040'), '');
    assert.strictEqual(detectPrinterType(''), '');
    assert.strictEqual(detectPrinterType(undefined), '');
});

test('detectPrinterType: metin açıkça söylüyorsa belirler', () => {
    assert.strictEqual(detectPrinterType('HP LaserJet Pro M402dn'), 'laser');
    assert.strictEqual(detectPrinterType('Canon PIXMA G3411'), 'inkjet');
    assert.strictEqual(detectPrinterType('EPSON EcoTank L3150'), 'inkjet');
    assert.strictEqual(detectPrinterType('HP OfficeJet Pro 9010'), 'inkjet');
});

// ============================================
// detectTonerColor
// ============================================

test('detectTonerColor: renk çıkmazsa null döner (black varsaymaz)', () => {
    assert.strictEqual(detectTonerColor('Toner Cartridge'), null);
    assert.strictEqual(detectTonerColor('Staple Cartridge'), null);
    assert.strictEqual(detectTonerColor(''), null);
});

test('detectTonerColor: EN ve TR renk adlarını tanır', () => {
    assert.strictEqual(detectTonerColor('Black Toner'), 'black');
    assert.strictEqual(detectTonerColor('Siyah Toner'), 'black');
    assert.strictEqual(detectTonerColor('Cyan Toner'), 'cyan');
    assert.strictEqual(detectTonerColor('Sarı Toner'), 'yellow');
});

// ============================================
// selectToners — prtMarkerSupplies satır seçimi
//
// Aşağıdaki iki fikstür UYDURMA DEĞİLDİR: gerçek cihazlardan snmpwalk ile
// okunmuş prtMarkerSupplies tablolarıdır (1.3.6.1.2.1.43.11.1.1).
// ============================================

// Samsung SL-M3825ND — HER kalemi "type=3 (toner)" diye bildiriyor.
const SAMSUNG_SL_M3825ND = {
    1: { type: 3, cur: 4900, max: 5000, desc: 'Black Toner Cartridge S/N:CRUM-17101402200' },
    2: { type: 3, cur: 30000, max: 30000, desc: 'Black Imaging Unit (OPC Unit) S/N:CRUM-13051473410' },
    3: { type: 3, cur: 6309, max: 90000, desc: 'Fuser' },
    4: { type: 3, cur: 16309, max: 100000, desc: 'Transfer Roller' },
    5: { type: 3, cur: 94195, max: 100000, desc: 'MP Roller' },
    6: { type: 3, cur: 74195, max: 80000, desc: 'MP Retard Roller' },
    7: { type: 3, cur: 12114, max: 90000, desc: 'Tray 1 Roller' },
    8: { type: 3, cur: -3, max: 60000, desc: 'Tray 1 Retard Roller' },
};

// Konica Minolta bizhub C257i — zımba kartuşunu da "type=3" bildiriyor.
const KONICA_BIZHUB_C257I = {
    1: { type: 3, cur: 77, max: 100, desc: 'Toner (Cyan)' },
    2: { type: 3, cur: 73, max: 100, desc: 'Toner (Magenta)' },
    3: { type: 3, cur: 76, max: 100, desc: 'Toner (Yellow)' },
    4: { type: 3, cur: 100, max: 100, desc: 'Toner (Black)' },
    10: { type: 4, cur: -3, max: -2, desc: 'Waste Toner Box' },
    15: { type: 3, cur: -3, max: -2, desc: 'Saddle Staple Cartridge1' },
    16: { type: 3, cur: -3, max: -2, desc: 'Saddle Staple Cartridge2' },
};

// Test fikstürlerini modülün beklediği alan adlarına çevirir.
const asSupplies = (f) => Object.fromEntries(Object.entries(f).map(([i, v]) =>
    [i, { type: v.type, currentLevel: v.cur, maxCapacity: v.max, description: v.desc }]));

test('selectToners: drum "Black" içerse bile gerçek tonerin üzerine yazmaz', () => {
    // Regresyon (sahada ölçüldü): "Black Toner Cartridge" (%98) ve "Black
    // Imaging Unit (OPC Unit)" (%100) aynı 'black' rengine eşleşiyor. Döngüde
    // SONRAKİ kazandığı için cihaz "%100 dolu" görünüyordu; kartuş boşaldıkça
    // fark büyüyerek düşük toner uyarısını tamamen susturuyordu.
    const { toner, color } = selectToners(asSupplies(SAMSUNG_SL_M3825ND));
    assert.deepStrictEqual(toner, { black: 98 }, 'drum değil, gerçek toner raporlanmalı');
    assert.strictEqual(color, false, 'yalnızca siyah toner var → siyah-beyaz');
});

test('selectToners: fuser/silindir/drum toner sayılmaz', () => {
    const { toner } = selectToners(asSupplies(SAMSUNG_SL_M3825ND));
    // %7 fuser, %16 transfer roller, %13 tray roller hiçbiri toner değil.
    assert.deepStrictEqual(Object.keys(toner), ['black']);
});

test('selectToners: bizhub CMYK doğru okunur, zımba ve atık kutusu elenir', () => {
    const { toner, color } = selectToners(asSupplies(KONICA_BIZHUB_C257I));
    assert.deepStrictEqual(toner, { cyan: 77, magenta: 73, yellow: 76, black: 100 });
    assert.strictEqual(color, true);
});

test('selectToners: tek renksiz kalem siyah sayılır, birden fazlaysa sayılmaz', () => {
    const tek = selectToners({ 1: { type: 3, currentLevel: 40, maxCapacity: 100, description: 'Toner Cartridge' } });
    assert.deepStrictEqual(tek.toner, { black: 40 });

    // İki renksiz kalem: hangisinin toner olduğu belirsiz → iddiada bulunma
    const iki = selectToners({
        1: { type: 3, currentLevel: 40, maxCapacity: 100, description: 'Cartridge A' },
        2: { type: 3, currentLevel: 90, maxCapacity: 100, description: 'Cartridge B' },
    });
    assert.deepStrictEqual(iki.toner, { black: -1 }, 'belirsizse bilinmiyor');
});

test('selectToners: boş tablo bilinmiyor döner, renk iddiası yapmaz', () => {
    const { toner, color } = selectToners({});
    assert.deepStrictEqual(toner, { black: -1 });
    assert.strictEqual(color, null, 'tablo okunamadıysa renkli/siyah-beyaz denemez');
});
