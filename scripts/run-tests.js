#!/usr/bin/env node
// ============================================
// Test koşucusu
// ============================================
// better-sqlite3 yerel (native) bir modüldür ve `npm start` için Electron
// ABI'sine göre derlenir. Bu yüzden testler de aynı ABI altında çalışmalıdır;
// aksi halde "NODE_MODULE_VERSION mismatch" hatası alınır.
//
// ELECTRON_RUN_AS_NODE=1 ile Electron ikilisi saf bir Node çalıştırıcısı gibi
// davranır (pencere açmaz), böylece node:test aynen çalışır.
//
// Electron kurulu değilse (ör. yalnızca CI'da sunucu testi) düz node'a düşer.

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const TEST_GLOB = 'test/**/*.test.js';

// electron paketinin sağladığı çalıştırılabilir yolu bul
function electronBinary() {
    try {
        const p = require('electron'); // string yol döndürür
        return typeof p === 'string' && fs.existsSync(p) ? p : null;
    } catch (e) {
        return null;
    }
}

const bin = electronBinary();
const useElectron = !!bin;

const cmd = useElectron ? bin : process.execPath;
const args = ['--test', TEST_GLOB];
const env = { ...process.env };
if (useElectron) env.ELECTRON_RUN_AS_NODE = '1';

console.log(`[test] çalıştırıcı: ${useElectron ? 'electron (ELECTRON_RUN_AS_NODE=1)' : 'node'}`);

const r = spawnSync(cmd, args, { cwd: ROOT, env, stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
