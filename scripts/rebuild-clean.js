#!/usr/bin/env node
// ============================================
// better-sqlite3 temiz yeniden derleme
// ============================================
// Node ile Electron farklı ABI sürümleri kullanır (NODE_MODULE_VERSION).
// Modül yanlış ABI için derlenmişse `npm start` şu hatayı verir:
//   "was compiled against a different Node.js version..."
//
// Düz `electron-rebuild` bazen eski build/ dizini yüzünden
// "opening dependency file ... No such file or directory" ile patlar;
// bu script önce build/ dizinini tamamen siler, sonra yeniden derler.

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const BUILD_DIR = path.join(ROOT, 'node_modules', 'better-sqlite3', 'build');

if (fs.existsSync(BUILD_DIR)) {
    fs.rmSync(BUILD_DIR, { recursive: true, force: true });
    console.log('[rebuild] eski build/ dizini silindi');
} else {
    console.log('[rebuild] build/ dizini zaten yok');
}

console.log('[rebuild] electron-rebuild başlatılıyor (birkaç dakika sürebilir)...');
const r = spawnSync('npx', ['electron-rebuild', '-f', '-w', 'better-sqlite3'], {
    cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32'
});
process.exit(r.status === null ? 1 : r.status);
