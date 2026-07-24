// node --test ile çalışır: npm test
const { test } = require('node:test');
const assert = require('node:assert');
const { getSubnetsForCIDR } = require('../scanner');

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

test('/16 MAX_SUBNETS (16) ile sınırlanır', () => {
    const subnets = getSubnetsForCIDR('10.0.99.1', '16');
    assert.strictEqual(subnets.length, 16);
    assert.strictEqual(subnets[0], '10.0.0');
});

test('geçersiz IP boş dizi döndürür', () => {
    assert.deepStrictEqual(getSubnetsForCIDR('999.1.2.3', '24'), []);
    assert.deepStrictEqual(getSubnetsForCIDR('abc', '24'), []);
});

test('geçersiz CIDR /24 varsayılanına düşer', () => {
    assert.deepStrictEqual(getSubnetsForCIDR('192.168.1.5', 'xx'), ['192.168.1']);
});
