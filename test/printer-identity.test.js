// node --test ile çalışır: npm test
const { test } = require('node:test');
const assert = require('node:assert');
const { identityKeys, mergeScanResults, pruneStalePrinters } = require('../printer-identity');

const NOW = '2026-08-06T12:00:00.000Z';

// Tarama sonucu üretir (queryPrinter çıktısının ilgili alanları)
function sonuc(ip, extra = {}) {
    return {
        ip, name: `Yazıcı (${ip})`, model: 'Test', status: 'online',
        statusText: 'Çevrim İçi', serialNumber: '', mac: '',
        toner: { black: 50 }, openPorts: [9100], snmpAvailable: true, ...extra
    };
}

// ============================================
// identityKeys — kimlik önceliği
// ============================================

test('identityKeys: seri no > MAC > IP sırasını korur', () => {
    assert.deepStrictEqual(
        identityKeys({ ip: '10.0.0.5', mac: 'AA:BB:CC:DD:EE:FF', serialNumber: 'cnx123' }),
        ['sn:CNX123', 'mac:aa:bb:cc:dd:ee:ff', 'ip:10.0.0.5']);
});

test('identityKeys: sıfır MAC kimlik sayılmaz', () => {
    assert.deepStrictEqual(
        identityKeys({ ip: '10.0.0.5', mac: '00:00:00:00:00:00' }),
        ['ip:10.0.0.5']);
});

test('identityKeys: kimlik yoksa IP son çare olarak kalır', () => {
    assert.deepStrictEqual(identityKeys({ ip: '10.0.0.5' }), ['ip:10.0.0.5']);
});

// ============================================
// mergeScanResults — asıl hata: her taramada listenin büyümesi
// ============================================

test('aynı yazıcı aynı IP ile yeniden bulunursa liste büyümez', () => {
    const once = mergeScanResults([], [sonuc('10.0.0.5', { serialNumber: 'SN1' })], null, NOW);
    const sonra = mergeScanResults(once, [sonuc('10.0.0.5', { serialNumber: 'SN1' })], null, NOW);
    assert.strictEqual(sonra.length, 1);
});

test('DHCP ile IP değişen yazıcı ikinci kayıt AÇMAZ (asıl hata)', () => {
    const once = mergeScanResults([], [sonuc('10.0.0.5', { serialNumber: 'SN1' })], null, NOW);

    const degisimler = [];
    const sonra = mergeScanResults(once, [sonuc('10.0.0.9', { serialNumber: 'SN1' })],
        (eski, yeni) => degisimler.push([eski, yeni]), NOW);

    assert.strictEqual(sonra.length, 1, 'IP değişimi yeni kayıt açmamalı');
    assert.strictEqual(sonra[0].ip, '10.0.0.9', 'kayıt yeni IP ile güncellenmeli');
    assert.deepStrictEqual(degisimler, [['10.0.0.5', '10.0.0.9']],
        'yan tabloların taşınması için IP değişimi bildirilmeli');
});

test('seri no yokken MAC ile eşleşir', () => {
    const once = mergeScanResults([], [sonuc('10.0.0.5', { mac: 'AA:BB:CC:00:11:22' })], null, NOW);
    const sonra = mergeScanResults(once, [sonuc('10.0.0.7', { mac: 'aa:bb:cc:00:11:22' })], null, NOW);

    assert.strictEqual(sonra.length, 1);
    assert.strictEqual(sonra[0].ip, '10.0.0.7');
});

test('SNMP cevap vermeyen tarama kimliği kaybetmez', () => {
    // Aksi halde cihaz bir sonraki taramada "yeni" sayılıp listeyi büyütürdü
    const once = mergeScanResults([],
        [sonuc('10.0.0.5', { serialNumber: 'SN1', mac: 'AA:BB:CC:00:11:22' })], null, NOW);

    const snmpsiz = mergeScanResults(once,
        [sonuc('10.0.0.5', { serialNumber: '', mac: '', snmpAvailable: false })], null, NOW);
    assert.strictEqual(snmpsiz.length, 1);
    assert.strictEqual(snmpsiz[0].serialNumber, 'SN1', 'eski seri no korunmalı');
    assert.strictEqual(snmpsiz[0].mac, 'AA:BB:CC:00:11:22', 'eski MAC korunmalı');

    // Kimlik korunduğu için sonraki IP değişimi hâlâ eşleşir
    const sonra = mergeScanResults(snmpsiz, [sonuc('10.0.0.9', { serialNumber: 'SN1' })], null, NOW);
    assert.strictEqual(sonra.length, 1);
});

