const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const attachUiFiles = require('../ui-static');

test('public files are restricted to the UI', async (t) => {
    const app = express();
    attachUiFiles(app);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const file of ['/', '/index.html', '/style.css', '/js/core.js', '/assets/fonts/fonts.css']) {
        assert.equal((await fetch(base + file)).status, 200, file);
    }
    for (const file of ['/server.js', '/db.js', '/auth.js', '/package.json', '/printhub.db', '/printhub.db-wal', '/js/%2e%2e%2fdb.js']) {
        assert.equal((await fetch(base + file)).status, 404, file);
    }
});
