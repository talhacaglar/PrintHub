const express = require('express');
const cors = require('cors');
const { scanNetwork, getSubnetsForCIDR } = require('./scanner');
const { queryPrinter } = require('./snmp-query');

const { db, getSetting, setSetting, getAllSettings, audit } = require('./db');
const { sessionMiddleware, requireAuth, requireRole, currentUser, clientIp, attachAuthRoutes } = require('./auth');
const readings = require('./readings');
const ad = require('./ad');

const app = express();
const PORT = 3847;

app.use(cors());
app.use(express.json());
app.use(sessionMiddleware);
app.use(express.static(__dirname)); // HTML/CSS/JS dosyalarını sun (login öncesi gerekli)

// ============================================
// STATE
// ============================================
let discoveredPrinters = [];
let scanStatus = {
    scanning: false,
    progress: 0,
    total: 0,
    scanned: 0,
    found: 0,
    message: 'Tarama başlatılmadı.'
};

// ============================================
// KİMLİK / RBAC ROTALARI (login/logout/me/users)
// ============================================
attachAuthRoutes(app);

// Bu noktadan sonraki tüm /api uçları oturum ister
app.use('/api', requireAuth);

// ============================================
// YAZICI API'LERİ
// ============================================
app.get('/api/status', (req, res) => res.json(scanStatus));

// Varlık kayıtlarını (demirbaş no, özel konum, not) yazıcı listesine ekler (ISO A.5.9)
function mergeAssets(printers) {
    const assets = db.prepare('SELECT * FROM printer_assets').all();
    const byIp = Object.fromEntries(assets.map(a => [a.printer_ip, a]));
    return printers.map(p => {
        const a = byIp[p.ip];
        return a ? { ...p, assetTag: a.asset_tag, customLocation: a.custom_location, assetNotes: a.notes } : p;
    });
}

app.get('/api/printers', (req, res) => {
    res.json({ printers: mergeAssets(discoveredPrinters), scanStatus });
});

app.put('/api/printer/:ip/asset', requireRole('operator'), (req, res) => {
    const ip = req.params.ip;
    const { asset_tag, custom_location, notes } = req.body || {};
    db.prepare(`INSERT INTO printer_assets (printer_ip, asset_tag, custom_location, notes, updated_at)
                VALUES (?, ?, ?, ?, datetime('now'))
                ON CONFLICT(printer_ip) DO UPDATE SET
                    asset_tag = excluded.asset_tag,
                    custom_location = excluded.custom_location,
                    notes = excluded.notes,
                    updated_at = excluded.updated_at`)
        .run(ip, asset_tag || '', custom_location || '', notes || '');
    audit({ actor: currentUser(req).username, action: 'update', entity: 'printer_asset', entity_id: ip, detail: asset_tag || '', ip: clientIp(req) });
    res.json({ ok: true });
});

