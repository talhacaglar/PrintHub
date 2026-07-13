// ============================================
// PrintHub — Frontend Application
// Gerçek ağ yazıcılarını API'den çeker.
// ============================================

const API_BASE = ''; // Aynı origin'de çalıştığı için boş

// ============================================
// STATE
// ============================================
let printers = [];
let notifications = [];
let currentFilter = "all";
let currentView = "grid";
let searchQuery = "";
let isScanning = false;
let scanPollInterval = null;
let autoRefreshInterval = null;

// Oturum / RBAC
let session = null; // { id, username, role }
const ROLE_LEVEL = { viewer: 1, operator: 2, admin: 3 };
let appInitialized = false;

// ============================================
// DOM REFERENCES
// ============================================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ============================================
// INITIALIZE
// ============================================
document.addEventListener("DOMContentLoaded", () => {
    setupTheme();
    setupAuthListeners();
    bootstrap();
});

// ============================================
// TEMA (açık/karanlık)
// ============================================
function setupTheme() {
    updateThemeIcon();
    document.getElementById("themeBtn").addEventListener("click", toggleTheme);
}

function toggleTheme() {
    const isLight = document.documentElement.dataset.theme === 'light';
    if (isLight) {
        delete document.documentElement.dataset.theme;
        localStorage.setItem('printhub-theme', 'dark');
    } else {
        document.documentElement.dataset.theme = 'light';
        localStorage.setItem('printhub-theme', 'light');
    }
    updateThemeIcon();
}

function updateThemeIcon() {
    const isLight = document.documentElement.dataset.theme === 'light';
    const icon = document.getElementById("themeIcon");
    if (icon) icon.textContent = isLight ? 'dark_mode' : 'light_mode';
}

// ============================================
// AUTH / OTURUM
// ============================================
async function bootstrap() {
    try {
        const res = await fetch(`${API_BASE}/api/me`);
        if (res.ok) {
            const data = await res.json();
            onLoggedIn(data.user);
            return;
        }
    } catch (e) { /* sunucu hazır değil */ }
    showLogin();
}

function showLogin() {
    document.getElementById("loginOverlay").classList.add("show");
}

function onLoggedIn(user) {
    session = user;
    document.getElementById("loginOverlay").classList.remove("show");

    // Kullanıcı bilgisini doldur
    document.getElementById("userAvatar").textContent = (user.username || '?').slice(0, 2).toUpperCase();
    document.getElementById("userName").textContent = user.username;
    const roleLabels = { admin: 'Yönetici', operator: 'Operatör', viewer: 'Görüntüleyici' };
    document.getElementById("userRole").textContent = roleLabels[user.role] || user.role;

    applyRoleVisibility();

    if (!appInitialized) {
        appInitialized = true;
        showWelcomeState();
        updateStats();
        updateTime();
        setInterval(updateTime, 1000);
        setupEventListeners();
    }
    fetchPrinters();
}

// Rol seviyesine göre nav öğelerini gizle/göster (ISO 27001 A.5.15)
function applyRoleVisibility() {
    const level = ROLE_LEVEL[session?.role] || 0;
    document.querySelectorAll('.nav-item[data-min-role]').forEach(item => {
        const need = ROLE_LEVEL[item.dataset.minRole] || 0;
        item.style.display = level >= need ? '' : 'none';
    });
}

function hasRole(role) {
    return (ROLE_LEVEL[session?.role] || 0) >= (ROLE_LEVEL[role] || 99);
}

function setupAuthListeners() {
    document.getElementById("loginForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const username = document.getElementById("loginUser").value.trim();
        const password = document.getElementById("loginPass").value;
        const errEl = document.getElementById("loginError");
        errEl.textContent = "";
        try {
            const res = await fetch(`${API_BASE}/api/login`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();
            if (!res.ok) { errEl.textContent = data.error || "Giriş başarısız."; return; }
            document.getElementById("loginPass").value = "";
            onLoggedIn(data.user);
            if (data.mustChangePassword) openPwModal(true);
        } catch (err) {
            errEl.textContent = "Sunucuya bağlanılamadı.";
        }
    });

    document.getElementById("logoutBtn").addEventListener("click", async () => {
        await fetch(`${API_BASE}/api/logout`, { method: 'POST' });
        session = null;
        if (autoRefreshInterval) clearInterval(autoRefreshInterval);
        printers = [];
        showLogin();
    });

    // Parola değiştir formu
    document.getElementById("pwForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const errEl = document.getElementById("pwError");
        errEl.textContent = "";
        const body = {
            currentPassword: document.getElementById("pwCurrent").value,
            newPassword: document.getElementById("pwNew").value
        };
        const res = await fetch(`${API_BASE}/api/change-password`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) { errEl.textContent = data.error || "Değiştirilemedi."; return; }
        document.getElementById("pwModalOverlay").classList.remove("show");
        document.getElementById("pwForm").reset();
    });
}

function openPwModal(forced) {
    const err = document.getElementById("pwError");
    err.textContent = forced ? "İlk giriş: güvenlik için parolanızı değiştirin." : "";
    document.getElementById("pwModalOverlay").classList.add("show");
}

// 401 gelirse oturumu düşür
async function apiFetch(url, opts) {
    const res = await fetch(url, opts);
    if (res.status === 401) { session = null; showLogin(); }
    return res;
}

// ============================================
// API CALLS
// ============================================

async function fetchPrinters() {
    try {
        const res = await fetch(`${API_BASE}/api/printers`);
        const data = await res.json();
        printers = data.printers || [];

        if (printers.length > 0) {
            generateNotifications();
            updateStats();
            renderPrinters();
        } else {
            showWelcomeState();
        }
    } catch (e) {
        console.log('API bağlantısı yok, bekleniyor...');
    }
}

