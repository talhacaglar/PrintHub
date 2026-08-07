const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const { scanNetwork, getSubnetsForCIDR, parseScanTargets, scanHost, isValidIPv4 } = require('./scanner');
const { queryPrinter } = require('./snmp-query');

const { mergeScanResults, pruneStalePrinters } = require('./printer-identity');

const { db, getSetting, setSetting, getAllSettings, setSecureSetting, migratePlaintextSecrets, audit } = require('./db');
const { sessionMiddleware, authenticate, requireAuth, requireRole, currentUser, clientIp, attachAuthRoutes } = require('./auth');
const readings = require('./readings');
const ad = require('./ad');
const inventory = require('./inventory');
const tonerExport = require('./toner-export');

const app = express();
// PRINTHUB_PORT yalnızca test/geliştirme içindir; üretimde ayarlanmaz ve
// Electron penceresi 3847'yi yükler.
const PORT = parseInt(process.env.PRINTHUB_PORT, 10) || 3847;
const HOST = '127.0.0.1'; // Yalnızca yerel makineden erişim — ağa açılmaz

// CORS: yalnızca uygulamanın kendi origin'i (Electron pencere localhost'tan yüklenir).
// Ağdaki diğer makinelerden gelen cross-origin istekler reddedilir.
app.use(cors({
    origin: [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Content-Disposition']
}));
app.use(express.json());
app.use(sessionMiddleware);
// Bearer jetonu veya oturum çerezinden kimliği çöz (req.authUser)
app.use(authenticate);
// Yalnızca istemci varlıkları sunulur (login ekranı için kimliksiz erişim şart).
// Eskiden burada express.static(__dirname) vardı ve repo KÖKÜNÜ sunuyordu:
// GET /printhub.db oturum gerektirmeden tüm veritabanını — bcrypt parola
// özetleri, safeStorage ile şifreli AD parolası, ISO 27001 denetim kaydı —
// indirilebilir yapıyordu. Aynı şekilde /server.js, /auth.js, /package.json,
// /nohup.out da açıktı. 127.0.0.1 kısıtı bunu engellemiyor: makinedeki başka
// bir süreç ya da renderer'daki tek bir XSS her şeyi dışarı taşıyabilirdi.
const STATIC_OPTS = { index: false, dotfiles: 'deny', redirect: false };
app.use('/js', express.static(path.join(__dirname, 'js'), STATIC_OPTS));
app.use('/assets', express.static(path.join(__dirname, 'assets'), STATIC_OPTS));
app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'style.css')));
app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

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

// queryPrinter'ın davranışsal eşikleri — tek kaynak Ayarlar tablosu.
function queryOpts() {
    const low = parseInt(getSetting('low_toner_percent'), 10);
    return { lowTonerPercent: Number.isFinite(low) ? low : undefined };
}

let discoveredPrinters = [];
let scanAborted = false; // /api/scan/stop ile true olur; tarayıcı döngüsü kontrol eder
// Arka plan yenilemesi (açılış + oto-yenileme) taramadan ayrı izlenir:
// yenileme SNMP'siz cihazlarda dakikalarca sürebiliyor ve bu süre boyunca
// kullanıcının "Ağı Tara" isteğini bloklamamalı — tarama yenilemeyi önceler.
let refreshing = false;
let refreshAbort = false;
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
    const user = currentUser(req);
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

// :ip parametresi doğrulanmadan net-snmp'ye ya da DB'ye gitmemeli — net-snmp
// gelen değeri hostname sayıp DNS çözümlemesi yapıyor.
function requireIpParam(req, res, next) {
    if (!isValidIPv4(req.params.ip)) {
        return res.status(400).json({ error: 'Geçersiz IPv4 adresi.' });
    }
    next();
}

// Pozitif tam sayı olmayan :id, parseInt'ten NaN olarak çıkıp doğrudan
// inventory katmanına gidiyordu.
function requireIdParam(req, res, next) {
    if (!/^[1-9]\d*$/.test(String(req.params.id))) {
        return res.status(400).json({ error: 'Geçersiz kayıt numarası.' });
    }
    next();
}

