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
    assert.equal((await fetch(base + '/api/users', { headers: { Authorization: `Bearer ${changed.token}` } })).status, 200);
});
