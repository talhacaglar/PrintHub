const { app, BrowserWindow } = require('electron');
const path = require('path');

// Veritabanı ve oturum sırrı, uygulama verisi klasöründe tutulur (server require edilmeden ÖNCE ayarlanmalı)
process.env.PRINTHUB_DB_PATH = path.join(app.getPath('userData'), 'printhub.db');
if (!process.env.PRINTHUB_SESSION_SECRET) {
    process.env.PRINTHUB_SESSION_SECRET = 'printhub-' + app.getPath('userData');
}

const { startServer } = require('./server');

// Disable hardware acceleration for better compatibility on some systems
app.disableHardwareAcceleration();

let mainWindow;
let server;

async function createWindow() {
    // API sunucusunu başlat
    try {
        server = await startServer();
        console.log('[Electron] API sunucusu başlatıldı.');
    } catch (e) {
        console.error('[Electron] API sunucusu başlatılamadı:', e.message);
    }

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    // Menü çubuğunu gizle
    mainWindow.setMenuBarVisibility(false);

    // API sunucusu üzerinden yükle (böylece API istekleri aynı origin'den gider)
    mainWindow.loadURL('http://localhost:3847');
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', function () {
    if (server) {
        server.close();
    }
    if (process.platform !== 'darwin') app.quit();
});