app.put('/api/printer/:ip/asset', requireRole('operator'), requireIpParam, (req, res) => {
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

app.get('/api/printer/:ip', requireIpParam, async (req, res) => {
    const ip = req.params.ip;
    try {
        const info = await queryPrinter(ip, snmpCommunity(), queryOpts());
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

app.get('/api/printer/:ip/history', requireIpParam, (req, res) => {
    res.json({ history: readings.getHistory(req.params.ip) });
});

/**
 * Henüz başarılı biçimde sorgulanmamış bir cihazın taban kaydı.
 *
 * Buradaki her alan BİLİNMİYOR anlamına gelir. Daha önce bu nesneler
 * `model: 'SNMP Yanıt Yok', type: 'laser', color: false, location: 'Bilinmiyor',
 * totalPrinted: 0` ile doluyordu; yani cihaza hiç ulaşılamamışken arayüzde
 * "Lazer • Siyah-Beyaz, 0 sayfa" diye kendinden emin bir envanter satırı
 * çıkıyor, üstelik teşhis metni known_printers.model sütununa kalıcı olarak
 * yazılıyordu.
 *
 * @param {string} ip
 */
function unqueriedPrinter(ip) {
    return {
        ip,
        name: `Yazıcı (${ip})`,
        model: '',            // sysDescr okunamadı
        type: '',             // baskı teknolojisi bilinmiyor
        color: null,          // renkli mi bilinmiyor
        mac: '',
        location: '',         // sysLocation okunamadı
        status: 'offline',
        statusText: 'Sorgulanıyor...',
        serialNumber: '',
        firmware: '',
        toner: { black: -1 }, // -1 = bilinmiyor
        paperTrays: [],
        totalPrinted: null,   // sayaç okunamadı — 0 "hiç basmadı" demek olurdu
        monthlyPrinted: null,
        snmpAvailable: false,
        printerMib: false,
        errors: [],
        alertKaynak: '',
        needsService: false
    };
}

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

// ============================================
// YAZICI KİMLİĞİ VE TARAMA BİRLEŞTİRME
// Saf mantık printer-identity.js'de (test edilebilir); DB'ye dokunan
// yan etkiler burada.
// ============================================

/**
 * Bir yazıcının IP'si değiştiğinde IP ile anahtarlanmış yan tabloları taşır;
 * demirbaş kaydı ve sayaç geçmişi kopmasın diye.
 */
function migratePrinterIp(oldIp, newIp) {
    const target = db.prepare('SELECT 1 FROM printer_assets WHERE printer_ip = ?').get(newIp);

    const tx = db.transaction(() => {
        // Hedef IP'de zaten bir demirbaş kaydı varsa üzerine yazma —
        // o kayıt başka bir cihaza ait olabilir.
        if (!target) {
            db.prepare('UPDATE printer_assets SET printer_ip = ? WHERE printer_ip = ?').run(newIp, oldIp);
        }
        db.prepare('UPDATE printer_readings SET printer_ip = ? WHERE printer_ip = ?').run(newIp, oldIp);
        db.prepare('DELETE FROM known_printers WHERE printer_ip = ?').run(oldIp);
    });
    tx();

    audit({
        actor: 'system', action: 'printer_ip_change', entity: 'printer', entity_id: newIp,
        detail: target
            ? `${oldIp} → ${newIp} (hedef IP'de demirbaş kaydı vardı, taşınmadı)`
            : `${oldIp} → ${newIp}`
    });
}

/**
 * Bir koşul sağlanana kadar (ya da zaman aşımına kadar) bekler.
 * @returns {Promise<boolean>} koşul sağlandıysa true
 */
function waitUntil(cond, timeoutMs, stepMs = 200) {
    return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
            if (cond()) return resolve(true);
            if (Date.now() >= deadline) return resolve(false);
            setTimeout(tick, stepMs);
        };
        tick();
    });
}

/**
 * printer_stale_days ayarını uygular ve düşürülen kayıtları denetim loguna yazar.
 */
function pruneStale(list) {
    const days = parseInt(getSetting('printer_stale_days'), 10) || 0;
    const { kept, dropped } = pruneStalePrinters(list, days);

    if (dropped.length > 0) {
        audit({
            actor: 'system', action: 'prune', entity: 'printer',
            detail: `${days} gündür cevap vermeyen ${dropped.length} kayıt düşürüldü: `
                + dropped.map(p => p.ip).join(', ').slice(0, 500)
        });
        console.log(`[Budama] ${dropped.length} eskiyen yazıcı kaydı düşürüldü (eşik: ${days} gün).`);
    }
    return kept;
}

/**
 * Bu makinenin bağlı olduğu ağları tarama hedefi olarak önerir.
 *
 * Sabit bir varsayılan IP aralığı yerine işletim sisteminin bildirdiği
 * arayüz adres/maskesinden türetilir — yani öneri ÖLÇÜLEN veridir, varsayım
 * değil. Kullanıcı yine de onaylamadan hiçbir şey taranmaz.
 */
app.get('/api/network/suggest', (req, res) => {
    const networks = [];
    const gorulen = new Set();

    for (const [iface, adresler] of Object.entries(os.networkInterfaces())) {
        for (const a of adresler || []) {
            // Node 18+ family'yi 'IPv4' (string) verir; eski sürümlerde 4 (sayı).
            const ipv4 = a.family === 'IPv4' || a.family === 4;
            if (!ipv4 || a.internal || !a.cidr) continue;

            const bits = parseInt(String(a.cidr).split('/')[1], 10);
            if (!Number.isFinite(bits) || bits < 8 || bits > 32) continue;

            // Ağ adresi + maske biçiminde normalleştir (a.cidr host adresini taşır).
            const oktet = a.address.split('.').map(Number);
            const ipNum = (oktet[0] * 16777216) + (oktet[1] * 65536) + (oktet[2] * 256) + oktet[3];
            const maske = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
            const ag = (ipNum & maske) >>> 0;
            const agIp = [ag >>> 24, (ag >>> 16) & 0xFF, (ag >>> 8) & 0xFF, ag & 0xFF].join('.');
            const cidr = `${agIp}/${bits}`;

            if (gorulen.has(cidr)) continue;
            gorulen.add(cidr);
            networks.push({ cidr, iface, address: a.address, netmask: a.netmask });
        }
    }
    res.json({ networks });
});

app.post('/api/scan', requireRole('operator'), async (req, res) => {
    if (scanStatus.scanning) {
        // Gerçekten bir tarama sürüyorsa reddet; ama arka plan yenilemesi
        // (açılışta 50 yazıcı × SNMP timeout = dakikalar) kullanıcının
        // taramasını bloklamamalı — yenilemeyi durdurup devam ederiz.
        if (!refreshing) {
            return res.status(409).json({ error: 'Tarama zaten devam ediyor.' });
        }

        refreshAbort = true;
        scanStatus.message = 'Arka plan yenilemesi durduruluyor...';
        const durdu = await waitUntil(() => !refreshing, 20000);
        if (!durdu) {
            return res.status(409).json({
                error: 'Arka plan yenilemesi durdurulamadı; birkaç saniye sonra tekrar deneyin.'
            });
        }
    }

    const start = parseInt(req.body.start, 10) || 1;
    const end = parseInt(req.body.end, 10) || 254;

    // Serbest hedef listesi (birden çok, bitişik olmayan aralık) önceliklidir;
    // boşsa eski taban IP + maske yoluna düşülür.
    // Tarama hedefi için varsayılan YOKTUR: burada bir zamanlar belirli bir
    // müşteri ağı (192.168.2.18//22) sabitti ve yapılandırma yapılmamış her
    // kurulum, kullanıcının ağıyla ilgisi olmayan 1022 adresi tarıyordu.
    const targets = (req.body.targets != null ? req.body.targets : getSetting('scan_targets')) || '';
    const baseIp = req.body.baseIp || getSetting('scan_base_ip') || '';
    const cidr = req.body.cidr || getSetting('scan_cidr') || '24';

    if (!String(targets).trim() && !String(baseIp).trim()) {
        const mesaj = 'Tarama hedefi tanımlı değil — Ayarlar > Ağ Tarama bölümünden '
            + 'yazıcılarınızın bulunduğu ağı girin.';
        scanStatus = { scanning: false, progress: 0, total: 0, scanned: 0, found: 0, message: mesaj };
        return res.status(400).json({ error: mesaj });
    }

    const subnets = String(targets).trim()
        ? parseScanTargets(targets)
        : getSubnetsForCIDR(baseIp, cidr);
    const scope = String(targets).trim() ? String(targets).trim() : `${baseIp}/${cidr}`;

    // Geçersiz hedef → total 0 olur ve ilerleme NaN'a döner; hiç başlatma.
    if (subnets.length === 0) {
        scanStatus = {
            scanning: false, progress: 0, total: 0, scanned: 0, found: 0,
            message: 'Geçersiz tarama hedefi — ayarlardaki IP/CIDR değerlerini kontrol edin.'
        };
        return res.status(400).json({ error: scanStatus.message });
    }

    scanStatus = {
        scanning: true, progress: 0,
        total: subnets.length * (end - start + 1),
        scanned: 0, found: 0, message: 'Ağ taranıyor...'
    };

    scanAborted = false;

    audit({ actor: currentUser(req).username, action: 'scan', entity: 'network', detail: scope, ip: clientIp(req) });
    // subnets listesi geniş maskelerde milyon satır olabilir — yanıtta sayısı yeter
    res.json({ message: 'Tarama başlatıldı.', subnetCount: subnets.length, total: scanStatus.total });

    try {
        const snmpOpts = snmpCommunity();
        const { found: hosts, summary } = await scanNetwork({
            subnets, start, end, snmpOpts,
            shouldStop: () => scanAborted,
            onProgress: (scanned, total, found) => {
                scanStatus.scanned = scanned;
                scanStatus.total = total;
                scanStatus.found = found;
                scanStatus.progress = total > 0 ? Math.round((scanned / total) * 100) : 0;
                // "aday" = portu açık VEYA SNMP'ye cevap veren her cihaz.
                // Yazıcı olup olmadığı SNMP aşamasından sonra belirlenir, bu
                // yüzden sayı nihai yazıcı sayısından yüksek olur; tarama
                // ilerledikçe de kümülatif arttığı açıkça yazılır.
                scanStatus.message = `Taranıyor... ${scanned}/${total} IP `
                    + `— şu ana dek ${found} cihaz yanıt verdi (yazıcı ayıklaması sonra)`;
            }
        });

        scanStatus.message = `${hosts.length} cihaza SNMP sorgusu yapılıyor...`;

        // SNMP sorguları 6'lı gruplar halinde paralel (en büyük hız kazancı)
        const queried = await mapConcurrent(hosts, 6, async (host) => {
            scanStatus.message = `SNMP sorgulanıyor: ${host.ip}`;
            try {
                const info = await queryPrinter(host.ip, snmpOpts, queryOpts());
                info.openPorts = host.ports;
                info.snmpOpen = host.snmpOpen;
                return info;
            } catch (e) {
                return {
                    ...unqueriedPrinter(host.ip),
                    status: 'online', statusText: 'Çevrim İçi', lastSeen: 'Şimdi',
                    openPorts: host.ports, snmpOpen: host.snmpOpen
                };
            }
        });

        // Yanlış pozitif filtresi: SNMP'ye her yönetilebilir switch/sunucu cevap
        // verir. Yazıcı portu AÇIK olmayıp yalnızca SNMP ile bulunan adaylar
        // ancak Printer MIB'e cevap veriyorsa listeye alınır.
        const results = queried.filter(p => (p.openPorts || []).length > 0 || p.printerMib);
        const rejected = queried.length - results.length;

        discoveredPrinters = mergeScanResults(discoveredPrinters, results, migratePrinterIp);
        // Yarım kalan tarama yüzünden kayıt silinmesin
        if (!scanAborted) discoveredPrinters = pruneStale(discoveredPrinters);

        readings.recordAll(discoveredPrinters); // ISO A.8.16 — zaman serisi kaydı
        saveKnownPrinters();                    // yeniden açılışta hatırlanır

        // Kapsam teşhisi: "128 subnetin 121'i boş" bilgisi, taramanın gerçekten
        // doğru aralıkları hedefleyip hedeflemediğini tek bakışta gösterir.
        console.log(`[Tarama] ${scope} — ${summary.started}/${summary.subnets} subnet tarandı, `
            + `${summary.withHits} tanesinde sonuç var, ${summary.empty} tanesi boş. `
            + `${results.length} yazıcı (${rejected} SNMP adayı yazıcı değil diye elendi).`);

        scanStatus = {
            scanning: false, progress: 100, total: scanStatus.total,
            scanned: scanStatus.total, found: discoveredPrinters.length,
            subnetSummary: summary,
            message: (scanAborted ? 'Tarama durduruldu. ' : 'Tarama tamamlandı. ')
                + `${queried.length} cihaz yanıt verdi, ${results.length}'i yazıcı `
                + `(${rejected} tanesi yazıcı değil diye elendi). `
                + `Liste: ${discoveredPrinters.length} kayıt, `
                + `${summary.withHits}/${summary.started} subnette sonuç var.`
        };
    } catch (e) {
        scanStatus = { scanning: false, progress: 0, total: 0, scanned: 0, found: 0, message: `Tarama hatası: ${e.message}` };
    } finally {
        scanAborted = false;
    }
});

// Devam eden taramayı durdurur — geniş maskelerde (/8, /4) tarama günler
// sürebileceği için kullanıcı elde edilen sonuçla erken bitirebilmeli.
app.post('/api/scan/stop', requireRole('operator'), (req, res) => {
    if (!scanStatus.scanning) return res.json({ message: 'Devam eden tarama yok.' });
    scanAborted = true;
    scanStatus.message = 'Tarama durduruluyor...';
    audit({ actor: currentUser(req).username, action: 'scan_stop', entity: 'network', ip: clientIp(req) });
    res.json({ message: 'Tarama durduruluyor.' });
});

// ============================================
// YAZICI KALICILIĞI
// Keşfedilen yazıcılar DB'de saklanır; uygulama yeniden açıldığında
// tarama beklemeden bilinen IP'ler otomatik sorgulanır.
// ============================================
function saveKnownPrinters() {
    // printer_ip birincil anahtar: aynı IP iki kez gelirse düz INSERT tüm
    // transaction'ı devirirdi. Kimlik birleştirmesinden sonra bu olmamalı,
    // ama kayıt sessizce kaybolmasın diye son bir güvenlik ağı.
    const byIp = new Map();
    for (const p of discoveredPrinters) {
        if (p && p.ip) byIp.set(p.ip, p);
    }

    const tx = db.transaction(() => {
        db.prepare('DELETE FROM known_printers').run();
        const ins = db.prepare(`INSERT OR REPLACE INTO known_printers
                                (printer_ip, name, model, open_ports, serial_number, mac, first_seen, last_online, last_seen)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`);
        for (const p of byIp.values()) {
            ins.run(p.ip, p.name || '', p.model || '', JSON.stringify(p.openPorts || []),
                p.serialNumber || '', p.mac || '', p.firstSeen || '', p.lastOnline || '');
        }
    });
    tx();
}

function loadKnownPrinters() {
    const rows = db.prepare('SELECT * FROM known_printers ORDER BY printer_ip').all();
    // Yalnızca DB'de GERÇEKTEN kayıtlı alanlar doldurulur; gerisi arka plan
    // yenilemesi cevap verene kadar "bilinmiyor" kalır (bkz. unqueriedPrinter).
    return rows.map((r, i) => ({
        ...unqueriedPrinter(r.printer_ip),
        id: i + 1,
        name: r.name || `Yazıcı (${r.printer_ip})`,
        model: r.model || '',
        mac: r.mac || '',
        serialNumber: r.serial_number || '',
        lastSeen: r.last_seen,
        firstSeen: r.first_seen || r.last_seen || '',
        // last_online yoksa (bu kolondan önceki kurulumlar) last_seen'e düş —
        // aksi halde budama tüm eski kayıtları bir anda silerdi.
        lastOnline: r.last_online || r.last_seen || '',
        openPorts: safeJson(r.open_ports)
    }));
}

function safeJson(s) { try { return JSON.parse(s) || []; } catch { return []; } }

// Tüm bilinen yazıcıları yeniden sorgular (manuel yenileme + otomatik zamanlayıcı ortak yolu)
// SNMP sorguları 6'lı gruplar halinde paralel çalışır.
async function refreshAllPrinters() {
    refreshing = true;
    refreshAbort = false;
    scanStatus.scanning = true;
    scanStatus.message = 'Yazıcılar yenileniyor...';

    let done = 0;
    const targets = discoveredPrinters.slice();
    const total = targets.length;

    try {
    await mapConcurrent(targets, 6, async (p) => {
        // Kullanıcı tarama başlattıysa yenilemeyi bırak — sıradaki yazıcılar
        // atlanır, o ana kadar toplananlar korunur.
        if (refreshAbort) return true;
        // Yakalanmış indeksle yazmak, tarama diziyi bu sırada değiştirirse
        // yanlış slota yazıp kopya IP üretiyordu — her seferinde IP'den bul.
        const at = () => discoveredPrinters.findIndex(x => x.ip === p.ip);
        try {
            const info = await queryPrinter(p.ip, snmpCommunity(), queryOpts());
            const i = at();
            if (i >= 0) {
                // queryPrinter, SNMP tamamen sessiz kalsa da hata fırlatmaz —
                // snmpAvailable:false olan bir nesne döner. Bunu "görüldü"
                // saymak fişi çekilmiş cihazı "Çevrim İçi (SNMP Kapalı)"
                // gösteriyor ve lastOnline'ı tazeleyip budamayı etkisiz
                // kılıyordu. SNMP sessizse erişimi TCP porttan teyit et.
                let erisildi = info.snmpAvailable;
                if (!erisildi) {
                    const tcp = await scanHost(p.ip);
                    erisildi = tcp !== null;
                    if (erisildi) {
                        info.openPorts = tcp.ports;
                        info.status = 'online';
                        info.statusText = 'Çevrim İçi (SNMP Kapalı)';
                    } else {
                        info.status = 'offline';
                        info.statusText = 'Çevrim Dışı';
                        info.lastSeen = discoveredPrinters[i].lastSeen;
                    }
                }

                discoveredPrinters[i] = {
                    ...discoveredPrinters[i], ...info,
                    id: discoveredPrinters[i].id,
                    openPorts: info.openPorts || discoveredPrinters[i].openPorts,
                    serialNumber: info.serialNumber || discoveredPrinters[i].serialNumber || '',
                    mac: info.mac || discoveredPrinters[i].mac || '',
                    // Yalnızca gerçekten cevap verdiyse tazele — budama buna bakıyor
                    lastOnline: erisildi
                        ? new Date().toISOString()
                        : discoveredPrinters[i].lastOnline
                };
            }
        } catch (e) {
            const i = at();
            if (i >= 0) {
                discoveredPrinters[i] = {
                    ...discoveredPrinters[i],
                    lastSeen: 'Bağlantı hatası', status: 'offline', statusText: 'Çevrim Dışı'
                };
            }
        }
        done++;
        scanStatus.message = `Yenileniyor... ${done}/${total}`;
        return true;
    });

        readings.recordAll(discoveredPrinters); // ISO A.8.16 — zaman serisi
        readings.pruneReadings(parseInt(getSetting('readings_retention_days'), 10) || 90); // saklama politikası
        saveKnownPrinters();
    } finally {
        // refreshing EN SON temizlenir: /api/scan bunun düşmesini bekliyor,
        // beklemesi bittiğinde scanStatus.scanning zaten false olmalı.
        scanStatus.scanning = false;
        scanStatus.message = refreshAbort ? 'Yenileme durduruldu.' : 'Yenileme tamamlandı.';
        refreshing = false;
    }
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
    const minutes = parseInt(getSetting('auto_refresh_minutes'), 10) || 0;
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
        // Kullanıcı ilk 2 saniyede "Ağı Tara"ya bastıysa yenileme taramayla
        // yarışır ve listeyi bozar — zamanlayıcı yolundaki korumanın aynısı.
        if (scanStatus.scanning) return;
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
        name, color || 'black', printer_model || '', parseInt(yield_pages, 10) || 0,
        parseFloat(unit_cost) || 0, currency || getSetting('currency') || 'TRY', parseInt(min_stock, 10) || 2);
    audit({ actor: currentUser(req).username, action: 'create', entity: 'toner_type', entity_id: info.lastInsertRowid, detail: name, ip: clientIp(req) });
    res.json({ id: info.lastInsertRowid });
});