async function startScan() {
    if (isScanning) return;

    isScanning = true;
    const scanBtn = document.getElementById("scanBtn");
    scanBtn.classList.add("scanning");
    scanBtn.querySelector('.scan-btn-text').textContent = "Taranıyor...";

    // Progress bar'ı göster
    const progressBar = document.getElementById("scanProgressBar");
    progressBar.style.display = "block";
    document.getElementById("scanProgressFill").style.width = "0%";
    document.getElementById("scanStatusText").textContent = "Ağ taraması başlatılıyor...";

    try {
        await fetch(`${API_BASE}/api/scan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                baseIp: '192.168.2.18',
                cidr: '22'
            })
        });

        // Tarama durumunu periyodik olarak kontrol et
        scanPollInterval = setInterval(pollScanStatus, 1000);
    } catch (e) {
        console.error('Tarama başlatılamadı:', e);
        isScanning = false;
        scanBtn.classList.remove("scanning");
        scanBtn.querySelector('.scan-btn-text').textContent = "Ağı Tara";
        progressBar.style.display = "none";
    }
}

async function pollScanStatus() {
    try {
        const res = await fetch(`${API_BASE}/api/status`);
        const status = await res.json();

        document.getElementById("scanProgressFill").style.width = status.progress + "%";
        document.getElementById("scanStatusText").textContent = status.message;

        // Tarama sırasında da yazıcıları çek (anlık güncelleme)
        if (status.found > 0) {
            await fetchPrinters();
        }

        if (!status.scanning) {
            clearInterval(scanPollInterval);
            scanPollInterval = null;
            isScanning = false;

            const scanBtn = document.getElementById("scanBtn");
            scanBtn.classList.remove("scanning");
            scanBtn.querySelector('.scan-btn-text').textContent = "Ağı Tara";

            // Son kez yazıcıları çek
            await fetchPrinters();

            // Progress bar'ı 2 sn sonra gizle
            setTimeout(() => {
                document.getElementById("scanProgressBar").style.display = "none";
            }, 2000);

            // Otomatik yenilemeyi başlat
            startAutoRefresh();
        }
    } catch (e) {
        console.error('Durum sorgulanamadı:', e);
    }
}

async function refreshPrinters() {
    try {
        const icon = document.querySelector("#refreshBtn .material-icons-round");
        icon.classList.add("spinning");

        await fetch(`${API_BASE}/api/refresh`, { method: 'POST' });

        // Yenileme tamamlanana kadar bekle
        let retries = 0;
        const checkRefresh = setInterval(async () => {
            const res = await fetch(`${API_BASE}/api/status`);
            const status = await res.json();
            retries++;

            if (!status.scanning || retries > 30) {
                clearInterval(checkRefresh);
                await fetchPrinters();
                icon.classList.remove("spinning");
            }
        }, 1000);
    } catch (e) {
        console.error('Yenileme hatası:', e);
    }
}

function startAutoRefresh() {
    if (autoRefreshInterval) clearInterval(autoRefreshInterval);
    autoRefreshInterval = setInterval(() => {
        if (!isScanning) {
            fetchPrinters();
        }
    }, 30000); // Her 30 saniyede yenile
}

// ============================================
// NOTIFICATIONS (gerçek verilere göre oluştur)
// ============================================
async function generateNotifications() {
    notifications = [];
    const now = new Date();

    // Düşük stok uyarıları (stok modülü entegrasyonu)
    try {
        const res = await apiFetch(`${API_BASE}/api/stock`);
        if (res.ok) {
            const data = await res.json();
            for (const s of (data.stock || [])) {
                if (s.low) {
                    notifications.push({
                        type: "warning",
                        icon: "inventory_2",
                        title: "Düşük Toner Stoğu",
                        desc: `${s.name} — kalan: ${s.current_stock} (eşik: ${s.min_stock})`,
                        time: "Şimdi"
                    });
                }
            }
        }
    } catch (e) { /* stok servisi yoksa sessiz geç */ }

    for (const printer of printers) {
        // Düşük toner uyarısı
        if (printer.toner) {
            for (const [color, level] of Object.entries(printer.toner)) {
                if (level >= 0 && level <= 15) {
                    notifications.push({
                        type: "warning",
                        icon: "warning",
                        title: "Düşük Toner Uyarısı",
                        desc: `${printer.name} — ${color.charAt(0).toUpperCase() + color.slice(1)} %${level}`,
                        time: "Şimdi"
                    });
                }
            }
        }

        // Boş tepsi uyarısı
        if (printer.paperTrays) {
            for (const tray of printer.paperTrays) {
                if (tray.status === 'empty') {
                    notifications.push({
                        type: "error",
                        icon: "error",
                        title: "Kağıt Tepsisi Boş",
                        desc: `${printer.name} — ${tray.name}`,
                        time: "Şimdi"
                    });
                } else if (tray.status === 'low') {
                    notifications.push({
                        type: "warning",
                        icon: "warning",
                        title: "Kağıt Azalıyor",
                        desc: `${printer.name} — ${tray.name}`,
                        time: "Şimdi"
                    });
                }
            }
        }

        // Çevrimdışı uyarısı
        if (printer.status === 'offline') {
            notifications.push({
                type: "info",
                icon: "info",
                title: "Yazıcı Çevrimdışı",
                desc: `${printer.name} bağlantısı kesildi`,
                time: printer.lastSeen || "Bilinmiyor"
            });
        }

        // Hata durumu
        if (printer.status === 'error') {
            notifications.push({
                type: "error",
                icon: "error",
                title: "Yazıcı Hatası",
                desc: `${printer.name} — ${printer.statusText}`,
                time: "Şimdi"
            });
        }
    }

    // Badge güncelle
    const badge = document.getElementById("notifBadge");
    badge.textContent = notifications.length;
    badge.style.display = notifications.length > 0 ? 'flex' : 'none';

    renderNotifications();
}

// ============================================
// WELCOME STATE
// ============================================
function showWelcomeState() {
    const container = document.getElementById("printersContainer");
    if (container) {
        container.className = "printers-container grid-view";
        container.innerHTML = `
            <div class="welcome-state">
                <span class="material-icons-round welcome-icon">radar</span>
                <h3>Ağ Yazıcılarını Keşfedin</h3>
                <p>Ağınızdaki tüm yazıcıları bulmak için tarama başlatın.</p>
                <button class="welcome-scan-btn" id="welcomeScanBtn">
                    <span class="material-icons-round">radar</span>
                    Ağı Tara (192.168.0-3.x)
                </button>
            </div>
        `;
        const welcomeBtn = document.getElementById("welcomeScanBtn");
        if (welcomeBtn) {
            welcomeBtn.addEventListener("click", startScan);
        }
    }

    const listContainer = document.getElementById("printersListView");
    if (listContainer) {
        listContainer.innerHTML = `<div class="empty-state"><span class="material-icons-round">radar</span><p>Lütfen ağ taraması başlatın.</p></div>`;
    }
}

// ============================================
// STATS
// ============================================
function updateStats() {
    const total = printers.length;
    const online = printers.filter(p => p.status === "online").length;
    const offline = printers.filter(p => p.status === "offline").length;
    const warning = printers.filter(p => p.status === "warning" || p.status === "error").length;
    const queueCount = printers.reduce((sum, p) => sum + (p.queue ? p.queue.length : 0), 0);

    setStat("statTotal", total);
    setStat("statOnline", online);
    setStat("statOffline", offline);
    setStat("statWarning", warning);
    setStat("statQueue", queueCount);
}

function setStat(elementId, target) {
    const el = document.getElementById(elementId);
    if (el) el.textContent = target;
}

// ============================================
// TIME
// ============================================
function updateTime() {
    const now = new Date();
    const time = now.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
    const el = document.getElementById("currentTime");
    if (el) el.textContent = time;
}

// ============================================
// RENDER PRINTERS
// ============================================
function renderPrinters() {
    let filtered = [...printers];

    // Filter by status
    if (currentFilter !== "all") {
        if (currentFilter === "warning") {
            filtered = filtered.filter(p => p.status === "warning");
        } else if (currentFilter === "error") {
            filtered = filtered.filter(p => p.status === "error");
        } else {
            filtered = filtered.filter(p => p.status === currentFilter);
        }
    }

    // Search filter
    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        filtered = filtered.filter(p =>
            (p.name || '').toLowerCase().includes(q) ||
            (p.ip || '').includes(q) ||
            (p.location || '').toLowerCase().includes(q) ||
            (p.model || '').toLowerCase().includes(q)
        );
    }

    const container = document.getElementById("printersContainer");
    const containerList = document.getElementById("printersListView");

    const emptyHtml = `
        <div class="empty-state">
            <span class="material-icons-round">search_off</span>
            <h3>Yazıcı bulunamadı</h3>
            <p>Arama kriterlerinize uygun yazıcı bulunamadı.</p>
        </div>
    `;

    if (filtered.length === 0 && printers.length > 0) {
        if (container) container.innerHTML = emptyHtml;
        if (containerList) containerList.innerHTML = emptyHtml;
        return;
    }

    if (filtered.length === 0) {
        showWelcomeState();
        return;
    }

    const htmlCards = filtered.map((printer, index) => createPrinterCard(printer, index)).join("");

    if (container) {
        container.className = `printers-container ${currentView}-view`;
        container.innerHTML = htmlCards;
        container.querySelectorAll(".printer-card").forEach(card => {
            card.addEventListener("click", (e) => {
                if (e.target.closest(".card-action-btn")) return;
                openPrinterModal(parseInt(card.dataset.printerId));
            });
        });
    }

    if (containerList) {
        containerList.innerHTML = htmlCards;
        containerList.querySelectorAll(".printer-card").forEach(card => {
            card.addEventListener("click", (e) => {
                if (e.target.closest(".card-action-btn")) return;
                openPrinterModal(parseInt(card.dataset.printerId));
            });
        });
    }
}

function createPrinterCard(printer, index) {
    const isColor = printer.color;
    const iconClass = isColor ? "color-printer" : "";

    // Toner bilgisi var mı kontrol et
    const hasToner = printer.toner && Object.keys(printer.toner).length > 0;
    const tonerUnknown = hasToner && Object.values(printer.toner).every(v => v === -1);

    let tonerBars = '';
    if (hasToner && !tonerUnknown) {
        if (isColor) {
            const colors = ['cyan', 'magenta', 'yellow', 'black'];
            tonerBars = colors.map(color => {
                const level = printer.toner[color];
                if (level === undefined || level === -1) return '';
                return `
                    <div class="toner-row">
                        <span class="toner-label ${color}">${color[0].toUpperCase()}</span>
                        <div class="toner-bar-bg"><div class="toner-bar-fill ${color} ${level <= 15 ? 'low' : ''}" style="width:${level}%"></div></div>
                        <span class="toner-percent ${level <= 15 ? 'low' : ''}">${level}%</span>
                    </div>
                `;
            }).join('');
        } else {
            const level = printer.toner.black;
            if (level !== undefined && level !== -1) {
                tonerBars = `
                    <div class="toner-row">
                        <span class="toner-label black">K</span>
                        <div class="toner-bar-bg"><div class="toner-bar-fill black ${level <= 15 ? 'low' : ''}" style="width:${level}%"></div></div>
                        <span class="toner-percent ${level <= 15 ? 'low' : ''}">${level}%</span>
                    </div>
                `;
            }
        }
    }

    if (!tonerBars && tonerUnknown) {
        tonerBars = `<div style="font-size:11px; color:var(--text-muted); padding:4px 0;">Toner bilgisi alınamadı</div>`;
    }

    const queueLen = printer.queue ? printer.queue.length : 0;

    return `
        <div class="printer-card" data-printer-id="${printer.id}" style="animation-delay: ${index * 0.05}s">
            <div class="card-header">
                <div class="card-printer-info" style="display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0;">
                    <div class="card-printer-icon ${iconClass}">
                        <span class="material-icons-round">print</span>
                    </div>
                    <div style="min-width: 0; flex: 1;">
                        <div class="card-printer-name" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${printer.name || 'Bilinmeyen'}</div>
                        <div class="card-printer-model">${printer.type === 'inkjet' ? 'Mürekkep Püskürtmeli' : 'Lazer'} ${isColor ? '• Renkli' : '• Siyah-Beyaz'}</div>
                    </div>
                </div>
                <div class="card-status-badge ${printer.status}">
                    <span class="status-dot"></span>
                    ${printer.statusText || printer.status}
                </div>
            </div>
            <div class="card-details">
                <div class="card-detail">
                    <span class="material-icons-round">lan</span>
                    <span>${printer.ip}</span>
                </div>
                <div class="card-detail">
                    <span class="material-icons-round">location_on</span>
                    <span>${printer.customLocation || printer.location || 'Bilinmiyor'}</span>
                </div>
            </div>
            ${tonerBars ? `
            <div class="card-toner">
                <div class="card-toner-title">Toner / Mürekkep Seviyeleri</div>
                <div class="toner-bars">
                    ${tonerBars}
                </div>
            </div>` : ''}
            <div class="card-footer">
                <div class="card-queue">
                    <span class="material-icons-round">queue</span>
                    <span>Kuyruk: <span class="card-queue-count">${queueLen}</span></span>
                </div>
                <div class="card-actions">
                    <button class="card-action-btn" title="Detaylar" onclick="event.stopPropagation(); openPrinterModal(${printer.id})">
                        <span class="material-icons-round">info</span>
                    </button>
                </div>
            </div>
        </div>
    `;
}

// ============================================
// NOTIFICATIONS
// ============================================
function renderNotifications() {
    const list = document.getElementById("notifList");
    if (!list) return;

    if (notifications.length === 0) {
        list.innerHTML = `
            <div class="modal-empty-queue">
                <span class="material-icons-round">check_circle</span>
                Bildirim yok — her şey yolunda!
            </div>
        `;
        return;
    }

    list.innerHTML = notifications.map(n => `
        <div class="notif-item">
            <div class="notif-icon ${n.type}">
                <span class="material-icons-round">${n.icon}</span>
            </div>
            <div class="notif-text">
                <div class="notif-title">${n.title}</div>
                <div class="notif-desc">${n.desc}</div>
            </div>
            <span class="notif-time">${n.time}</span>
        </div>
    `).join("");
}

// ============================================
// MODAL
// ============================================
function openPrinterModal(printerId) {
    const printer = printers.find(p => p.id === printerId);
    if (!printer) return;

    const modal = document.getElementById("modalOverlay");
    const content = document.getElementById("modalContent");

    const isColor = printer.color;
    const hasToner = printer.toner && Object.keys(printer.toner).length > 0;

    // Toner items
    let tonerItems = '';
    if (hasToner) {
        if (isColor) {
            const colorMap = { cyan: 'Cyan', magenta: 'Magenta', yellow: 'Yellow', black: 'Black' };
            const colorCss = { cyan: 'var(--toner-cyan)', magenta: 'var(--toner-magenta)', yellow: 'var(--toner-yellow)', black: 'var(--toner-black)' };
            const bgCss = { black: 'var(--toner-black-bar)' };

            for (const [color, label] of Object.entries(colorMap)) {
                const level = printer.toner[color];
                if (level === undefined) continue;
                const display = level === -1 ? '?' : level + '%';
                const width = level === -1 ? 0 : level;
                const bg = bgCss[color] || colorCss[color];
                tonerItems += `
                    <div class="modal-toner-item">
                        <div class="toner-header">
                            <span class="toner-name" style="color: ${colorCss[color]}">${label}</span>
                            <span class="toner-val" style="color: ${colorCss[color]}">${display}</span>
                        </div>
                        <div class="modal-toner-bar"><div class="modal-toner-bar-fill" style="width:${width}%; background: ${bg}"></div></div>
                    </div>
                `;
            }
        } else {
            const level = printer.toner.black;
            const display = (level === -1 || level === undefined) ? '?' : level + '%';
            const width = (level === -1 || level === undefined) ? 0 : level;
            tonerItems = `
                <div class="modal-toner-item" style="grid-column: span 2">
                    <div class="toner-header">
                        <span class="toner-name" style="color: var(--toner-black)">Black Toner</span>
                        <span class="toner-val" style="color: var(--toner-black)">${display}</span>
                    </div>
                    <div class="modal-toner-bar"><div class="modal-toner-bar-fill" style="width:${width}%; background: var(--toner-black-bar)"></div></div>
                </div>
            `;
        }
    } else {
        tonerItems = '<div style="font-size:13px; color:var(--text-muted); padding: 12px;">Toner bilgisi mevcut değil.</div>';
    }

    // Paper trays
    const paperTraysHtml = (printer.paperTrays && printer.paperTrays.length > 0)
        ? printer.paperTrays.map(t => `
            <div class="modal-paper-item">
                <div class="tray-name">${t.name}</div>
                <div class="tray-size">${t.size || 'Bilinmiyor'}</div>
                <div class="tray-status ${t.status}">
                    ${t.status === 'ok' ? `✓ ${t.current}/${t.capacity}` : t.status === 'low' ? `⚠ ${t.current}/${t.capacity}` : '✕ Boş'}
                </div>
            </div>
        `).join("")
        : '<div style="font-size:13px; color:var(--text-muted); padding: 12px;">Tepsi bilgisi mevcut değil.</div>';

    // Queue
    const queueList = printer.queue || [];
    const queueHtml = queueList.length > 0
        ? queueList.map(q => `
            <div class="modal-queue-item">
                <div class="queue-item-icon">
                    <span class="material-icons-round">description</span>
                </div>
                <div class="queue-item-info">
                    <div class="queue-item-name">${q.name}</div>
                    <div class="queue-item-meta">${q.user || ''} • ${q.pages || '?'} sayfa • ${q.time || ''}</div>
                </div>
                <span class="queue-item-status ${q.status}">${q.status === 'printing' ? 'Yazdırılıyor' : 'Bekliyor'}</span>
            </div>
        `).join("")
        : `
            <div class="modal-empty-queue">
                <span class="material-icons-round">check_circle</span>
                Kuyrukta bekleyen iş yok
            </div>
        `;

    content.innerHTML = `
        <div class="modal-header">
            <div class="modal-printer-icon">
                <span class="material-icons-round">print</span>
            </div>
            <div class="modal-printer-info">
                <h2>${printer.name || 'Bilinmeyen Yazıcı'}</h2>
                <p>${printer.model || ''} • <span class="card-status-badge ${printer.status}" style="display:inline-flex; font-size:10px; padding:3px 8px; vertical-align: middle;">${printer.statusText || printer.status}</span></p>
            </div>
        </div>

        <div class="modal-section">
            <div class="modal-section-title">
                <span class="material-icons-round">info</span>
                Cihaz Bilgileri
            </div>
            <div class="modal-info-grid">
                <div class="modal-info-item">
                    <span class="material-icons-round">lan</span>
                    <div class="info-content">
                        <span class="info-label">IP Adresi</span>
                        <span class="info-value">${printer.ip}</span>
                    </div>
                </div>
                <div class="modal-info-item">
                    <span class="material-icons-round">router</span>
                    <div class="info-content">
                        <span class="info-label">MAC Adresi</span>
                        <span class="info-value">${printer.mac || 'Bilinmiyor'}</span>
                    </div>
                </div>
                <div class="modal-info-item">
                    <span class="material-icons-round">location_on</span>
                    <div class="info-content">
                        <span class="info-label">Konum</span>
                        <span class="info-value">${printer.location || 'Bilinmiyor'}</span>
                    </div>
                </div>
                <div class="modal-info-item">
                    <span class="material-icons-round">qr_code</span>
                    <div class="info-content">
                        <span class="info-label">Seri Numarası</span>
                        <span class="info-value">${printer.serialNumber || 'Bilinmiyor'}</span>
                    </div>
                </div>
                ${printer.openPorts ? `
                <div class="modal-info-item">
                    <span class="material-icons-round">settings_ethernet</span>
                    <div class="info-content">
                        <span class="info-label">Açık Portlar</span>
                        <span class="info-value">${printer.openPorts.join(', ')}</span>
                    </div>
                </div>` : ''}
                <div class="modal-info-item">
                    <span class="material-icons-round">schedule</span>
                    <div class="info-content">
                        <span class="info-label">Son Görülme</span>
                        <span class="info-value">${printer.lastSeen || 'Bilinmiyor'}</span>
                    </div>
                </div>
            </div>
        </div>

        ${printer.totalPrinted > 0 ? `
        <div class="modal-section">
            <div class="modal-section-title">
                <span class="material-icons-round">assessment</span>
                Yazdırma İstatistikleri
            </div>
            <div class="modal-info-grid">
                <div class="modal-info-item">
                    <span class="material-icons-round">print</span>
                    <div class="info-content">
                        <span class="info-label">Toplam Yazdırma</span>
                        <span class="info-value">${printer.totalPrinted.toLocaleString('tr-TR')} sayfa</span>
                    </div>
                </div>
            </div>
        </div>` : ''}

        <div class="modal-section">
            <div class="modal-section-title">
                <span class="material-icons-round">colorize</span>
                Toner / Mürekkep Seviyeleri
            </div>
            <div class="modal-toner-grid">
                ${tonerItems}
            </div>
        </div>

        <div class="modal-section">
            <div class="modal-section-title">
                <span class="material-icons-round">content_copy</span>
                Kağıt Tepsileri
            </div>
            <div class="modal-paper-grid">
                ${paperTraysHtml}
            </div>
        </div>

        <div class="modal-section">
            <div class="modal-section-title">
                <span class="material-icons-round">inventory</span>
                Varlık Bilgileri (ISO A.5.9)
            </div>
            ${hasRole('operator') ? `
            <form id="assetForm" data-ip="${printer.ip}">
                <div class="modal-info-grid" style="margin-bottom:10px">
                    <div class="form-group" style="margin:0"><label>Demirbaş No</label>
                        <input class="form-input" id="asset_tag" value="${escapeHtml(printer.assetTag || '')}" placeholder="ör: DMB-2026-014"></div>
                    <div class="form-group" style="margin:0"><label>Özel Konum</label>
                        <input class="form-input" id="asset_location" value="${escapeHtml(printer.customLocation || '')}" placeholder="ör: Kat 2 — Muhasebe"></div>
                </div>
                <div class="form-group"><label>Not</label>
                    <input class="form-input" id="asset_notes" value="${escapeHtml(printer.assetNotes || '')}" placeholder="ör: garanti bitişi, sorumlu kişi"></div>
                <button type="submit" class="mini-btn primary">Varlık Bilgisini Kaydet</button>
                <span id="assetMsg" style="font-size:12px;color:var(--status-online);margin-left:8px"></span>
            </form>` : `
            <div class="modal-info-grid">
                <div class="modal-info-item"><span class="material-icons-round">tag</span><div class="info-content"><span class="info-label">Demirbaş No</span><span class="info-value">${escapeHtml(printer.assetTag || '—')}</span></div></div>
                <div class="modal-info-item"><span class="material-icons-round">place</span><div class="info-content"><span class="info-label">Özel Konum</span><span class="info-value">${escapeHtml(printer.customLocation || '—')}</span></div></div>
                <div class="modal-info-item" style="grid-column:span 2"><span class="material-icons-round">notes</span><div class="info-content"><span class="info-label">Not</span><span class="info-value">${escapeHtml(printer.assetNotes || '—')}</span></div></div>
            </div>`}
        </div>

        <div class="modal-section">
            <div class="modal-section-title">
                <span class="material-icons-round">trending_up</span>
                Toner Tüketim Geçmişi
            </div>
            <div id="printerHistory"><div class="note-box">Yükleniyor...</div></div>
        </div>

        <div class="modal-section">
            <div class="modal-section-title">
                <span class="material-icons-round">queue</span>
                Yazdırma Kuyruğu (${queueList.length})
            </div>
            <div class="modal-queue-list">
                ${queueHtml}
            </div>
        </div>
    `;

    modal.classList.add("show");
    document.body.style.overflow = "hidden";
    loadPrinterHistory(printer.ip);

    // Varlık formu (operator+)
    const assetForm = document.getElementById("assetForm");
    if (assetForm) {
        assetForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            const ip = assetForm.dataset.ip;
            const body = {
                asset_tag: document.getElementById("asset_tag").value.trim(),
                custom_location: document.getElementById("asset_location").value.trim(),
                notes: document.getElementById("asset_notes").value.trim()
            };
            const res = await apiFetch(`${API_BASE}/api/printer/${encodeURIComponent(ip)}/asset`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
            });
            const msg = document.getElementById("assetMsg");
            msg.textContent = res.ok ? "Kaydedildi ✓" : "Hata!";
            if (res.ok) {
                // Yerel listeyi güncelle (kart görünümü için)
                const p = printers.find(x => x.ip === ip);
                if (p) { p.assetTag = body.asset_tag; p.customLocation = body.custom_location; p.assetNotes = body.notes; }
                renderPrinters();
            }
            setTimeout(() => { msg.textContent = ""; }, 2000);
        });
    }
}

// Yazıcı okuma geçmişini modalde göster (sayfa sayacı değişimi + toner)
async function loadPrinterHistory(ip) {
    const host = document.getElementById("printerHistory");
    if (!host) return;
    try {
        const res = await apiFetch(`${API_BASE}/api/printer/${encodeURIComponent(ip)}/history`);
        const data = await res.json();
        const hist = data.history || [];
        if (hist.length < 2) {
            host.innerHTML = `<div class="note-box">Yeterli geçmiş veri yok. Tüketim, birden fazla tarama/yenileme sonrası hesaplanır.</div>`;
            return;
        }
        const first = hist[0], last = hist[hist.length - 1];
        const delta = (last.total_printed || 0) - (first.total_printed || 0);
        const rows = hist.slice(-10).reverse().map(h => {
            const toner = Object.entries(h.toner || {}).filter(([, v]) => v >= 0)
                .map(([c, v]) => `${(COLOR_LABEL[c] || c)[0]}:${v}%`).join(' ');
            return `<tr><td style="font-size:11px">${escapeHtml(h.captured_at)}</td><td>${(h.total_printed || 0).toLocaleString('tr-TR')}</td><td style="font-size:12px">${toner || '-'}</td></tr>`;
        }).join('');
        host.innerHTML = `
            <div class="note-box">Kayıtlı dönemde <strong>${delta.toLocaleString('tr-TR')}</strong> sayfa basıldı (${hist.length} okuma).</div>
            <div class="table-container" style="margin-top:10px"><table class="data-table">
                <thead><tr><th>Zaman</th><th>Toplam Sayaç</th><th>Toner</th></tr></thead>
                <tbody>${rows}</tbody></table></div>`;
    } catch (e) {
        host.innerHTML = `<div class="note-box">Geçmiş alınamadı.</div>`;
    }
}

function closePrinterModal() {
    const modal = document.getElementById("modalOverlay");
    modal.classList.remove("show");
    document.body.style.overflow = "";
}

// ============================================
// EVENT LISTENERS
// ============================================
function setupEventListeners() {
    // Search
    const searchInput = document.getElementById("searchInput");
    let searchTimeout;
    searchInput.addEventListener("input", (e) => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            searchQuery = e.target.value.trim();
            renderPrinters();
        }, 200);
    });

    // Scan Button
    document.getElementById("scanBtn").addEventListener("click", startScan);

    // Filter Chips
    document.querySelectorAll(".chip").forEach(chip => {
        chip.addEventListener("click", () => {
            document.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
            chip.classList.add("active");
            currentFilter = chip.dataset.filter;
            renderPrinters();
        });
    });

    // View Toggle
    document.getElementById("gridView").addEventListener("click", () => {
        currentView = "grid";
        document.getElementById("gridView").classList.add("active");
        document.getElementById("listView").classList.remove("active");
        renderPrinters();
    });

    document.getElementById("listView").addEventListener("click", () => {
        currentView = "list";
        document.getElementById("listView").classList.add("active");
        document.getElementById("gridView").classList.remove("active");
        renderPrinters();
    });

    // Refresh Button
    document.getElementById("refreshBtn").addEventListener("click", refreshPrinters);

    // Notifications
    document.getElementById("notificationBtn").addEventListener("click", (e) => {
        e.stopPropagation();
        const panel = document.getElementById("notificationsPanel");
        panel.classList.toggle("show");
    });

    document.getElementById("clearNotifs").addEventListener("click", () => {
        notifications = [];
        document.getElementById("notifList").innerHTML = `
            <div class="modal-empty-queue">
                <span class="material-icons-round">notifications_off</span>
                Bildirim yok
            </div>
        `;
        document.getElementById("notifBadge").style.display = "none";
    });

    document.addEventListener("click", (e) => {
        const panel = document.getElementById("notificationsPanel");
        if (!e.target.closest("#notificationBtn") && !e.target.closest("#notificationsPanel")) {
            panel.classList.remove("show");
        }
    });

    // Modal
    document.getElementById("modalClose").addEventListener("click", closePrinterModal);
    document.getElementById("modalOverlay").addEventListener("click", (e) => {
        if (e.target === e.currentTarget) closePrinterModal();
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closePrinterModal();
    });

    // Sidebar Toggle (Mobile)
    document.getElementById("menuToggle").addEventListener("click", () => {
        document.getElementById("sidebar").classList.toggle("open");
    });

    // Sidebar Navigation
    document.querySelectorAll(".nav-item").forEach(item => {
        item.addEventListener("click", (e) => {
            e.preventDefault();
            document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
            item.classList.add("active");

            // Sayfa geçişi
            const pageId = item.id.replace("nav-", "page-");
            document.querySelectorAll(".page-section").forEach(p => p.classList.remove("active"));
            const targetPage = document.getElementById(pageId);
            if (targetPage) targetPage.classList.add("active");

            // Mobilde menüyü kapat
            document.getElementById("sidebar").classList.remove("open");

            // Dinamik sayfa render tetikleme
            if (pageId === "page-queue") renderQueue();
            if (pageId === "page-reports") renderReports();
            if (pageId === "page-stock") renderStock();
            if (pageId === "page-cost") renderCost();
            if (pageId === "page-ad") renderAD();
            if (pageId === "page-security") renderSecurity();
            if (pageId === "page-settings") loadSettings();
        });
    });

    // Ayarlar kaydet (tarama + para birimi)
    const saveBtn = document.getElementById("saveSettingsBtn");
    if (saveBtn) saveBtn.addEventListener("click", saveGeneralSettings);
    const saveAdBtn = document.getElementById("saveAdBtn");
    if (saveAdBtn) saveAdBtn.addEventListener("click", saveAdSettings);
    const testAdBtn = document.getElementById("testAdBtn");
    if (testAdBtn) testAdBtn.addEventListener("click", testAdConnection);
}

// ============================================
// AYARLAR
// ============================================
async function loadSettings() {
    try {
        const res = await apiFetch(`${API_BASE}/api/settings`);
        const data = await res.json();
        const s = data.settings || {};
        const set = (id, v) => { const el = document.getElementById(id); if (el != null && v != null) el.value = v; };
        set("setBaseIp", s.scan_base_ip);
        set("setCidr", s.scan_cidr);
        set("setCurrency", s.currency);
        set("setAutoRefresh", s.auto_refresh_minutes);
        set("setAdUrl", s.ad_url);
        set("setAdBaseDn", s.ad_base_dn);
        set("setAdBindDn", s.ad_bind_dn);
        try {
            const roots = JSON.parse(s.ad_share_roots || '[]');
            document.getElementById("setAdShareRoots").value = Array.isArray(roots) ? roots.join('\n') : '';
        } catch { /* ok */ }
        document.getElementById("adPwHint").textContent = data.hasAdPassword ? '(kayıtlı — değiştirmek için doldurun)' : '(kayıtlı değil)';
    } catch (e) { /* ok */ }
}

async function saveGeneralSettings() {
    const body = {
        scan_base_ip: document.getElementById("setBaseIp").value.trim(),
        scan_cidr: document.getElementById("setCidr").value,
        currency: document.getElementById("setCurrency").value.trim() || 'TRY',
        auto_refresh_minutes: document.getElementById("setAutoRefresh").value || '0'
    };
    const res = await apiFetch(`${API_BASE}/api/settings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    flashButton("saveSettingsBtn", res.ok ? "Kaydedildi ✓" : "Hata");
}

async function saveAdSettings() {
    const rootsText = document.getElementById("setAdShareRoots").value;
    const roots = rootsText.split('\n').map(s => s.trim()).filter(Boolean);
    const body = {
        ad_url: document.getElementById("setAdUrl").value.trim(),
        ad_base_dn: document.getElementById("setAdBaseDn").value.trim(),
        ad_bind_dn: document.getElementById("setAdBindDn").value.trim(),
        ad_share_roots: JSON.stringify(roots)
    };
    const pw = document.getElementById("setAdPassword").value;
    if (pw) body.ad_password = pw;
    const res = await apiFetch(`${API_BASE}/api/settings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    document.getElementById("setAdPassword").value = "";
    flashButton("saveAdBtn", res.ok ? "Kaydedildi ✓" : "Hata");
    loadSettings();
}

async function testAdConnection() {
    const resEl = document.getElementById("adTestResult");
    resEl.className = "ad-test-result";
    resEl.textContent = "Bağlantı test ediliyor...";
    const body = {
        url: document.getElementById("setAdUrl").value.trim(),
        baseDN: document.getElementById("setAdBaseDn").value.trim(),
        bindDN: document.getElementById("setAdBindDn").value.trim()
    };
    const pw = document.getElementById("setAdPassword").value;
    if (pw) body.password = pw;
    try {
        const res = await apiFetch(`${API_BASE}/api/ad/test`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        const data = await res.json();
        if (res.ok) { resEl.classList.add("ok"); resEl.textContent = `✓ Bağlantı başarılı (örnek kayıt: ${data.sampleCount}).`; }
        else { resEl.classList.add("err"); resEl.textContent = `✕ ${data.error}`; }
    } catch (e) {
        resEl.classList.add("err"); resEl.textContent = "✕ Bağlantı hatası.";
    }
}

function flashButton(id, text) {
    const btn = document.getElementById(id);
    if (!btn) return;
    const span = btn.querySelector('.scan-btn-text') || btn;
    const original = span.textContent;
    span.textContent = text;
    setTimeout(() => { span.textContent = original; }, 1800);
}

// ============================================
// PAGE RENDERS (TABS)
// ============================================
function renderQueue() {
    const view = document.getElementById("globalQueueView");
    if (!view) return;

    let allQueue = [];
    printers.forEach(p => {
        if (p.queue && p.queue.length > 0) {
            p.queue.forEach(q => {
                allQueue.push({ ...q, printerName: p.name, printerIp: p.ip });
            });
        }
    });

    if (allQueue.length === 0) {
        view.innerHTML = `
            <div class="empty-state">
                <span class="material-icons-round">check_circle</span>
                <h3>Kuyruk Boş</h3>
                <p>Ağda şu anda bekleyen hiçbir yazdırma işi bulunmuyor.</p>
            </div>
        `;
        return;
    }

    const tbody = allQueue.map(q => `
        <tr>
            <td>
                <div style="font-weight: 500">${q.printerName}</div>
                <div style="font-size: 11px; color: var(--text-muted)">${q.printerIp}</div>
            </td>
            <td><strong style="color: var(--text-primary)">${q.name}</strong></td>
            <td>${q.user || 'Bilinmeyen Kullanıcı'}</td>
            <td>${q.pages || '?'} Sayfa</td>
            <td>${q.time || 'Şimdi'}</td>
            <td><span class="queue-item-status ${q.status}" style="display:inline-block">${q.status === 'printing' ? 'Yazdırılıyor' : 'Bekliyor'}</span></td>
        </tr>
    `).join('');

    view.innerHTML = `
        <div class="table-container">
            <table class="data-table">
                <thead>
                    <tr>
                        <th>Yazıcı</th>
                        <th>Belge Adı</th>
                        <th>Kullanıcı</th>
                        <th>Boyut</th>
                        <th>Zaman</th>
                        <th>Durum</th>
                    </tr>
                </thead>
                <tbody>${tbody}</tbody>
            </table>
        </div>
    `;
}

function renderReports() {
    const view = document.getElementById("reportsView");
    if (!view) return;

    const totalPrinted = printers.reduce((sum, p) => sum + (p.totalPrinted || 0), 0);
    const colorPrinters = printers.filter(p => p.color).length;
    
    let lowTonerCount = 0;
    printers.forEach(p => {
        if (p.toner) {
            Object.values(p.toner).forEach(level => {
                if (level >= 0 && level <= 15) lowTonerCount++;
            });
        }
    });

    view.innerHTML = `
        <div class="stats-grid" style="padding: 0 28px;">
            <div class="stat-card">
                <div class="stat-icon-wrap"><span class="material-icons-round">assessment</span></div>
                <div class="stat-info">
                    <span class="stat-value">${totalPrinted.toLocaleString('tr-TR')}</span>
                    <span class="stat-label">Ağda Basılan Toplam Sayfa</span>
                </div>
            </div>
            <div class="stat-card">
                <div class="stat-icon-wrap"><span class="material-icons-round">palette</span></div>
                <div class="stat-info">
                    <span class="stat-value">${colorPrinters}</span>
                    <span class="stat-label">Renkli Yazıcı Sayısı</span>
                </div>
            </div>
            <div class="stat-card">
                <div class="stat-icon-wrap" style="color:var(--status-error); background:var(--status-error-bg)"><span class="material-icons-round">opacity</span></div>
                <div class="stat-info">
                    <span class="stat-value" style="color:var(--status-error)">${lowTonerCount}</span>
                    <span class="stat-label">Azalan/Biten Toner Sayısı</span>
                </div>
            </div>
        </div>
        <div class="empty-state" style="margin-top:24px">
            <span class="material-icons-round">pie_chart</span>
            <h3>Daha fazla analiz için</h3>
            <p>Aylık tüketim ve yazıcı bazlı kullanım grafikleri "Maliyet & Tüketim" sayfasında yer alır.</p>
        </div>
    `;
}

// ============================================
// HELPERS
// ============================================
function fmtMoney(v, currency) {
    const n = Number(v) || 0;
    return n.toLocaleString('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' ' + (currency || 'TRY');
}
function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const COLOR_LABEL = { black: 'Siyah', cyan: 'Cyan', magenta: 'Magenta', yellow: 'Sarı' };

// ============================================
// CSV DIŞA AKTARMA
// Render sırasında veri kaydedilir, düğme indirir.
// UTF-8 BOM → Excel'de Türkçe karakter uyumu.
// ============================================
const csvData = {}; // key -> { filename, headers, rows }

function registerCSV(key, filename, headers, rows) {
    csvData[key] = { filename, headers, rows };
}

function downloadCSV(key) {
    const d = csvData[key];
    if (!d) return;
    const esc = (v) => {
        const s = String(v ?? '');
        return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [d.headers.map(esc).join(';'), ...d.rows.map(r => r.map(esc).join(';'))];
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = d.filename;
    a.click();
    URL.revokeObjectURL(a.href);
}

// ============================================
// STOK YÖNETİMİ
// ============================================
async function renderStock() {
    const view = document.getElementById("stockView");
    if (!view) return;
    view.innerHTML = `<div class="empty-state"><span class="material-icons-round spinning">sync</span><p>Yükleniyor...</p></div>`;

    let stock = [], movements = [];
    try {
        const [s, m] = await Promise.all([
            apiFetch(`${API_BASE}/api/stock`).then(r => r.json()),
            apiFetch(`${API_BASE}/api/stock/movements`).then(r => r.json())
        ]);
        stock = s.stock || [];
        movements = m.movements || [];
    } catch (e) {
        view.innerHTML = `<div class="empty-state"><span class="material-icons-round">error</span><p>Veri alınamadı.</p></div>`;
        return;
    }

    const canWrite = hasRole('operator');
    const lowCount = stock.filter(s => s.low).length;

    // CSV dışa aktarma verisi (ISO 27001 kayıt kanıtı)
    registerCSV('stock', 'stok-hareketleri.csv',
        ['Tarih', 'Toner', 'Renk', 'Yön', 'Adet', 'Birim Maliyet', 'Yazıcı', 'Kullanıcı', 'Not'],
        movements.map(m => [m.created_at, m.toner_name, COLOR_LABEL[m.color] || m.color,
            m.direction === 'in' ? 'Giriş' : 'Çıkış', m.quantity, m.unit_cost, m.printer_ip || '', m.actor || '', m.note || '']));

    const stockRows = stock.length ? stock.map(s => `
        <tr>
            <td><strong>${escapeHtml(s.name)}</strong><div style="font-size:11px;color:var(--text-muted)">${escapeHtml(s.printer_model || '')}</div></td>
            <td><span class="toner-label ${s.color}" style="display:inline-flex">${(COLOR_LABEL[s.color] || s.color)[0]}</span> ${COLOR_LABEL[s.color] || s.color}</td>
            <td><strong style="font-size:16px; color:${s.low ? 'var(--status-error)' : 'var(--text-primary)'}">${s.current_stock}</strong></td>
            <td>${s.min_stock}</td>
            <td>${fmtMoney(s.unit_cost, s.currency)}</td>
            <td>${s.low ? '<span class="badge-low">Düşük Stok</span>' : '<span class="badge-ok">Yeterli</span>'}</td>
            ${canWrite ? `<td><button class="mini-btn" onclick="openMovementForm(${s.id},'${escapeHtml(s.name)}')">Hareket</button></td>` : ''}
        </tr>`).join('') : `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:20px">Henüz toner türü tanımlanmadı.</td></tr>`;

    const moveRows = movements.length ? movements.slice(0, 50).map(m => `
        <tr>
            <td>${escapeHtml(m.created_at)}</td>
            <td>${escapeHtml(m.toner_name)}</td>
            <td><span class="dir-badge ${m.direction}">${m.direction === 'in' ? '↓ Giriş' : '↑ Çıkış'}</span></td>
            <td>${m.quantity}</td>
            <td>${escapeHtml(m.printer_ip || '-')}</td>
            <td>${escapeHtml(m.actor || '-')}</td>
            <td>${escapeHtml(m.note || '')}</td>
        </tr>`).join('') : `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:20px">Hareket kaydı yok.</td></tr>`;

    view.innerHTML = `
        <div style="padding:0 28px;">
            <div class="stats-grid" style="padding:0; margin-bottom:20px;">
                <div class="stat-card"><div class="stat-icon-wrap"><span class="material-icons-round">inventory_2</span></div><div class="stat-info"><span class="stat-value">${stock.length}</span><span class="stat-label">Toner Türü</span></div></div>
                <div class="stat-card"><div class="stat-icon-wrap"><span class="material-icons-round">tag</span></div><div class="stat-info"><span class="stat-value">${stock.reduce((a, s) => a + s.current_stock, 0)}</span><span class="stat-label">Toplam Stok Adedi</span></div></div>
                <div class="stat-card"><div class="stat-icon-wrap" style="color:var(--status-error);background:var(--status-error-bg)"><span class="material-icons-round">warning</span></div><div class="stat-info"><span class="stat-value" style="color:${lowCount ? 'var(--status-error)' : ''}">${lowCount}</span><span class="stat-label">Düşük Stok</span></div></div>
            </div>

            <div class="settings-card" style="margin-bottom:20px;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <h3 style="margin:0">Toner Türleri & Stok</h3>
                    ${canWrite ? `<button class="mini-btn primary" onclick="openTonerTypeForm()">+ Toner Türü Ekle</button>` : ''}
                </div>
                <div class="table-container" style="margin-top:14px;">
                    <table class="data-table">
                        <thead><tr><th>Toner</th><th>Renk</th><th>Mevcut</th><th>Min</th><th>Birim Maliyet</th><th>Durum</th>${canWrite ? '<th></th>' : ''}</tr></thead>
                        <tbody>${stockRows}</tbody>
                    </table>
                </div>
            </div>

            <div class="settings-card">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
                    <h3 style="margin:0">Son Stok Hareketleri</h3>
                    <button class="mini-btn" onclick="downloadCSV('stock')">⬇ CSV İndir</button>
                </div>
                <div class="table-container">
                    <table class="data-table">
                        <thead><tr><th>Tarih</th><th>Toner</th><th>Yön</th><th>Adet</th><th>Yazıcı</th><th>Kullanıcı</th><th>Not</th></tr></thead>
                        <tbody>${moveRows}</tbody>
                    </table>
                </div>
            </div>
        </div>
        <div id="inlineFormHost"></div>
    `;
}

// Basit toner türü ekleme formu (modalde)
function openTonerTypeForm() {
    openGenericModal(`
        <div class="modal-section-title" style="margin-bottom:16px"><span class="material-icons-round">add_box</span> Yeni Toner Türü</div>
        <form id="ttForm">
            <div class="form-group"><label>Ad</label><input class="form-input" id="tt_name" required placeholder="HP 26X CF226X"></div>
            <div class="form-group"><label>Renk</label>
                <select class="form-input" id="tt_color">
                    <option value="black">Siyah</option><option value="cyan">Cyan</option>
                    <option value="magenta">Magenta</option><option value="yellow">Sarı</option>
                </select>
            </div>
            <div class="form-group"><label>Uyumlu Yazıcı Modeli</label><input class="form-input" id="tt_model" placeholder="HP LaserJet Pro M402"></div>
            <div class="form-group"><label>Kartuş Verimi (sayfa)</label><input class="form-input" id="tt_yield" type="number" value="0"></div>
            <div class="form-group"><label>Birim Maliyet</label><input class="form-input" id="tt_cost" type="number" step="0.01" value="0"></div>
            <div class="form-group"><label>Minimum Stok Eşiği</label><input class="form-input" id="tt_min" type="number" value="2"></div>
            <div class="login-error" id="tt_err"></div>
            <button type="submit" class="login-btn">Kaydet</button>
        </form>
    `);
    document.getElementById("ttForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const body = {
            name: document.getElementById("tt_name").value.trim(),
            color: document.getElementById("tt_color").value,
            printer_model: document.getElementById("tt_model").value.trim(),
            yield_pages: document.getElementById("tt_yield").value,
            unit_cost: document.getElementById("tt_cost").value,
            min_stock: document.getElementById("tt_min").value
        };
        const res = await apiFetch(`${API_BASE}/api/toner-types`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!res.ok) { const d = await res.json(); document.getElementById("tt_err").textContent = d.error || 'Hata'; return; }
        closeGenericModal(); renderStock();
    });
}

// Stok giriş/çıkış hareketi formu
function openMovementForm(tonerId, tonerName) {
    const printerOpts = printers.map(p => `<option value="${p.ip}">${escapeHtml(p.name)} (${p.ip})</option>`).join('');
    openGenericModal(`
        <div class="modal-section-title" style="margin-bottom:16px"><span class="material-icons-round">swap_vert</span> Stok Hareketi — ${escapeHtml(tonerName)}</div>
        <form id="mvForm">
            <div class="form-group"><label>Yön</label>
                <select class="form-input" id="mv_dir"><option value="in">Giriş (stoğa ekle)</option><option value="out">Çıkış (yazıcıya ver / kullan)</option></select>
            </div>
            <div class="form-group"><label>Adet</label><input class="form-input" id="mv_qty" type="number" min="1" value="1" required></div>
            <div class="form-group"><label>Birim Maliyet (opsiyonel)</label><input class="form-input" id="mv_cost" type="number" step="0.01" placeholder="varsayılan tür maliyeti"></div>
            <div class="form-group"><label>Yazıcı (çıkış için)</label><select class="form-input" id="mv_printer"><option value="">— Seçilmedi —</option>${printerOpts}</select></div>
            <div class="form-group"><label>Not</label><input class="form-input" id="mv_note" placeholder="ör: fatura no, tedarikçi"></div>
            <div class="login-error" id="mv_err"></div>
            <button type="submit" class="login-btn">Kaydet</button>
        </form>
    `);
    document.getElementById("mvForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const body = {
            toner_type_id: tonerId,
            direction: document.getElementById("mv_dir").value,
            quantity: document.getElementById("mv_qty").value,
            unit_cost: document.getElementById("mv_cost").value || null,
            printer_ip: document.getElementById("mv_printer").value || null,
            note: document.getElementById("mv_note").value.trim()
        };
        const res = await apiFetch(`${API_BASE}/api/stock/movements`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!res.ok) { const d = await res.json(); document.getElementById("mv_err").textContent = d.error || 'Hata'; return; }
        closeGenericModal(); renderStock();
    });
}

