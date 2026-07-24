const express = require('express');
const cors = require('cors');
const { scanNetwork, getSubnetsForCIDR } = require('./scanner');
const { queryPrinter } = require('./snmp-query');

const { db, getSetting, setSetting, getAllSettings, setSecureSetting, migratePlaintextSecrets, audit } = require('./db');
const { sessionMiddleware, requireAuth, requireRole, currentUser, clientIp, attachAuthRoutes } = require('./auth');
const readings = require('./readings');
const ad = require('./ad');
const inventory = require('./inventory');

const app = express();
const PORT = 3847;
const HOST = '127.0.0.1'; // Yalnızca yerel makineden erişim — ağa açılmaz

// CORS: yalnızca uygulamanın kendi origin'i (Electron pencere localhost'tan yüklenir).
// Ağdaki diğer makinelerden gelen cross-origin istekler reddedilir.
app.use(cors({ origin: [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`], credentials: true }));
app.use(express.json());
app.use(sessionMiddleware);
app.use(express.static(__dirname)); // HTML/CSS/JS dosyalarını sun (login öncesi gerekli)

// ============================================
// STATE
// ============================================
// SNMP bağlantı seçenekleri: v3 yapılandırılmışsa v3 (auth/priv),
// aksi halde v2c community (yoksa 'public').
function snmpCommunity() {
    if (getSetting('snmp_version') === '3' && getSetting('snmp_v3_user')) {
        return {
            version: '3',
            user: getSetting('snmp_v3_user') || '',
            authProtocol: getSetting('snmp_v3_auth_protocol') || 'sha',
            authKey: getSetting('snmp_v3_auth_key') || '',
            privProtocol: getSetting('snmp_v3_priv_protocol') || 'aes',
            privKey: getSetting('snmp_v3_priv_key') || ''
        };
    }
    return getSetting('snmp_community') || 'public';
}

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

// Zorunlu parola değişimi kapısı — kullanıcı ilk parolasını değiştirmeden
// hiçbir işlem yapamaz (yalnız parola değiştirme / oturum uçları serbest).
const PW_GATE_ALLOW = ['/change-password', '/logout', '/me'];
app.use('/api', (req, res, next) => {
    const user = req.session && req.session.user;
    if (user && user.mustChangePassword && !PW_GATE_ALLOW.includes(req.path)) {
        return res.status(403).json({ error: 'Devam etmeden önce parolanızı değiştirmelisiniz.', mustChangePassword: true });
    }
    next();
});

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
        const info = await queryPrinter(ip, snmpCommunity());
        const idx = discoveredPrinters.findIndex(p => p.ip === ip);
        if (idx >= 0) {
            info.id = discoveredPrinters[idx].id;
            discoveredPrinters[idx] = info;
        }
        readings.recordReading(info);
        res.json(info);
    } catch (e) {
        console.error('[API] Yazıcı sorgu hatası:', ip, '-', e.message);
        res.status(500).json({ error: 'Yazıcı sorgulanamadı (SNMP yanıt vermiyor olabilir).' });
    }
});

app.get('/api/printer/:ip/history', (req, res) => {
    res.json({ history: readings.getHistory(req.params.ip) });
});

/**
 * Diziyi en fazla `limit` eşzamanlılıkla işler (Promise.allSettled benzeri,
 * sıra korunur). SNMP sorgu paralelleştirmesi için.
 */
async function mapConcurrent(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            try { results[i] = await fn(items[i], i); }
            catch (e) { results[i] = undefined; }
        }
    }
    const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
    await Promise.all(workers);
    return results.filter(r => r !== undefined);
}

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

        // SNMP sorguları 6'lı gruplar halinde paralel (en büyük hız kazancı)
        const results = await mapConcurrent(hosts, 6, async (host) => {
            scanStatus.message = `SNMP sorgulanıyor: ${host.ip}`;
            try {
                const info = await queryPrinter(host.ip, snmpCommunity());
                info.openPorts = host.ports;
                return info;
            } catch (e) {
                return {
                    ip: host.ip, name: `Yazıcı (${host.ip})`,
                    model: 'SNMP Yanıt Yok', type: 'laser', color: false, mac: '',
                    location: 'Bilinmiyor', status: 'online', statusText: 'Çevrim İçi',
                    serialNumber: '', firmware: '', toner: { black: -1 }, paperTrays: [],
                    queue: [], totalPrinted: 0, monthlyPrinted: 0, lastSeen: 'Şimdi',
                    snmpAvailable: false, openPorts: host.ports
                };
            }
        });

        // Taramada bulunamayan ama önceden bilinen yazıcılar "çevrimdışı" olarak korunur
        const foundIps = new Set(results.map(r => r.ip));
        const offline = discoveredPrinters
            .filter(p => !foundIps.has(p.ip))
            .map(p => ({
                ...p, status: 'offline', statusText: 'Çevrim Dışı',
                lastSeen: p.lastSeen === 'Şimdi' ? new Date().toISOString() : p.lastSeen,
                snmpAvailable: false, queue: []
            }));

        discoveredPrinters = [...results, ...offline].map((p, i) => ({ ...p, id: i + 1 }));

        readings.recordAll(discoveredPrinters); // ISO A.8.16 — zaman serisi kaydı
        saveKnownPrinters();                    // yeniden açılışta hatırlanır

        scanStatus = {
            scanning: false, progress: 100, total: scanStatus.total,
            scanned: scanStatus.total, found: discoveredPrinters.length,
            message: `Tarama tamamlandı. ${discoveredPrinters.length} yazıcı bulundu.`
        };
    } catch (e) {
        scanStatus = { scanning: false, progress: 0, total: 0, scanned: 0, found: 0, message: `Tarama hatası: ${e.message}` };
    }
});

// ============================================
// YAZICI KALICILIĞI
// Keşfedilen yazıcılar DB'de saklanır; uygulama yeniden açıldığında
// tarama beklemeden bilinen IP'ler otomatik sorgulanır.
// ============================================
function saveKnownPrinters() {
    const tx = db.transaction(() => {
        db.prepare('DELETE FROM known_printers').run();
        const ins = db.prepare(`INSERT INTO known_printers (printer_ip, name, model, open_ports, last_seen)
                                VALUES (?, ?, ?, ?, datetime('now'))`);
        for (const p of discoveredPrinters) {
            ins.run(p.ip, p.name || '', p.model || '', JSON.stringify(p.openPorts || []));
        }
    });
    tx();
}

function loadKnownPrinters() {
    const rows = db.prepare('SELECT * FROM known_printers ORDER BY printer_ip').all();
    return rows.map((r, i) => ({
        id: i + 1,
        ip: r.printer_ip,
        name: r.name || `Yazıcı (${r.printer_ip})`,
        model: r.model || '',
        type: 'laser', color: false, mac: '',
        location: 'Bilinmiyor',
        status: 'offline', statusText: 'Sorgulanıyor...',
        serialNumber: '', firmware: '',
        toner: { black: -1 }, paperTrays: [], queue: [],
        totalPrinted: 0, monthlyPrinted: 0,
        lastSeen: r.last_seen, snmpAvailable: false,
        openPorts: safeJson(r.open_ports)
    }));
}

function safeJson(s) { try { return JSON.parse(s) || []; } catch { return []; } }

// Tüm bilinen yazıcıları yeniden sorgular (manuel yenileme + otomatik zamanlayıcı ortak yolu)
// SNMP sorguları 6'lı gruplar halinde paralel çalışır.
async function refreshAllPrinters() {
    scanStatus.scanning = true;
    scanStatus.message = 'Yazıcılar yenileniyor...';

    let done = 0;
    await mapConcurrent(discoveredPrinters.map((p, i) => ({ p, i })), 6, async ({ p, i }) => {
        try {
            const info = await queryPrinter(p.ip, snmpCommunity());
            info.id = p.id;
            info.openPorts = p.openPorts;
            discoveredPrinters[i] = info;
        } catch (e) {
            discoveredPrinters[i].lastSeen = 'Bağlantı hatası';
            discoveredPrinters[i].status = 'offline';
            discoveredPrinters[i].statusText = 'Çevrim Dışı';
        }
        done++;
        scanStatus.message = `Yenileniyor... ${done}/${discoveredPrinters.length}`;
        return true;
    });

    readings.recordAll(discoveredPrinters); // ISO A.8.16 — zaman serisi
    readings.pruneReadings(parseInt(getSetting('readings_retention_days')) || 90); // saklama politikası
    saveKnownPrinters();
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

// Açılışta son bilinen yazıcıları yükle ve arka planda tazele —
// böylece uygulama kapalı kalınan süredeki sayfa sayacı farkı
// kimse "Ağı Tara"ya basmadan otomatik yakalanır.
discoveredPrinters = loadKnownPrinters();
if (discoveredPrinters.length > 0) {
    scanStatus.message = `${discoveredPrinters.length} kayıtlı yazıcı yüklendi, güncelleniyor...`;
    console.log(`[Açılış] ${discoveredPrinters.length} kayıtlı yazıcı yüklendi; arka planda sorgulanıyor.`);
    setTimeout(() => {
        refreshAllPrinters().catch(() => { scanStatus.scanning = false; });
    }, 2000);
}

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
    const { toner_type_id, direction, quantity, unit_cost, printer_ip, note, movement_date } = req.body || {};
    const qty = parseInt(quantity);
    if (!toner_type_id || !['in', 'out'].includes(direction) || !qty || qty <= 0) {
        return res.status(400).json({ error: 'Geçersiz stok hareketi.' });
    }
    const type = db.prepare('SELECT * FROM toner_types WHERE id = ?').get(toner_type_id);
    if (!type) return res.status(404).json({ error: 'Toner türü bulunamadı.' });

    // Gerçek işlem tarihi — geriye dönük giriş için (YYYY-MM-DD); geçersizse bugün
    const mDate = (typeof movement_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(movement_date))
        ? movement_date
        : new Date().toISOString().slice(0, 10);

    const actor = currentUser(req).username;
    const info = db.prepare(`INSERT INTO stock_movements (toner_type_id, direction, quantity, unit_cost, printer_ip, note, actor, movement_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        toner_type_id, direction, qty,
        unit_cost != null ? parseFloat(unit_cost) : type.unit_cost,
        printer_ip || null, note || '', actor, mDate);
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
        SELECT strftime('%Y-%m', COALESCE(movement_date, created_at)) AS month,
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

// Hata hijyeni: iç detaylar (LDAP DN, dosya yolu vb.) istemciye sızmasın
function safeError(res, e, publicMsg, status = 400) {
    console.error('[API]', publicMsg, '-', e.message);
    res.status(status).json({ error: publicMsg });
}

app.get('/api/ad/users', async (req, res) => {
    try {
        const users = await ad.getUsers();
        res.json({ users });
    } catch (e) {
        // ad.js hataları zaten kullanıcıya gösterilebilir biçimde temizlenmiştir
        // (translatePsAdError / withClient) — ham stack sızdırılmaz.
        safeError(res, e, e.message || 'AD kullanıcı listesi alınamadı. Bağlantı ayarlarını kontrol edin.');
    }
});

app.get('/api/ad/groups', async (req, res) => {
    try {
        const groups = await ad.getGroups();
        res.json({ groups });
    } catch (e) {
        safeError(res, e, e.message || 'AD grup listesi alınamadı. Bağlantı ayarlarını kontrol edin.');
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
        // Kişi IT envanteri — kayıtlı cihazlar + yazılımlar
        user.devices = inventory.getDevicesForUser(user.sam);
        // KVKK / ISO A.5.18 — kişisel veri görüntüleme izi
        audit({ actor: currentUser(req).username, action: 'ad_view_user', entity: 'ad_user', entity_id: user.sam, ip: clientIp(req) });
        res.json({ user });
    } catch (e) {
        safeError(res, e, e.message || 'Kullanıcı detayı alınamadı.');
    }
});

// ============================================
// KİŞİ IT ENVANTERİ (cihaz + yazılım) — ISO A.5.9
// ============================================
app.get('/api/inventory/user/:sam', (req, res) => {
    try {
        ad.assertValidSam(req.params.sam);
        res.json({ devices: inventory.getDevicesForUser(req.params.sam), winrmEnabled: inventory.winrmEnabled() });
    } catch (e) {
        safeError(res, e, 'Envanter bilgisi alınamadı.');
    }
});

// AD'den bilgisayar keşfi + (WinRM açıksa) donanım/yazılım toplama
app.post('/api/inventory/collect/:sam', requireRole('operator'), async (req, res) => {
    try {
        const sam = ad.assertValidSam(req.params.sam);
        const adResult = await inventory.discoverAdComputers(sam).catch(err => ({ supported: false, note: err.message, computers: [] }));
        const collected = [];
        if (inventory.winrmEnabled()) {
            const targets = (req.body && Array.isArray(req.body.hostnames) && req.body.hostnames.length)
                ? req.body.hostnames
                : adResult.computers.map(c => c.hostname);
            for (const h of targets.slice(0, 5)) { // aşırı yükü önle
                try {
                    const r = await inventory.collectViaWinRM(sam, h);
                    collected.push({ hostname: h, ok: true, softwareCount: r.softwareCount });
                } catch (err) {
                    collected.push({ hostname: h, ok: false, error: 'Toplanamadı (WinRM erişimi/yetki).' });
                    console.error('[Inventory] WinRM hatası:', h, err.message);
                }
            }
        }
        audit({ actor: currentUser(req).username, action: 'inventory_collect', entity: 'ad_user', entity_id: sam, detail: `${collected.filter(c => c.ok).length} cihaz toplandı`, ip: clientIp(req) });
        res.json({ adDiscovery: adResult, collected, devices: inventory.getDevicesForUser(sam) });
    } catch (e) {
        safeError(res, e, 'Envanter toplama başarısız.');
    }
});

// Elle cihaz ekleme/atama
app.post('/api/inventory/device', requireRole('operator'), (req, res) => {
    try {
        const b = req.body || {};
        const id = inventory.upsertDevice({ ...b, source: 'manual' });
        audit({ actor: currentUser(req).username, action: 'create', entity: 'device', entity_id: id, detail: `${b.sam} ← ${b.hostname}`, ip: clientIp(req) });
        res.json({ id });
    } catch (e) {
        safeError(res, e, e.message.includes('Geçersiz') ? e.message : 'Cihaz kaydedilemedi.');
    }
});

app.put('/api/inventory/device/:id', requireRole('operator'), (req, res) => {
    try {
        inventory.updateDevice(parseInt(req.params.id), req.body || {});
        audit({ actor: currentUser(req).username, action: 'update', entity: 'device', entity_id: req.params.id, ip: clientIp(req) });
        res.json({ ok: true });
    } catch (e) {
        safeError(res, e, 'Cihaz güncellenemedi.');
    }
});

app.delete('/api/inventory/device/:id', requireRole('operator'), (req, res) => {
    try {
        inventory.deleteDevice(parseInt(req.params.id));
        audit({ actor: currentUser(req).username, action: 'delete', entity: 'device', entity_id: req.params.id, ip: clientIp(req) });
        res.json({ ok: true });
    } catch (e) {
        safeError(res, e, 'Cihaz silinemedi.');
    }
});

// ============================================
// KULLANICI ERİŞİM RAPORU (ISO A.5.18 gözden geçirme kanıtı)
// Kişinin tüm erişim profili tek yanıtta: gruplar, klasörler,
// uygulamalar, cihazlar, kullandığı yazıcılar.
// ============================================
app.get('/api/report/user-access/:sam', async (req, res) => {
    try {
        const user = await ad.getUserDetail(req.params.sam);
        const devices = inventory.getDevicesForUser(user.sam);
        const usedPrinters = [];
        for (const p of discoveredPrinters) {
            const jobs = (p.queue || []).filter(q =>
                (q.user || '').toLowerCase().includes((req.params.sam || '').toLowerCase()));
            if (jobs.length) usedPrinters.push({ ip: p.ip, name: p.name, jobs: jobs.length });
        }
        audit({ actor: currentUser(req).username, action: 'access_report', entity: 'ad_user', entity_id: user.sam, ip: clientIp(req) });
        res.json({
            generatedAt: new Date().toISOString(),
            user: {
                sam: user.sam, displayName: user.displayName, department: user.department,
                title: user.title, mail: user.mail, disabled: user.disabled,
                lockedOut: user.lockedOut, lastLogon: user.lastLogon, whenCreated: user.whenCreated
            },
            groups: user.groups || [],
            directGroups: user.directGroups || [],
            folderPermissions: user.folderPermissions || {},
            appAccess: user.appAccess || [],
            devices,
            usedPrinters
        });
    } catch (e) {
        safeError(res, e, 'Erişim raporu oluşturulamadı.');
    }
});

// ============================================
// AYARLAR & DENETİM LOGU
// ============================================
const SETTING_KEYS = ['currency', 'scan_base_ip', 'scan_cidr', 'snmp_community', 'ad_url', 'ad_base_dn', 'ad_bind_dn', 'ad_password', 'ad_share_roots', 'ad_tls_insecure', 'auto_refresh_minutes', 'winrm_enabled', 'app_access_map', 'readings_retention_days',
    'snmp_version', 'snmp_v3_user', 'snmp_v3_auth_protocol', 'snmp_v3_auth_key', 'snmp_v3_priv_protocol', 'snmp_v3_priv_key'];
// İstemciye asla dönmeyecek gizli ayarlar
const SECRET_SETTING_KEYS = ['ad_password', 'snmp_v3_auth_key', 'snmp_v3_priv_key'];

app.get('/api/settings', (req, res) => {
    const all = getAllSettings();
    const hasAdPassword = !!all.ad_password;
    for (const k of SECRET_SETTING_KEYS) delete all[k]; // sırları istemciye gönderme
    res.json({ settings: all, hasAdPassword });
});

app.post('/api/settings', requireRole('admin'), (req, res) => {
    const body = req.body || {};
    const changed = [];
    for (const key of SETTING_KEYS) {
        if (key in body) {
            if (SECRET_SETTING_KEYS.includes(key)) {
                if (body[key] === '') continue; // boşsa mevcut sırrı koru
                if (key === 'ad_password') setSecureSetting(key, body[key]); // safeStorage ile şifreli
                else setSetting(key, body[key]); // SNMPv3 anahtarları (yerel DB)
            } else {
                setSetting(key, body[key]);
            }
            changed.push(key);
        }
    }
    audit({ actor: currentUser(req).username, action: 'update', entity: 'settings', detail: changed.join(','), ip: clientIp(req) });
    if (changed.includes('auto_refresh_minutes')) scheduleAutoRefresh();
    // AD/ACL ile ilgili ayarlar değiştiyse cache temizle (eski sonuç dönmesin)
    if (changed.some(k => k.startsWith('ad_') || k === 'app_access_map')) ad.clearCache();
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
    // Eski kurulumlardan kalan düz metin AD parolasını şifreli depoya taşı
    try { migratePlaintextSecrets(); } catch (e) { console.error('[Server] Sır taşıma hatası:', e.message); }
    return new Promise((resolve) => {
        const server = app.listen(PORT, HOST, () => {
            console.log(`\n  ╔══════════════════════════════════════╗`);
            console.log(`  ║   PrintHub API Sunucusu Başlatıldı   ║`);
            console.log(`  ║   http://${HOST}:${PORT}            ║`);
            console.log(`  ╚══════════════════════════════════════╝\n`);
            resolve(server);
        });
    });
}

if (require.main === module) {
    startServer();
}

module.exports = { app, startServer };
