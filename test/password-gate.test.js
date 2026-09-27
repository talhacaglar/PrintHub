const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'printhub-gate-'));
process.env.PRINTHUB_DB_PATH = path.join(tmp, 'test.db');
const { app } = require('../server');
const { db } = require('../db');

test('password change gate covers user administration and preserves login/change-password', async (t) => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => {
        await new Promise(resolve => server.close(resolve));
        db.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(base + '/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    assert.equal(login.status, 200);
    const { token } = await login.json();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    assert.equal((await fetch(base + '/api/me', { headers })).status, 200);
    assert.equal((await fetch(base + '/api/users', { headers })).status, 403);
    assert.equal((await fetch(base + '/api/users', {
        method: 'POST', headers, body: JSON.stringify({ username: 'bypass', password: 'x', role: 'admin' })
    })).status, 403);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM app_users').get().c, 1);
    const change = await fetch(base + '/api/change-password', {
        method: 'POST', headers,
        body: JSON.stringify({ currentPassword: 'admin123', newPassword: 'changed-password' })
    });
    assert.equal(change.status, 200);
    const changed = await change.json();
    const adminHeaders = { Authorization: `Bearer ${changed.token}`, 'Content-Type': 'application/json' };
    const adminId = db.prepare("SELECT id FROM app_users WHERE username = 'admin'").get().id;
    const update = (body) => fetch(base + `/api/users/${adminId}`, {
        method: 'PUT', headers: adminHeaders, body: JSON.stringify(body)
    });
    assert.equal((await update({ role: 'viewer', password: 'must-not-be-applied' })).status, 400);
    assert.equal(db.prepare('SELECT role FROM app_users WHERE id = ?').get(adminId).role, 'admin');
    assert.equal((await update({ role: 'admin' })).status, 200);
    db.prepare("INSERT INTO app_users (username, password_hash, role) VALUES ('second-admin', 'unused', 'admin')").run();
    assert.equal((await update({ role: 'operator' })).status, 200);
    assert.equal(db.prepare('SELECT role FROM app_users WHERE id = ?').get(adminId).role, 'operator');
    assert.equal((await fetch(base + '/api/users', { headers: adminHeaders })).status, 401);
});