// ============================================
// MALİYET & TÜKETİM
// ============================================
async function renderCost() {
    const view = document.getElementById("costView");
    if (!view) return;
    view.innerHTML = `<div class="empty-state"><span class="material-icons-round spinning">sync</span><p>Yükleniyor...</p></div>`;

    let cost = {}, usage = {};
    try {
        [cost, usage] = await Promise.all([
            apiFetch(`${API_BASE}/api/reports/cost`).then(r => r.json()),
            apiFetch(`${API_BASE}/api/reports/toner-usage`).then(r => r.json())
        ]);
    } catch (e) {
        view.innerHTML = `<div class="empty-state"><span class="material-icons-round">error</span><p>Veri alınamadı.</p></div>`;
        return;
    }

    const cur = cost.currency || 'TRY';
    const totalOut = (cost.byType || []).reduce((a, t) => a + (t.out_value || 0), 0);
    const totalIn = (cost.byType || []).reduce((a, t) => a + (t.in_value || 0), 0);

    // CSV dışa aktarma verileri
    registerCSV('usage', 'yazici-tuketim.csv',
        ['Yazıcı', 'IP', 'Bu Ay (sayfa)', 'Toplam Sayaç', 'Toner Değişimleri', 'Okuma Sayısı'],
        (usage.byPrinter || []).map(p => [p.name, p.ip, p.monthlyPages, p.currentTotal,
            Object.entries(p.replacements || {}).map(([c, n]) => `${COLOR_LABEL[c] || c}:${n}`).join(' '), p.readings]));
    registerCSV('cost', 'toner-maliyet.csv',
        ['Toner', 'Renk', 'Giriş Adet', 'Çıkış Adet', 'Birim Maliyet', 'Tüketim Değeri', 'Para Birimi'],
        (cost.byType || []).map(t => [t.name, COLOR_LABEL[t.color] || t.color, t.in_qty, t.out_qty, t.unit_cost, t.out_value, cur]));

    // Aylık tüketim mini bar chart (CSS)
    const maxPages = Math.max(1, ...(usage.monthlyTotals || []).map(m => m.pages));
    const monthBars = (usage.monthlyTotals || []).length ? (usage.monthlyTotals || []).map(m => `
        <div class="bar-col">
            <div class="bar-fill" style="height:${Math.round((m.pages / maxPages) * 100)}%" title="${m.pages} sayfa"></div>
            <div class="bar-label">${m.month.slice(5)}</div>
            <div class="bar-val">${m.pages}</div>
        </div>`).join('') : '<p style="color:var(--text-muted)">Henüz tüketim verisi yok. Birkaç kez tarama yapın.</p>';

    const usageRows = (usage.byPrinter || []).length ? usage.byPrinter.map(p => {
        const repl = Object.entries(p.replacements || {}).map(([c, n]) => `${COLOR_LABEL[c] || c}: ${n}`).join(', ') || '-';
        return `<tr><td><strong>${escapeHtml(p.name)}</strong><div style="font-size:11px;color:var(--text-muted)">${p.ip}</div></td>
            <td>${p.monthlyPages}</td><td>${p.currentTotal.toLocaleString('tr-TR')}</td><td>${repl}</td></tr>`;
    }).join('') : `<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:20px">Yazıcı okuma geçmişi yok.</td></tr>`;

    const costRows = (cost.byType || []).length ? cost.byType.map(t => `
        <tr><td><strong>${escapeHtml(t.name)}</strong></td><td>${COLOR_LABEL[t.color] || t.color}</td>
        <td>${t.in_qty}</td><td>${t.out_qty}</td><td>${fmtMoney(t.unit_cost, cur)}</td>
        <td><strong>${fmtMoney(t.out_value, cur)}</strong></td></tr>`).join('')
        : `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:20px">Maliyet verisi yok.</td></tr>`;

    view.innerHTML = `
        <div style="padding:0 28px;">
            <div class="stats-grid" style="padding:0;margin-bottom:20px;">
                <div class="stat-card"><div class="stat-icon-wrap"><span class="material-icons-round">shopping_cart</span></div><div class="stat-info"><span class="stat-value" style="font-size:22px">${fmtMoney(totalIn, cur)}</span><span class="stat-label">Toplam Alım Değeri</span></div></div>
                <div class="stat-card"><div class="stat-icon-wrap"><span class="material-icons-round">payments</span></div><div class="stat-info"><span class="stat-value" style="font-size:22px">${fmtMoney(totalOut, cur)}</span><span class="stat-label">Toplam Tüketim Maliyeti</span></div></div>
                <div class="stat-card"><div class="stat-icon-wrap"><span class="material-icons-round">autorenew</span></div><div class="stat-info"><span class="stat-value">${usage.totalReplacements || 0}</span><span class="stat-label">Tahmini Toner Değişimi</span></div></div>
            </div>

            <div class="settings-card" style="margin-bottom:20px;">
                <h3 style="margin:0 0 16px">Aylık Basılan Sayfa (Ağ Geneli)</h3>
                <div class="bar-chart">${monthBars}</div>
            </div>

            <div class="settings-card" style="margin-bottom:20px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
                    <h3 style="margin:0">Yazıcı Bazlı Tüketim</h3>
                    <button class="mini-btn" onclick="downloadCSV('usage')">⬇ CSV İndir</button>
                </div>
                <div class="table-container"><table class="data-table">
                    <thead><tr><th>Yazıcı</th><th>Bu Ay (sayfa)</th><th>Toplam Sayaç</th><th>Toner Değişimleri</th></tr></thead>
                    <tbody>${usageRows}</tbody></table></div>
            </div>

            <div class="settings-card">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
                    <h3 style="margin:0">Toner Türü Bazlı Maliyet</h3>
                    <button class="mini-btn" onclick="downloadCSV('cost')">⬇ CSV İndir</button>
                </div>
                <div class="table-container"><table class="data-table">
                    <thead><tr><th>Toner</th><th>Renk</th><th>Giriş</th><th>Çıkış</th><th>Birim</th><th>Tüketim Değeri</th></tr></thead>
                    <tbody>${costRows}</tbody></table></div>
            </div>
        </div>
    `;
}