app.put('/api/toner-types/:id', requireRole('operator'), requireIdParam, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const cur = db.prepare('SELECT * FROM toner_types WHERE id = ?').get(id);
    if (!cur) return res.status(404).json({ error: 'Toner türü bulunamadı.' });
    const b = req.body || {};
    db.prepare(`UPDATE toner_types SET name=?, color=?, printer_model=?, yield_pages=?, unit_cost=?, currency=?, min_stock=? WHERE id=?`).run(
        b.name ?? cur.name, b.color ?? cur.color, b.printer_model ?? cur.printer_model,
        b.yield_pages != null ? parseInt(b.yield_pages, 10) : cur.yield_pages,
        b.unit_cost != null ? parseFloat(b.unit_cost) : cur.unit_cost,
        b.currency ?? cur.currency, b.min_stock != null ? parseInt(b.min_stock, 10) : cur.min_stock, id);
    audit({ actor: currentUser(req).username, action: 'update', entity: 'toner_type', entity_id: id, ip: clientIp(req) });
    res.json({ ok: true });
});

app.delete('/api/toner-types/:id', requireRole('operator'), requireIdParam, (req, res) => {
    const id = parseInt(req.params.id, 10);
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
    const { toner_type_id, direction, quantity, unit_cost, printer_ip, note,
            movement_date, supplier, recipient } = req.body || {};
    const qty = parseInt(quantity, 10);
    if (!toner_type_id || !['in', 'out'].includes(direction) || !qty || qty <= 0) {
        return res.status(400).json({ error: 'Geçersiz stok hareketi.' });
    }
    const type = db.prepare('SELECT * FROM toner_types WHERE id = ?').get(toner_type_id);
    if (!type) return res.status(404).json({ error: 'Toner türü bulunamadı.' });

    // Gerçek işlem tarihi — geriye dönük giriş için (YYYY-MM-DD); geçersizse bugün
    const mDate = (typeof movement_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(movement_date))
        ? movement_date
        : new Date().toISOString().slice(0, 10);

    // supplier (tedarikçi) ve recipient (teslim alan) GERÇEK alanlardır ve boş
    // kalabilir. Excel dışa aktarımı bunları eskiden nottan / actor'dan
    // türetiyordu; actor işlemi giren operatördür, tonerı teslim alan kişi değil.
    const actor = currentUser(req).username;
    const info = db.prepare(`INSERT INTO stock_movements
        (toner_type_id, direction, quantity, unit_cost, printer_ip, note, actor, movement_date, supplier, recipient)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        toner_type_id, direction, qty,
        unit_cost != null ? parseFloat(unit_cost) : type.unit_cost,
        printer_ip || null, note || '', actor, mDate,
        String(supplier || '').trim(), String(recipient || '').trim());
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
// TONER TAKİP EXCEL DIŞA AKTARMA
// Tek tuşla, şirketteki Toner_Takip.xlsx ile birebir aynı yapıda
// 5 sayfalık çalışma kitabı üretir (ISO 27001 A.5.9 / A.8.15).
// ============================================
app.get('/api/export/toner-excel', (req, res) => {
    try {
        const { buffer, stats } = tonerExport.buildWorkbook();
        const filename = tonerExport.buildFileName();

        audit({
            actor: currentUser(req).username, action: 'export', entity: 'toner_excel',
            detail: `${filename} (${stats.degisim} değişim, ${stats.giris} giriş, ${stats.tonerTypes} toner türü)`,
            ip: clientIp(req)
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Length', buffer.length);
        res.send(buffer);
    } catch (e) {
        console.error('[Export] Toner Excel üretilemedi:', e.message);
        res.status(500).json({ error: 'Excel dosyası oluşturulamadı.' });
    }
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

app.put('/api/inventory/device/:id', requireRole('operator'), requireIdParam, (req, res) => {
    try {
        inventory.updateDevice(parseInt(req.params.id, 10), req.body || {});
        audit({ actor: currentUser(req).username, action: 'update', entity: 'device', entity_id: req.params.id, ip: clientIp(req) });
        res.json({ ok: true });
    } catch (e) {
        safeError(res, e, 'Cihaz güncellenemedi.');
    }
});

app.delete('/api/inventory/device/:id', requireRole('operator'), requireIdParam, (req, res) => {
    try {
        inventory.deleteDevice(parseInt(req.params.id, 10));
        audit({ actor: currentUser(req).username, action: 'delete', entity: 'device', entity_id: req.params.id, ip: clientIp(req) });
        res.json({ ok: true });
    } catch (e) {
        safeError(res, e, 'Cihaz silinemedi.');
    }
});

// ============================================
// KULLANICI ERİŞİM RAPORU (ISO A.5.18 gözden geçirme kanıtı)
// Kişinin tüm erişim profili tek yanıtta: gruplar, klasörler,
// uygulamalar, cihazlar.
// ============================================
app.get('/api/report/user-access/:sam', async (req, res) => {
    try {
        const user = await ad.getUserDetail(req.params.sam);
        const devices = inventory.getDevicesForUser(user.sam);
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
            devices
        });
    } catch (e) {
        safeError(res, e, 'Erişim raporu oluşturulamadı.');
    }
});

// ============================================
// AYARLAR & DENETİM LOGU
// ============================================
const SETTING_KEYS = ['currency', 'scan_base_ip', 'scan_cidr', 'scan_targets', 'printer_stale_days', 'snmp_community', 'ad_url', 'ad_base_dn', 'ad_bind_dn', 'ad_password', 'ad_share_roots', 'ad_tls_insecure', 'auto_refresh_minutes', 'winrm_enabled', 'app_access_map', 'readings_retention_days',
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
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
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