app.get('/api/printer/:ip', async (req, res) => {
    const ip = req.params.ip;
    try {
        const info = await queryPrinter(ip);
        const idx = discoveredPrinters.findIndex(p => p.ip === ip);
        if (idx >= 0) {
            info.id = discoveredPrinters[idx].id;
            discoveredPrinters[idx] = info;
        }
        readings.recordReading(info);
        res.json(info);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/printer/:ip/history', (req, res) => {
    res.json({ history: readings.getHistory(req.params.ip) });
});

app.post('/api/scan', requireRole('operator'), async (req, res) => {
    if (scanStatus.scanning) {
        return res.status(409).json({ error: 'Tarama zaten devam ediyor.' });
    }

    const baseIp = req.body.baseIp || getSetting('scan_base_ip') || '192.168.2.18';
    const cidr = req.body.cidr || getSetting('scan_cidr') || '22';
    const start = parseInt(req.body.start) || 1;
    const end = parseInt(req.body.end) || 254;

    const subnets = getSubnetsForCIDR(baseIp, cidr);

    scanStatus = {
        scanning: true, progress: 0,
        total: subnets.length * (end - start + 1),
        scanned: 0, found: 0, message: 'Ağ taranıyor...'
    };

    audit({ actor: currentUser(req).username, action: 'scan', entity: 'network', detail: `${baseIp}/${cidr}`, ip: clientIp(req) });
    res.json({ message: 'Tarama başlatıldı.', subnets, total: scanStatus.total });

    try {
        const hosts = await scanNetwork({
            subnets, start, end,
            onProgress: (scanned, total, found) => {
                scanStatus.scanned = scanned;
                scanStatus.total = total;
                scanStatus.found = found;
                scanStatus.progress = Math.round((scanned / total) * 100);
                scanStatus.message = `Taranıyor... ${scanned}/${total} IP (${found} yazıcı bulundu)`;
            }
        });

        scanStatus.message = `${hosts.length} cihaza SNMP sorgusu yapılıyor...`;
        discoveredPrinters = [];
        let id = 1;

        for (const host of hosts) {
            try {
                scanStatus.message = `SNMP sorgulanıyor: ${host.ip}`;
                const info = await queryPrinter(host.ip);
                info.id = id++;
                info.openPorts = host.ports;
                discoveredPrinters.push(info);
            } catch (e) {
                discoveredPrinters.push({
                    id: id++, ip: host.ip, name: `Yazıcı (${host.ip})`,
                    model: 'SNMP Yanıt Yok', type: 'laser', color: false, mac: '',
                    location: 'Bilinmiyor', status: 'online', statusText: 'Çevrimiçi',
                    serialNumber: '', firmware: '', toner: { black: -1 }, paperTrays: [],
                    queue: [], totalPrinted: 0, monthlyPrinted: 0, lastSeen: 'Şimdi',
                    snmpAvailable: false, openPorts: host.ports
                });
            }
        }

        readings.recordAll(discoveredPrinters); // ISO A.8.16 — zaman serisi kaydı

        scanStatus = {
            scanning: false, progress: 100, total: scanStatus.total,
            scanned: scanStatus.total, found: discoveredPrinters.length,
            message: `Tarama tamamlandı. ${discoveredPrinters.length} yazıcı bulundu.`
        };
    } catch (e) {
        scanStatus = { scanning: false, progress: 0, total: 0, scanned: 0, found: 0, message: `Tarama hatası: ${e.message}` };
    }
});

// Tüm bilinen yazıcıları yeniden sorgular (manuel yenileme + otomatik zamanlayıcı ortak yolu)
async function refreshAllPrinters() {
    scanStatus.scanning = true;
    scanStatus.message = 'Yazıcılar yenileniyor...';

    for (let i = 0; i < discoveredPrinters.length; i++) {
        const printer = discoveredPrinters[i];
        try {
            const info = await queryPrinter(printer.ip);
            info.id = printer.id;
            info.openPorts = printer.openPorts;
            discoveredPrinters[i] = info;
        } catch (e) {
            discoveredPrinters[i].lastSeen = 'Bağlantı hatası';
            discoveredPrinters[i].status = 'offline';
            discoveredPrinters[i].statusText = 'Çevrimdışı';
        }
    }

    readings.recordAll(discoveredPrinters); // ISO A.8.16 — zaman serisi
    scanStatus.scanning = false;
    scanStatus.message = 'Yenileme tamamlandı.';
}

app.post('/api/refresh', requireRole('operator'), async (req, res) => {
    if (scanStatus.scanning) return res.status(409).json({ error: 'Tarama devam ediyor.' });
    if (discoveredPrinters.length === 0) return res.json({ message: 'Yenilenecek yazıcı yok. Önce tarama yapın.' });

    res.json({ message: 'Yenileme başlatıldı.' });
    await refreshAllPrinters();
});

// ============================================
// OTOMATİK PERİYODİK YENİLEME
// auto_refresh_minutes ayarı > 0 ise bilinen yazıcılar periyodik sorgulanır
// (tüketim raporu için printer_readings zaman serisini besler).
// ============================================
let autoRefreshTimer = null;

function scheduleAutoRefresh() {
    if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
    }
    const minutes = parseInt(getSetting('auto_refresh_minutes')) || 0;
    if (minutes <= 0) return;

    autoRefreshTimer = setInterval(async () => {
        if (scanStatus.scanning || discoveredPrinters.length === 0) return;
        console.log(`[Oto-Yenileme] ${discoveredPrinters.length} yazıcı sorgulanıyor...`);
        try { await refreshAllPrinters(); } catch (e) { scanStatus.scanning = false; }
    }, minutes * 60 * 1000);
    console.log(`[Oto-Yenileme] Etkin: her ${minutes} dakikada bir.`);
}
scheduleAutoRefresh();

// ============================================
// TONER TÜRLERİ & MALİYET
// ============================================
app.get('/api/toner-types', (req, res) => {
    const types = db.prepare('SELECT * FROM toner_types ORDER BY name').all();
    res.json({ tonerTypes: types });
});