// ============================================
// ACTIVE DIRECTORY
// ============================================
let adUsersCache = [];
async function renderAD() {
    const view = document.getElementById("adView");
    if (!view) return;
    view.innerHTML = `<div class="empty-state"><span class="material-icons-round spinning">sync</span><p>AD kullanıcıları yükleniyor...</p></div>`;

    let data;
    try {
        const res = await apiFetch(`${API_BASE}/api/ad/users`);
        data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Hata');
    } catch (e) {
        view.innerHTML = `
            <div class="empty-state">
                <span class="material-icons-round">badge</span>
                <h3>Active Directory bağlı değil</h3>
                <p>${escapeHtml(e.message)}</p>
                ${hasRole('admin') ? '<p style="font-size:13px">Ayarlar > Active Directory bölümünden bağlantıyı yapılandırın.</p>' : ''}
            </div>`;
        return;
    }

    adUsersCache = data.users || [];
    const rows = adUsersCache.length ? adUsersCache.map(u => `
        <tr class="ad-user-row" onclick="openADUser('${escapeHtml(u.sam)}')">
            <td><div class="ad-avatar">${escapeHtml((u.displayName || u.sam).slice(0, 2).toUpperCase())}</div></td>
            <td><strong>${escapeHtml(u.displayName)}</strong><div style="font-size:11px;color:var(--text-muted)">${escapeHtml(u.sam)}</div></td>
            <td>${escapeHtml(u.department || '-')}</td>
            <td>${escapeHtml(u.title || '-')}</td>
            <td>${escapeHtml(u.mail || '-')}</td>
        </tr>`).join('') : `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:20px">Kullanıcı bulunamadı.</td></tr>`;

    view.innerHTML = `
        <div style="padding:0 28px;">
            <div class="settings-card">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
                    <h3 style="margin:0">Kullanıcılar (${adUsersCache.length})</h3>
                    <input type="text" class="form-input" id="adSearch" placeholder="Ara..." style="max-width:240px" oninput="filterADUsers()">
                </div>
                <div class="table-container"><table class="data-table">
                    <thead><tr><th></th><th>Ad</th><th>Departman</th><th>Ünvan</th><th>E-posta</th></tr></thead>
                    <tbody id="adUserTbody">${rows}</tbody></table></div>
                <p style="font-size:12px;color:var(--text-muted);margin-top:10px">Detay (gruplar, klasör yetkileri, kullanılan kaynaklar) için bir kullanıcıya tıklayın.</p>
            </div>
        </div>
    `;
}

