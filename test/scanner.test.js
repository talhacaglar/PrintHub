// node --test ile çalışır: npm test
const { test } = require('node:test');
const assert = require('node:assert');
const { getSubnetsForCIDR, parseScanTargets, isValidIPv4 } = require('../scanner');

test('/24 tek subnet döndürür', () => {
    assert.deepStrictEqual(getSubnetsForCIDR('192.168.2.18', '24'), ['192.168.2']);
});

test('/22 hizalanmış 4 subnet döndürür', () => {
    assert.deepStrictEqual(getSubnetsForCIDR('192.168.2.18', '22'),
        ['192.168.0', '192.168.1', '192.168.2', '192.168.3']);
});

test('/23 2 subnet döndürür (genel CIDR aritmetiği)', () => {
    assert.deepStrictEqual(getSubnetsForCIDR('10.1.5.7', '23'), ['10.1.4', '10.1.5']);
});

test('/25 aynı /24 içinde kalır', () => {
    assert.deepStrictEqual(getSubnetsForCIDR('192.168.2.200', '25'), ['192.168.2']);
});

test('/21 8 subnet döndürür', () => {
    const subnets = getSubnetsForCIDR('172.16.13.1', '21');
    assert.strictEqual(subnets.length, 8);
    assert.strictEqual(subnets[0], '172.16.8');
    assert.strictEqual(subnets[7], '172.16.15');
});

test('/16 tam 256 subnet döndürür (artık kırpılmaz)', () => {
    const subnets = getSubnetsForCIDR('10.0.99.1', '16');
    assert.strictEqual(subnets.length, 256);
    assert.strictEqual(subnets[0], '10.0.0');
    assert.strictEqual(subnets[255], '10.0.255');
});

test('/8 tam 65536 subnet döndürür', () => {
    const subnets = getSubnetsForCIDR('10.5.99.1', '8');
    assert.strictEqual(subnets.length, 65536);
    assert.strictEqual(subnets[0], '10.0.0');
    assert.strictEqual(subnets[65535], '10.255.255');
});

test('/4 kabul edilir ve doğru ağ adresinden başlar', () => {
    const subnets = getSubnetsForCIDR('200.1.2.3', '4');
    assert.strictEqual(subnets.length, 1048576); // 2^20
    assert.strictEqual(subnets[0], '192.0.0');   // 200 & 0xF0 = 192
});

// Bozuk maske sessizce /24'e düşürülmez: kullanıcının istemediği bir aralığı
// taramak, hiç taramamaktan kötüdür. parseScanTargets zaten böyle davranıyordu;
// iki yol artık çelişmiyor.
test('/3 gibi çok geniş (MIN_CIDR altı) maske boş dizi döndürür', () => {
    assert.deepStrictEqual(getSubnetsForCIDR('10.1.2.3', '3'), []);
});

test('geçersiz IP boş dizi döndürür', () => {
    assert.deepStrictEqual(getSubnetsForCIDR('999.1.2.3', '24'), []);
    assert.deepStrictEqual(getSubnetsForCIDR('abc', '24'), []);
});

test('geçersiz CIDR boş dizi döndürür (sessizce /24 varsayılmaz)', () => {
    assert.deepStrictEqual(getSubnetsForCIDR('192.168.1.5', 'xx'), []);
    assert.deepStrictEqual(getSubnetsForCIDR('192.168.1.5', ''), []);
    assert.deepStrictEqual(getSubnetsForCIDR('192.168.1.5', '99'), []);
});

test('isValidIPv4 baştan sıfırlı ve boşluklu biçimleri reddeder', () => {
    assert.strictEqual(isValidIPv4('192.168.1.5'), true);
    assert.strictEqual(isValidIPv4('0.0.0.0'), true);
    assert.strictEqual(isValidIPv4('255.255.255.255'), true);
    assert.strictEqual(isValidIPv4('01.2.3.4'), false);   // baştan sıfır
    assert.strictEqual(isValidIPv4('192.168.1.5 '), false);
    assert.strictEqual(isValidIPv4('256.1.1.1'), false);
    assert.strictEqual(isValidIPv4('1.2.3'), false);
    assert.strictEqual(isValidIPv4('yazici.sirket.local'), false);
    assert.strictEqual(isValidIPv4(null), false);
});

// ============================================
// parseScanTargets — serbest hedef listesi
// Tek taban IP + maske yalnızca BİTİŞİK bir blok tarayabiliyordu; dağınık
// yazıcı VLAN'ları ancak bu listeyle kapsanabiliyor.
// ============================================

test('parseScanTargets: virgülle ayrılmış birden çok bitişik olmayan aralık', () => {
    assert.deepStrictEqual(
        parseScanTargets('192.168.2.0/24, 10.1.5.0/24'),
        ['192.168.2', '10.1.5']);
});

test('parseScanTargets: satır sonu ve noktalı virgül de ayırıcıdır', () => {
    assert.deepStrictEqual(
        parseScanTargets('192.168.2.0/24\n10.1.5.0/24;172.16.0.0/24'),
        ['192.168.2', '10.1.5', '172.16.0']);
});

test('parseScanTargets: maske yazılmazsa /24 varsayılır', () => {
    assert.deepStrictEqual(parseScanTargets('192.168.2.50'), ['192.168.2']);
});

test('parseScanTargets: geniş maske /24 öneklerine açılır', () => {
    assert.deepStrictEqual(
        parseScanTargets('172.16.8.0/22'),
        ['172.16.8', '172.16.9', '172.16.10', '172.16.11']);
});

test('parseScanTargets: çakışan aralıklar tekilleştirilir', () => {
    assert.deepStrictEqual(
        parseScanTargets('192.168.0.0/23, 192.168.1.0/24'),
        ['192.168.0', '192.168.1']);
});

test('parseScanTargets: bozuk maske o satırı atlar, diğerlerini bozmaz', () => {
    // Sessizce /24'e düşürüp yanlış aralık taramaktansa satırı atlamak güvenli
    assert.deepStrictEqual(
        parseScanTargets('192.168.2.0/abc, 10.1.5.0/24, 10.2.0.0/99'),
        ['10.1.5']);
});

test('parseScanTargets: geçersiz IP atlanır', () => {
    assert.deepStrictEqual(parseScanTargets('999.1.2.3/24, 10.1.5.0/24'), ['10.1.5']);
});

test('parseScanTargets: boş giriş boş dizi döndürür (tarama başlatılmamalı)', () => {
    assert.deepStrictEqual(parseScanTargets(''), []);
    assert.deepStrictEqual(parseScanTargets('  ,  \n '), []);
    assert.deepStrictEqual(parseScanTargets(null), []);
});