app.post('/api/toner-types', requireRole('operator'), (req, res) => {
    const { name, color, printer_model, yield_pages, unit_cost, currency, min_stock } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Toner adı zorunlu.' });
    const info = db.prepare(`INSERT INTO toner_types (name, color, printer_model, yield_pages, unit_cost, currency, min_stock)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        name, color || 'black', printer_model || '', parseInt(yield_pages) || 0,
        parseFloat(unit_cost) || 0, currency || getSetting('currency') || 'TRY', parseInt(min_stock) || 2);
    audit({ actor: currentUser(req).username, action: 'create', entity: 'toner_type', entity_id: info.lastInsertRowid, detail: name, ip: clientIp(req) });
    res.json({ id: info.lastInsertRowid });
});

app.put('/api/toner-types/:id', requireRole('operator'), (req, res) => {
    const id = parseInt(req.params.id);
    const cur = db.prepare('SELECT * FROM toner_types WHERE id = ?').get(id);
    if (!cur) return res.status(404).json({ error: 'Toner türü bulunamadı.' });
    const b = req.body || {};
    db.prepare(`UPDATE toner_types SET name=?, color=?, printer_model=?, yield_pages=?, unit_cost=?, currency=?, min_stock=? WHERE id=?`).run(
        b.name ?? cur.name, b.color ?? cur.color, b.printer_model ?? cur.printer_model,
        b.yield_pages != null ? parseInt(b.yield_pages) : cur.yield_pages,
        b.unit_cost != null ? parseFloat(b.unit_cost) : cur.unit_cost,
        b.currency ?? cur.currency, b.min_stock != null ? parseInt(b.min_stock) : cur.min_stock, id);
    audit({ actor: currentUser(req).username, action: 'update', entity: 'toner_type', entity_id: id, ip: clientIp(req) });
    res.json({ ok: true });
});

app.delete('/api/toner-types/:id', requireRole('operator'), (req, res) => {
    const id = parseInt(req.params.id);
    db.prepare('DELETE FROM toner_types WHERE id = ?').run(id);
    audit({ actor: currentUser(req).username, action: 'delete', entity: 'toner_type', entity_id: id, ip: clientIp(req) });
    res.json({ ok: true });
});

// ============================================
// STOK
// ============================================
app.get('/api/stock', (req, res) => {
    const rows = db.prepare(`
        SELECT t.*,
            COALESCE(SUM(CASE WHEN m.direction='in'  THEN m.quantity END), 0) AS total_in,
            COALESCE(SUM(CASE WHEN m.direction='out' THEN m.quantity END), 0) AS total_out
        FROM toner_types t
        LEFT JOIN stock_movements m ON m.toner_type_id = t.id
        GROUP BY t.id ORDER BY t.name
    `).all();
    const stock = rows.map(r => {
        const current = r.total_in - r.total_out;
        return { ...r, current_stock: current, low: current <= r.min_stock };
    });
    res.json({ stock });
});

app.get('/api/stock/movements', (req, res) => {
    const rows = db.prepare(`
        SELECT m.*, t.name AS toner_name, t.color
        FROM stock_movements m JOIN toner_types t ON t.id = m.toner_type_id
        ORDER BY m.created_at DESC LIMIT 300
    `).all();
    res.json({ movements: rows });
});

app.post('/api/stock/movements', requireRole('operator'), (req, res) => {
    const { toner_type_id, direction, quantity, unit_cost, printer_ip, note } = req.body || {};
    const qty = parseInt(quantity);
    if (!toner_type_id || !['in', 'out'].includes(direction) || !qty || qty <= 0) {
        return res.status(400).json({ error: 'Geçersiz stok hareketi.' });
    }
    const type = db.prepare('SELECT * FROM toner_types WHERE id = ?').get(toner_type_id);
    if (!type) return res.status(404).json({ error: 'Toner türü bulunamadı.' });

    const actor = currentUser(req).username;
    const info = db.prepare(`INSERT INTO stock_movements (toner_type_id, direction, quantity, unit_cost, printer_ip, note, actor)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        toner_type_id, direction, qty,
        unit_cost != null ? parseFloat(unit_cost) : type.unit_cost,
        printer_ip || null, note || '', actor);
    audit({ actor, action: direction === 'in' ? 'stock_in' : 'stock_out', entity: 'stock', entity_id: info.lastInsertRowid, detail: `${type.name} x${qty}`, ip: clientIp(req) });
    res.json({ id: info.lastInsertRowid });
});

// ============================================
// RAPORLAR
// ============================================
app.get('/api/reports/toner-usage', (req, res) => {
    res.json(readings.getTonerUsageReport());
});