function filterADUsers() {
    const q = (document.getElementById("adSearch").value || '').toLowerCase();
    const rows = document.querySelectorAll("#adUserTbody .ad-user-row");
    const list = adUsersCache;
    rows.forEach((row, i) => {
        const u = list[i];
        const hit = !q || [u.displayName, u.sam, u.department, u.title, u.mail].some(v => (v || '').toLowerCase().includes(q));
        row.style.display = hit ? '' : 'none';
    });
}

async function openADUser(sam) {
    openGenericModal(`<div class="empty-state"><span class="material-icons-round spinning">sync</span><p>Yükleniyor...</p></div>`);
    let user;
    try {
        const res = await apiFetch(`${API_BASE}/api/ad/user/${encodeURIComponent(sam)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Hata');
        user = data.user;
    } catch (e) {
        openGenericModal(`<div class="empty-state"><span class="material-icons-round">error</span><p>${escapeHtml(e.message)}</p></div>`);
        return;
    }

    const groups = (user.groups || []).map(g => `<span class="chip-tag">${escapeHtml(g)}</span>`).join('') || '<span style="color:var(--text-muted)">Grup bilgisi yok</span>';

    const fp = user.folderPermissions || {};
    let folderHtml;
    if (!fp.supported) {
        folderHtml = `<div class="note-box">${escapeHtml(fp.note || 'Klasör yetkileri okunamadı.')}</div>`;
    } else if (!(fp.folders || []).length) {
        folderHtml = `<div class="note-box">${escapeHtml(fp.note || 'Bu kullanıcı için eşleşen klasör yetkisi bulunamadı.')}</div>`;
    } else {
        folderHtml = `<div class="table-container"><table class="data-table">
            <thead><tr><th>Klasör</th><th>Okuma</th><th>Yazma</th><th>Üzerinden</th></tr></thead>
            <tbody>${fp.folders.map(f => `<tr>
                <td style="font-family:monospace;font-size:12px">${escapeHtml(f.path)}</td>
                <td>${f.read ? '<span class="perm yes">✓</span>' : '<span class="perm no">—</span>'}</td>
                <td>${f.write ? '<span class="perm yes">✓</span>' : '<span class="perm no">—</span>'}</td>
                <td style="font-size:11px;color:var(--text-muted)">${escapeHtml((f.via || []).join(', '))}</td>
            </tr>`).join('')}</tbody></table></div>`;
    }

    const usedPrinters = (user.usedResources?.printers || []);
    const usedHtml = usedPrinters.length
        ? usedPrinters.map(p => `<div class="modal-info-item"><span class="material-icons-round">print</span><div class="info-content"><span class="info-label">${escapeHtml(p.name)}</span><span class="info-value">${p.jobs} iş • ${p.ip}</span></div></div>`).join('')
        : '<div class="note-box">Kuyrukta bu kullanıcıya ait aktif yazdırma işi yok.</div>';

    openGenericModal(`
        <div class="modal-header">
            <div class="modal-printer-icon"><span class="material-icons-round">badge</span></div>
            <div class="modal-printer-info"><h2>${escapeHtml(user.displayName)}</h2><p>${escapeHtml(user.sam)} • ${escapeHtml(user.title || '')} ${user.department ? '• ' + escapeHtml(user.department) : ''}</p></div>
        </div>
        <div class="modal-section">
            <div class="modal-section-title"><span class="material-icons-round">group</span> Grup Üyelikleri (${(user.groups || []).length})</div>
            <div class="chip-tags">${groups}</div>
        </div>
        <div class="modal-section">
            <div class="modal-section-title"><span class="material-icons-round">folder_shared</span> Ağ Klasörü Yetkileri</div>
            ${folderHtml}
        </div>
        <div class="modal-section">
            <div class="modal-section-title"><span class="material-icons-round">devices</span> Genel Kullanılan Kaynaklar</div>
            <div class="modal-info-grid">${usedHtml}</div>
        </div>
    `);
}

// ============================================
// GÜVENLİK / ISO 27001
// ============================================
async function renderSecurity() {
    const view = document.getElementById("securityView");
    if (!view) return;
    view.innerHTML = `<div class="empty-state"><span class="material-icons-round spinning">sync</span><p>Yükleniyor...</p></div>`;

    let auditRows = [], users = [];
    try {
        const [a, u] = await Promise.all([
            apiFetch(`${API_BASE}/api/audit?limit=150`).then(r => r.json()),
            apiFetch(`${API_BASE}/api/users`).then(r => r.json())
        ]);
        auditRows = a.audit || [];
        users = u.users || [];
    } catch (e) {
        view.innerHTML = `<div class="empty-state"><span class="material-icons-round">error</span><p>Veri alınamadı.</p></div>`;
        return;
    }

    const roleLabels = { admin: 'Yönetici', operator: 'Operatör', viewer: 'Görüntüleyici' };
    const userRows = users.map(u => `
        <tr>
            <td><strong>${escapeHtml(u.username)}</strong></td>
            <td>${roleLabels[u.role] || u.role}</td>
            <td>${u.must_change_password ? '<span class="badge-low">Parola değiştirmeli</span>' : '<span class="badge-ok">Aktif</span>'}</td>
            <td>${escapeHtml(u.created_at)}</td>
            <td>${u.id !== session.id ? `<button class="mini-btn danger" onclick="deleteUser(${u.id},'${escapeHtml(u.username)}')">Sil</button>` : '<span style="color:var(--text-muted);font-size:11px">(siz)</span>'}</td>
        </tr>`).join('');

    // CSV dışa aktarma (denetim kanıtı)
    registerCSV('audit', 'denetim-kaydi.csv',
        ['Zaman', 'Aktör', 'Eylem', 'Nesne', 'Nesne ID', 'Detay', 'IP'],
        auditRows.map(a => [a.created_at, a.actor || '', a.action, a.entity || '', a.entity_id || '', a.detail || '', a.ip || '']));

    const auditActions = [...new Set(auditRows.map(a => a.action))].sort();
    const auditHtml = auditRows.map(a => `
        <tr class="audit-row" data-action="${escapeHtml(a.action)}"
            data-text="${escapeHtml([a.created_at, a.actor, a.action, a.entity, a.entity_id, a.detail].join(' ').toLowerCase())}">
            <td style="font-size:11px;white-space:nowrap">${escapeHtml(a.created_at)}</td>
            <td>${escapeHtml(a.actor || '-')}</td>
            <td><span class="action-badge">${escapeHtml(a.action)}</span></td>
            <td>${escapeHtml(a.entity || '')} ${a.entity_id ? '#' + escapeHtml(a.entity_id) : ''}</td>
            <td style="font-size:12px">${escapeHtml(a.detail || '')}</td>
        </tr>`).join('');

    const isoControls = [
        ['A.5.9', 'Varlık envanteri', 'Yazıcı keşfi + toner stok envanteri'],
        ['A.5.15 / A.5.18', 'Erişim kontrolü & hakları', 'Rol tabanlı erişim (RBAC) + AD klasör yetkileri görünümü'],
        ['A.8.15', 'Loglama', 'Tüm oluştur/güncelle/sil ve giriş olayları denetim kaydında'],
        ['A.8.16', 'İzleme', 'Düşük stok/toner ve başarısız giriş uyarıları'],
        ['A.5.17 / A.8.5', 'Kimlik doğrulama', 'bcrypt parola hash + zorunlu giriş']
    ].map(c => `<tr><td><strong>${c[0]}</strong></td><td>${c[1]}</td><td>${c[2]}</td></tr>`).join('');

    view.innerHTML = `
        <div style="padding:0 28px;">
            <div class="settings-card" style="margin-bottom:20px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
                    <h3 style="margin:0">Kullanıcılar & Roller (RBAC)</h3>
                    <button class="mini-btn primary" onclick="openUserForm()">+ Kullanıcı Ekle</button>
                </div>
                <div class="table-container"><table class="data-table">
                    <thead><tr><th>Kullanıcı</th><th>Rol</th><th>Durum</th><th>Oluşturma</th><th></th></tr></thead>
                    <tbody>${userRows}</tbody></table></div>
            </div>

            <div class="settings-card" style="margin-bottom:20px;">
                <h3 style="margin:0 0 14px">ISO 27001 Kontrol Eşlemesi</h3>
                <div class="table-container"><table class="data-table">
                    <thead><tr><th>Kontrol</th><th>Alan</th><th>Uygulama</th></tr></thead>
                    <tbody>${isoControls}</tbody></table></div>
            </div>

            <div class="settings-card">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px">
                    <h3 style="margin:0">Denetim Kaydı (Audit Log) — son ${auditRows.length}</h3>
                    <div style="display:flex;gap:8px;align-items:center">
                        <input type="text" class="form-input" id="auditSearch" placeholder="Ara..." style="max-width:180px;padding:8px 12px" oninput="filterAudit()">
                        <select class="form-input" id="auditAction" style="max-width:150px;padding:8px 12px" onchange="filterAudit()">
                            <option value="">Tüm eylemler</option>
                            ${auditActions.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('')}
                        </select>
                        <button class="mini-btn" onclick="downloadCSV('audit')">⬇ CSV</button>
                    </div>
                </div>
                <div class="table-container" style="max-height:420px;overflow:auto"><table class="data-table">
                    <thead><tr><th>Zaman</th><th>Aktör</th><th>Eylem</th><th>Nesne</th><th>Detay</th></tr></thead>
                    <tbody id="auditTbody">${auditHtml}</tbody></table></div>
            </div>
        </div>
    `;
}

// Denetim kaydı istemci tarafı filtre (arama + eylem türü)
function filterAudit() {
    const q = (document.getElementById("auditSearch")?.value || '').toLowerCase();
    const action = document.getElementById("auditAction")?.value || '';
    document.querySelectorAll("#auditTbody .audit-row").forEach(row => {
        const hitText = !q || (row.dataset.text || '').includes(q);
        const hitAction = !action || row.dataset.action === action;
        row.style.display = (hitText && hitAction) ? '' : 'none';
    });
}

function openUserForm() {
    openGenericModal(`
        <div class="modal-section-title" style="margin-bottom:16px"><span class="material-icons-round">person_add</span> Yeni Kullanıcı</div>
        <form id="uForm">
            <div class="form-group"><label>Kullanıcı Adı</label><input class="form-input" id="u_name" required></div>
            <div class="form-group"><label>Parola</label><input class="form-input" id="u_pass" type="password" minlength="6" required></div>
            <div class="form-group"><label>Rol</label><select class="form-input" id="u_role">
                <option value="viewer">Görüntüleyici (salt okuma)</option>
                <option value="operator">Operatör (stok/tarama)</option>
                <option value="admin">Yönetici (tam yetki)</option>
            </select></div>
            <div class="login-error" id="u_err"></div>
            <button type="submit" class="login-btn">Oluştur</button>
        </form>
    `);
    document.getElementById("uForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const body = { username: document.getElementById("u_name").value.trim(), password: document.getElementById("u_pass").value, role: document.getElementById("u_role").value };
        const res = await apiFetch(`${API_BASE}/api/users`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!res.ok) { const d = await res.json(); document.getElementById("u_err").textContent = d.error || 'Hata'; return; }
        closeGenericModal(); renderSecurity();
    });
}

async function deleteUser(id, name) {
    if (!confirm(`'${name}' kullanıcısı silinsin mi?`)) return;
    const res = await apiFetch(`${API_BASE}/api/users/${id}`, { method: 'DELETE' });
    if (!res.ok) { const d = await res.json(); alert(d.error || 'Silinemedi'); return; }
    renderSecurity();
}

// ============================================
// GENERIC MODAL (yazıcı modalı altyapısını yeniden kullanır)
// ============================================
function openGenericModal(html) {
    const modal = document.getElementById("modalOverlay");
    document.getElementById("modalContent").innerHTML = html;
    modal.classList.add("show");
    document.body.style.overflow = "hidden";
}
function closeGenericModal() { closePrinterModal(); }
