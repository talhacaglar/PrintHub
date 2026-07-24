// node --test ile çalışır: npm test
// ad-utils saf modüldür — db/ldap bağımlılığı yok.
const { test } = require('node:test');
const assert = require('node:assert');
const { fileTimeToISO, uacFlags, assertValidSam } = require('../ad-utils');

test('fileTimeToISO: bilinen FILETIME değerini doğru çevirir', () => {
    // 2024-01-01T00:00:00Z = (epoch ms 1704067200000 + 11644473600000) * 10000
    const ft = (1704067200000 + 11644473600000) * 10000;
    assert.strictEqual(fileTimeToISO(ft), '2024-01-01T00:00:00.000Z');
});

test('fileTimeToISO: 0 / boş değer boş string döndürür', () => {
    assert.strictEqual(fileTimeToISO(0), '');
    assert.strictEqual(fileTimeToISO(''), '');
    assert.strictEqual(fileTimeToISO(null), '');
});

test('uacFlags: devre dışı hesabı işaretler (0x2)', () => {
    assert.deepStrictEqual(uacFlags(514), { disabled: true, lockedOut: false }); // 512 | 2
    assert.deepStrictEqual(uacFlags(512), { disabled: false, lockedOut: false }); // normal hesap
});

test('uacFlags: kilitli hesabı işaretler (0x10)', () => {
    assert.deepStrictEqual(uacFlags(528), { disabled: false, lockedOut: true }); // 512 | 16
});

test('assertValidSam: geçerli sam kabul, enjeksiyon reddedilir', () => {
    assert.strictEqual(assertValidSam('john.doe'), 'john.doe');
    assert.throws(() => assertValidSam("x'; Remove-Item"));
    assert.throws(() => assertValidSam('a b'));
    assert.throws(() => assertValidSam(''));
});