app.get('/api/reports/cost', (req, res) => {
    const byType = db.prepare(`
        SELECT t.id, t.name, t.color, t.unit_cost, t.currency,
            COALESCE(SUM(CASE WHEN m.direction='in'  THEN m.quantity END),0) AS in_qty,
            COALESCE(SUM(CASE WHEN m.direction='out' THEN m.quantity END),0) AS out_qty,
            COALESCE(SUM(CASE WHEN m.direction='out' THEN m.quantity*m.unit_cost END),0) AS out_value,
            COALESCE(SUM(CASE WHEN m.direction='in'  THEN m.quantity*m.unit_cost END),0) AS in_value
        FROM toner_types t LEFT JOIN stock_movements m ON m.toner_type_id = t.id
        GROUP BY t.id ORDER BY out_value DESC
    `).all();

    const monthly = db.prepare(`
        SELECT strftime('%Y-%m', created_at) AS month,
            SUM(CASE WHEN direction='out' THEN quantity ELSE 0 END) AS out_qty,
            SUM(CASE WHEN direction='out' THEN quantity*unit_cost ELSE 0 END) AS out_value
        FROM stock_movements GROUP BY month ORDER BY month
    `).all();

    res.json({ byType, monthly, currency: getSetting('currency') || 'TRY' });
});

// ============================================
// ACTIVE DIRECTORY
// ============================================
app.post('/api/ad/test', requireRole('admin'), async (req, res) => {
    try {
        const result = await ad.testConnection(req.body || {});
        audit({ actor: currentUser(req).username, action: 'ad_test', entity: 'ad', detail: 'başarılı', ip: clientIp(req) });
        res.json(result);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.get('/api/ad/users', async (req, res) => {
    try {
        const users = await ad.getUsers();
        res.json({ users });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.get('/api/ad/user/:sam', async (req, res) => {
    try {
        const user = await ad.getUserDetail(req.params.sam);
        // "Genel kullanılan şeyler" — kullanıcının kuyruktaki işleriyle eşleşen yazıcılar
        const needle = (req.params.sam || '').toLowerCase();
        const displayLc = (user.displayName || '').toLowerCase();
        const usedPrinters = [];
        for (const p of discoveredPrinters) {
            const jobs = (p.queue || []).filter(q => {
                const u = (q.user || '').toLowerCase();
                return u.includes(needle) || (displayLc && u.includes(displayLc));
            });
            if (jobs.length) usedPrinters.push({ ip: p.ip, name: p.name, jobs: jobs.length });
        }
        user.usedResources = { printers: usedPrinters };
        res.json({ user });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// ============================================
// AYARLAR & DENETİM LOGU
// ============================================
const SETTING_KEYS = ['currency', 'scan_base_ip', 'scan_cidr', 'ad_url', 'ad_base_dn', 'ad_bind_dn', 'ad_password', 'ad_share_roots', 'auto_refresh_minutes'];

app.get('/api/settings', (req, res) => {
    const all = getAllSettings();
    const hasAdPassword = !!all.ad_password;
    delete all.ad_password; // parolayı istemciye gönderme
    res.json({ settings: all, hasAdPassword });
});

app.post('/api/settings', requireRole('admin'), (req, res) => {
    const body = req.body || {};
    const changed = [];
    for (const key of SETTING_KEYS) {
        if (key in body) {
            if (key === 'ad_password' && body[key] === '') continue; // boşsa mevcut parolayı koru
            setSetting(key, body[key]);
            changed.push(key);
        }
    }
    audit({ actor: currentUser(req).username, action: 'update', entity: 'settings', detail: changed.join(','), ip: clientIp(req) });
    if (changed.includes('auto_refresh_minutes')) scheduleAutoRefresh();
    res.json({ ok: true, changed });
});

app.get('/api/audit', requireRole('admin'), (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    const rows = db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?').all(limit);
    res.json({ audit: rows });
});

// ============================================
// SUNUCUYU BAŞLAT
// ============================================
function startServer() {
    return new Promise((resolve) => {
        const server = app.listen(PORT, () => {
            console.log(`\n  ╔══════════════════════════════════════╗`);
            console.log(`  ║   PrintHub API Sunucusu Başlatıldı   ║`);
            console.log(`  ║   http://localhost:${PORT}             ║`);
            console.log(`  ╚══════════════════════════════════════╝\n`);
            resolve(server);
        });
    });
}

if (require.main === module) {
    startServer();
}

module.exports = { app, startServer };
