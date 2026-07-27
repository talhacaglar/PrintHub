// Bearer token tabanlı kimlik doğrulama testleri.
// Jeton üretimi, doğrulama, süre dolumu ve iptal senaryolarını kapsar.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

// db.js modül yüklenirken DB yolunu okur — require'dan ÖNCE ayarla
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'printhub-auth-'));
process.env.PRINTHUB_DB_PATH = path.join(TMP_DIR, 'test.db');

const { db } = require('../db');
const auth = require('../auth');

// Test kullanıcısı (jeton katmanı parolaya bakmaz)
const USER_ID = db.prepare(
    `INSERT INTO app_users (username, password_hash, role, must_change_password) VALUES (?, ?, ?, 0)`
).run('tokentest', 'x', 'operator').lastInsertRowid;

// Sahte istek nesnesi
const reqWith = (token, session) => ({
    headers: token ? { authorization: `Bearer ${token}` } : {},
    session: session || null
});

test('issueToken ham jetonu döndürür, DB’de yalnızca SHA-256 özeti saklanır', () => {
    const { token, expiresAt } = auth.issueToken(USER_ID, '127.0.0.1');

    assert.match(token, /^[0-9a-f]{64}$/); // 32 bayt hex
    assert.ok(expiresAt, 'son kullanma tarihi dönmeli');

    // Ham jeton düz metin olarak saklanmamalı
    const row = db.prepare('SELECT * FROM auth_tokens WHERE token_hash = ?').get(auth.hashToken(token));
    assert.ok(row, 'jeton kaydı özet ile bulunmalı');
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM auth_tokens WHERE token_hash = ?').get(token).c, 0);
    assert.strictEqual(row.user_id, USER_ID);
});

test('extractBearer Authorization başlığını çözer', () => {
    assert.strictEqual(auth.extractBearer({ headers: { authorization: 'Bearer abc123' } }), 'abc123');
    assert.strictEqual(auth.extractBearer({ headers: { authorization: 'bearer abc123' } }), 'abc123');
    assert.strictEqual(auth.extractBearer({ headers: {} }), null);
    assert.strictEqual(auth.extractBearer({ headers: { authorization: 'Basic abc' } }), null);
});

test('geçerli jeton kullanıcıyı çözer ve last_used_at günceller', () => {
    const { token } = auth.issueToken(USER_ID, '127.0.0.1');
    const user = auth.resolveTokenUser(reqWith(token));

    assert.ok(user, 'kullanıcı çözülmeli');
    assert.strictEqual(user.username, 'tokentest');
    assert.strictEqual(user.role, 'operator');
    assert.strictEqual(user.mustChangePassword, false);

    const row = db.prepare('SELECT last_used_at FROM auth_tokens WHERE token_hash = ?').get(auth.hashToken(token));
    assert.ok(row.last_used_at, 'last_used_at damgalanmalı');
});

test('geçersiz / eksik jeton reddedilir', () => {
    assert.strictEqual(auth.resolveTokenUser(reqWith(crypto.randomBytes(32).toString('hex'))), null);
    assert.strictEqual(auth.resolveTokenUser(reqWith(null)), null);
});

test('süresi dolmuş jeton reddedilir ve temizlenir', () => {
    const { token } = auth.issueToken(USER_ID, '127.0.0.1');
    db.prepare("UPDATE auth_tokens SET expires_at = datetime('now', '-1 hour') WHERE token_hash = ?")
        .run(auth.hashToken(token));

    assert.strictEqual(auth.resolveTokenUser(reqWith(token)), null);
    const left = db.prepare('SELECT COUNT(*) c FROM auth_tokens WHERE token_hash = ?').get(auth.hashToken(token)).c;
    assert.strictEqual(left, 0, 'süresi dolan jeton DB’den silinmeli');
});

test('revokeToken tek jetonu iptal eder, diğerleri etkilenmez', () => {
    const a = auth.issueToken(USER_ID, '127.0.0.1').token;
    const b = auth.issueToken(USER_ID, '127.0.0.1').token;

    assert.strictEqual(auth.revokeToken(a), true);
    assert.strictEqual(auth.resolveTokenUser(reqWith(a)), null);
    assert.ok(auth.resolveTokenUser(reqWith(b)), 'diğer jeton geçerli kalmalı');
    assert.strictEqual(auth.revokeToken(a), false); // ikinci iptal etkisiz

    auth.revokeAllTokensForUser(USER_ID);
});

test('revokeAllTokensForUser kullanıcının tüm jetonlarını düşürür', () => {
    const t1 = auth.issueToken(USER_ID, '127.0.0.1').token;
    const t2 = auth.issueToken(USER_ID, '127.0.0.1').token;

    assert.strictEqual(auth.revokeAllTokensForUser(USER_ID), 2);
    assert.strictEqual(auth.resolveTokenUser(reqWith(t1)), null);
    assert.strictEqual(auth.resolveTokenUser(reqWith(t2)), null);
});

test('currentUser jetonu çerez oturumuna tercih eder', () => {
    const { token } = auth.issueToken(USER_ID, '127.0.0.1');
    const req = reqWith(token, { user: { id: 999, username: 'cerez', role: 'viewer' } });

    assert.strictEqual(auth.currentUser(req).username, 'tokentest');
    auth.revokeAllTokensForUser(USER_ID);
});

test('currentUser jeton yoksa çerez oturumuna düşer (geriye dönük uyumluluk)', () => {
    const req = reqWith(null, { user: { id: 999, username: 'cerez', role: 'viewer' } });
    assert.strictEqual(auth.currentUser(req).username, 'cerez');
});

test('requireAuth jetonlu isteği geçirir, jetonsuzu 401 ile reddeder', () => {
    const { token } = auth.issueToken(USER_ID, '127.0.0.1');

    let passed = false;
    auth.requireAuth(reqWith(token), {}, () => { passed = true; });
    assert.strictEqual(passed, true);

    let code, body;
    const res = { status(c) { code = c; return this; }, json(b) { body = b; } };
    auth.requireAuth(reqWith(null), res, () => { throw new Error('geçmemeliydi'); });
    assert.strictEqual(code, 401);
    assert.match(body.error, /Oturum açılmamış/);

    auth.revokeAllTokensForUser(USER_ID);
});

test('requireRole jeton üzerinden rol seviyesini uygular', () => {
    const { token } = auth.issueToken(USER_ID, '127.0.0.1'); // operator

    let passed = false;
    auth.requireRole('viewer')({ ...reqWith(token), path: '/x' }, {}, () => { passed = true; });
    assert.strictEqual(passed, true, 'operator, viewer gerektiren ucu kullanabilmeli');

    let code;
    const res = { status(c) { code = c; return this; }, json() {} };
    auth.requireRole('admin')({ ...reqWith(token), path: '/x' }, res, () => { throw new Error('geçmemeliydi'); });
    assert.strictEqual(code, 403, 'operator, admin ucunda reddedilmeli');

    auth.revokeAllTokensForUser(USER_ID);
});

test('authenticate middleware req.authUser doldurur', () => {
    const { token } = auth.issueToken(USER_ID, '127.0.0.1');
    const req = reqWith(token);
    auth.authenticate(req, {}, () => {});

    assert.strictEqual(req.authUser.username, 'tokentest');
    auth.revokeAllTokensForUser(USER_ID);
});

test.after(() => {
    try { db.close(); } catch (e) { /* zaten kapalı */ }
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (e) { /* ok */ }
});