test('gerçekten yeni bir cihaz listeye eklenir', () => {
    const once = mergeScanResults([], [sonuc('10.0.0.5', { serialNumber: 'SN1' })], null, NOW);
    const sonra = mergeScanResults(once, [
        sonuc('10.0.0.5', { serialNumber: 'SN1' }),
        sonuc('10.0.0.6', { serialNumber: 'SN2' })
    ], null, NOW);

    assert.strictEqual(sonra.length, 2);
    assert.deepStrictEqual(sonra.map(p => p.id), [1, 2]);
});

test('bulunamayan yazıcı çevrim dışı olarak korunur (silinmez)', () => {
    const once = mergeScanResults([], [sonuc('10.0.0.5', { serialNumber: 'SN1' })], null, NOW);
    const sonra = mergeScanResults(once, [], null, NOW);

    assert.strictEqual(sonra.length, 1);
    assert.strictEqual(sonra[0].status, 'offline');
    assert.strictEqual(sonra[0].statusText, 'Çevrim Dışı');
});

test('aynı MAC iki farklı IP: ikincisi ayrı kayıt olur (çift arayüz)', () => {
    const once = mergeScanResults([], [sonuc('10.0.0.5', { mac: 'AA:BB:CC:00:11:22' })], null, NOW);
    const sonra = mergeScanResults(once, [
        sonuc('10.0.0.5', { mac: 'AA:BB:CC:00:11:22' }),
        sonuc('10.0.0.6', { mac: 'AA:BB:CC:00:11:22' })
    ], null, NOW);

    // Bir önceki kayıt yalnızca bir sonuca eşleşir; ikincisi tüketilmiş sayılmaz
    assert.strictEqual(sonra.length, 2);
});

test('firstSeen ilk keşifte sabitlenir, lastOnline her eşleşmede tazelenir', () => {
    const once = mergeScanResults([], [sonuc('10.0.0.5', { serialNumber: 'SN1' })], null, NOW);
    assert.strictEqual(once[0].firstSeen, NOW);

    const SONRA_ZAMAN = '2026-08-07T12:00:00.000Z';
    const sonra = mergeScanResults(once, [sonuc('10.0.0.5', { serialNumber: 'SN1' })], null, SONRA_ZAMAN);
    assert.strictEqual(sonra[0].firstSeen, NOW, 'ilk görülme değişmemeli');
    assert.strictEqual(sonra[0].lastOnline, SONRA_ZAMAN);
});

test('id alanı her birleştirmede 1..n olarak yeniden numaralanır', () => {
    const liste = mergeScanResults([], [sonuc('10.0.0.5'), sonuc('10.0.0.6'), sonuc('10.0.0.7')], null, NOW);
    assert.deepStrictEqual(liste.map(p => p.id), [1, 2, 3]);
});

// ============================================
// pruneStalePrinters — eskiyen kayıtların budanması
// ============================================

const T0 = Date.parse('2026-08-06T12:00:00.000Z');
const gunOnce = (n) => new Date(T0 - n * 86400000).toISOString();

test('budama: eşikten eski kayıt düşer, yenisi kalır', () => {
    const { kept, dropped } = pruneStalePrinters([
        { ip: '10.0.0.5', lastOnline: gunOnce(1) },
        { ip: '10.0.0.6', lastOnline: gunOnce(60) }
    ], 30, T0);

    assert.deepStrictEqual(kept.map(p => p.ip), ['10.0.0.5']);
    assert.deepStrictEqual(dropped.map(p => p.ip), ['10.0.0.6']);
    assert.deepStrictEqual(kept.map(p => p.id), [1], 'kalanlar yeniden numaralanmalı');
});

test('budama: 0 gün = kapalı, hiçbir şey silinmez', () => {
    const liste = [{ ip: '10.0.0.6', lastOnline: gunOnce(9999) }];
    const { kept, dropped } = pruneStalePrinters(liste, 0, T0);

    assert.strictEqual(kept, liste, 'kapalıyken liste olduğu gibi dönmeli');
    assert.deepStrictEqual(dropped, []);
});

test('budama: lastOnline okunamıyorsa kayıt korunur', () => {
    // Bu kolondan önceki kurulumlardan gelen kayıtlar ilk çalıştırmada silinmesin
    const { kept, dropped } = pruneStalePrinters([
        { ip: '10.0.0.5' },
        { ip: '10.0.0.6', lastOnline: '' },
        { ip: '10.0.0.7', lastOnline: 'Bağlantı hatası' }
    ], 30, T0);

    assert.strictEqual(kept.length, 3);
    assert.deepStrictEqual(dropped, []);
});

test('budama: eşiğin tam sınırındaki kayıt korunur', () => {
    const { dropped } = pruneStalePrinters([{ ip: '10.0.0.5', lastOnline: gunOnce(30) }], 30, T0);
    assert.deepStrictEqual(dropped, []);
});
