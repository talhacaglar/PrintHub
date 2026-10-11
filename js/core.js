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
// Poll, tarama isteğinden ÖNCE başlıyor (sunucu arka plan yenilemesini
// durdururken yanıt gecikebilir). Sunucu isteği kabul ettiğini bildirmeden
// gelen "scanning:false" bir ÖNCEKİ taramanın kalıntısıdır — onunla ilerleme
// çubuğunu kapatmayalım.
let scanAcknowledged = false;
let autoRefreshInterval = null;
let tonerTypesCache = []; // Stok sayfasındaki toner türleri (düzenle/hareket formları için)

// Düşük toner eşiği sunucudaki tek kaynaktan (Ayarlar → low_toner_percent)
// gelir. Eskiden arayüz 15, snmp-query.js 10 kullanıyordu; aynı kavram için
// iki farklı sabit sayı vardı ve rozetle bildirim birbirini tutmuyordu.
const LOW_TONER_FALLBACK = 10;
let lowTonerPercentValue = LOW_TONER_FALLBACK;

function lowTonerPercent() { return lowTonerPercentValue; }

async function loadThresholds() {
    try {
        const res = await apiFetch(`${API_BASE}/api/settings`);
        if (!res.ok) return;
        const data = await res.json();
        const v = parseInt((data.settings || data || {}).low_toner_percent, 10);
        if (Number.isFinite(v) && v >= 0 && v <= 100) lowTonerPercentValue = v;
    } catch (e) { /* ayar okunamadıysa varsayılan eşik kullanılır */ }
}

// Oturum / RBAC
let session = null; // { id, username, role }
const ROLE_LEVEL = { viewer: 1, operator: 2, admin: 3 };
let appInitialized = false;

// ============================================
// OTURUM JETONU (Bearer token)
// Girişte sunucudan alınan jeton sessionStorage'da tutulur; her API
// isteğinde Authorization başlığıyla gönderilir. sessionStorage tercih
// edilir çünkü sekme/pencere kapanınca jeton kalıcı olarak kalmaz.
// ============================================
const TOKEN_KEY = 'printhub-token';

function getToken() {
    try { return sessionStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
}

function setToken(token) {
    try {
        if (token) sessionStorage.setItem(TOKEN_KEY, token);
        else sessionStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* depolama kapalıysa çerez oturumu devrede kalır */ }
}

// İstek seçeneklerine Authorization başlığını ekler
function withAuth(opts = {}) {
    const token = getToken();
    if (!token) return opts;
    return { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } };
}

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
        // Kayıtlı jeton varsa onunla doğrula; yoksa çerez oturumu denenir
        const res = await fetch(`${API_BASE}/api/me`, withAuth());
        if (res.ok) {
            const data = await res.json();
            onLoggedIn(data.user);
            return;
        }
        setToken(null); // jeton süresi dolmuş/iptal edilmiş
    } catch (e) { /* sunucu hazır değil */ }
    showLogin();
}

function showLogin() {
    document.getElementById("loginOverlay").classList.add("show");
}

async function onLoggedIn(user) {
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
        if (!user.mustChangePassword) restoreLastPage();
    }
    // Eşikler yazıcı listesinden önce yüklenir ki ilk render doğru olsun.
    if (!user.mustChangePassword) await loadThresholds();
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
            setToken(data.token); // sonraki isteklerde Authorization başlığı
            onLoggedIn(data.user);
            if (data.mustChangePassword) openPwModal(true);
        } catch (err) {
            errEl.textContent = "Sunucuya bağlanılamadı.";
        }
    });

    document.getElementById("logoutBtn").addEventListener("click", async () => {
        // Jetonu sunucuda iptal et, sonra yerelden sil
        try { await fetch(`${API_BASE}/api/logout`, withAuth({ method: 'POST' })); } catch (e) { /* çevrimdışı */ }
        setToken(null);
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
        const res = await fetch(`${API_BASE}/api/change-password`, withAuth({
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        }));
        const data = await res.json();
        if (!res.ok) { errEl.textContent = data.error || "Değiştirilemedi."; return; }
        // Sunucu eski jetonları iptal edip yenisini verdi — kaydet
        if (data.token) setToken(data.token);
        document.getElementById("pwModalOverlay").classList.remove("show");
        document.getElementById("pwForm").reset();
        if (session) session.mustChangePassword = false;
        fetchPrinters(); // parola değişti; kapı açıldı, verileri yükle
    });
}

function openPwModal(forced) {
    const err = document.getElementById("pwError");
    err.textContent = forced ? "İlk giriş: güvenlik için parolanızı değiştirin." : "";
    document.getElementById("pwModalOverlay").classList.add("show");
}

// ============================================
// GEZİNME (programatik sayfa geçişi + son sayfa hatırlama)
// ============================================
function navigateToPage(pageId, opts = {}) {
    const navId = pageId.replace("page-", "nav-");
    const navItem = document.getElementById(navId);
    // Rol nedeniyle gizli bir sayfaya gidilmek istenirse Gösterge Paneli'ne düş
    if (navItem && navItem.style.display === 'none') { pageId = 'page-dashboard'; }

    document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
    const activeNav = document.getElementById(pageId.replace("page-", "nav-"));
    if (activeNav) activeNav.classList.add("active");

    document.querySelectorAll(".page-section").forEach(p => p.classList.remove("active"));
    const targetPage = document.getElementById(pageId);
    if (targetPage) targetPage.classList.add("active");

    document.getElementById("sidebar").classList.remove("open");

    // Dinamik sayfa render tetikleme
    if (pageId === "page-reports") renderReports();
    if (pageId === "page-stock") renderStock();
    if (pageId === "page-cost") renderCost();
    if (pageId === "page-ad") renderAD();
    if (pageId === "page-security") renderSecurity();
    if (pageId === "page-settings") loadSettings();

    // Son sayfayı hatırla (açılışta geri yüklenir)
    if (!opts.noPersist) {
        try { localStorage.setItem('printhub-last-page', pageId); } catch (e) { /* ok */ }
    }
}

// Açılışta kayıtlı son sayfayı geri yükle (rol görünürlüğüne saygı duyar)
function restoreLastPage() {
    let pageId;
    try { pageId = localStorage.getItem('printhub-last-page'); } catch (e) { /* ok */ }
    if (pageId && pageId !== 'page-dashboard' && document.getElementById(pageId)) {
        navigateToPage(pageId, { noPersist: true });
    }
}

// Her API isteğine Bearer jetonunu ekler.
// 401 gelirse oturumu düşür; 403 + mustChangePassword gelirse parola modalını aç
async function apiFetch(url, opts) {
    const res = await fetch(url, withAuth(opts));
    if (res.status === 401) { session = null; setToken(null); showLogin(); }
    else if (res.status === 403 && !url.endsWith('/change-password')) {
        // Kapı yanıtını yıkıcı olmadan kontrol et
        const clone = res.clone();
        clone.json().then(d => { if (d && d.mustChangePassword) openPwModal(true); }).catch(() => {});
    }
    return res;
}

// ============================================
// API CALLS
// ============================================

async function fetchPrinters() {
    try {
        const res = await apiFetch(`${API_BASE}/api/printers`);
        if (!res.ok) return; // 401/403 apiFetch içinde ele alınır
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
    const stopBtn = document.getElementById("scanStopBtn");
    if (stopBtn) stopBtn.disabled = false;

    // Poll'u istekten ÖNCE başlat: arka planda yenileme sürüyorsa sunucu onu
    // durdurmayı bekler ve yanıt on saniyeyi bulabilir. Poll bu sırada
    // "Arka plan yenilemesi durduruluyor..." mesajını gösterir.
    scanAcknowledged = false;
    scanPollInterval = setInterval(pollScanStatus, 1000);

    try {
        // Gövde boş gönderilir; sunucu kayıtlı ayarları (scan_targets veya
        // scan_base_ip / scan_cidr) kullanır. Böylece Ayarlar > Ağ Tarama
        // alanları tek yetkili kaynaktır.
        const res = await apiFetch(`${API_BASE}/api/scan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });

        // Geçersiz hedef / süren tarama → sunucu hiç başlatmadı
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            clearInterval(scanPollInterval);
            scanPollInterval = null;
            document.getElementById("scanStatusText").textContent =
                err.error || 'Tarama başlatılamadı.';
            isScanning = false;
            scanBtn.classList.remove("scanning");
            scanBtn.querySelector('.scan-btn-text').textContent = "Ağı Tara";
            if (stopBtn) stopBtn.disabled = true;
            setTimeout(() => { progressBar.style.display = "none"; }, 4000);
            return;
        }

        // Sunucu isteği kabul etti; artık "scanning:false" gerçek bitiş demek
        scanAcknowledged = true;
    } catch (e) {
        clearInterval(scanPollInterval);
        scanPollInterval = null;
        console.error('Tarama başlatılamadı:', e);
        isScanning = false;
        scanBtn.classList.remove("scanning");
        scanBtn.querySelector('.scan-btn-text').textContent = "Ağı Tara";
        progressBar.style.display = "none";
    }
}

// Devam eden taramayı sunucu tarafında durdurur; elde edilen sonuçlar korunur
async function stopScan() {
    const btn = document.getElementById("scanStopBtn");
    if (btn) btn.disabled = true;
    try {
        await apiFetch(`${API_BASE}/api/scan/stop`, { method: 'POST' });
        document.getElementById("scanStatusText").textContent = "Tarama durduruluyor...";
    } catch (e) {
        console.error('Tarama durdurulamadı:', e);
    }
}

async function pollScanStatus() {
    try {
        const res = await apiFetch(`${API_BASE}/api/status`);
        if (!res.ok) return;
        const status = await res.json();

        document.getElementById("scanProgressFill").style.width = status.progress + "%";
        document.getElementById("scanStatusText").textContent = status.message;

        // Tarama sırasında da yazıcıları çek (anlık güncelleme)
        if (status.found > 0) {
            await fetchPrinters();
        }

        if (status.scanning) scanAcknowledged = true;

        // Henüz onay yoksa bu durum önceki taramanın kalıntısı — bekle
        if (!status.scanning && !scanAcknowledged) return;

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

        await apiFetch(`${API_BASE}/api/refresh`, { method: 'POST' });

        // Yenileme tamamlanana kadar bekle
        let retries = 0;
        const checkRefresh = setInterval(async () => {
            const res = await apiFetch(`${API_BASE}/api/status`);
            if (!res.ok) { clearInterval(checkRefresh); icon.classList.remove("spinning"); return; }
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
                        time: "Şimdi",
                        page: "page-stock"
                    });
                }
            }
        }
    } catch (e) { /* stok servisi yoksa sessiz geç */ }

    for (const printer of printers) {
        // Düşük toner uyarısı
        if (printer.toner) {
            for (const [color, level] of Object.entries(printer.toner)) {
                if (level >= 0 && level <= lowTonerPercent()) {
                    notifications.push({
                        type: "warning",
                        icon: "warning",
                        title: "Düşük Toner Uyarısı",
                        desc: `${printer.name} — ${color.charAt(0).toUpperCase() + color.slice(1)} %${level}`,
                        time: "Şimdi",
                        printerId: printer.id
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
                        time: "Şimdi",
                        printerId: printer.id
                    });
                } else if (tray.status === 'low') {
                    notifications.push({
                        type: "warning",
                        icon: "warning",
                        title: "Kağıt Azalıyor",
                        desc: `${printer.name} — ${tray.name}`,
                        time: "Şimdi",
                        printerId: printer.id
                    });
                }
            }
        }

        // Çevrim Dışı uyarısı
        if (printer.status === 'offline') {
            notifications.push({
                type: "info",
                icon: "info",
                title: "Yazıcı Çevrim Dışı",
                desc: `${printer.name} bağlantısı kesildi`,
                time: printer.lastSeen || "Bilinmiyor",
                printerId: printer.id
            });
        }

        // Hata durumu
        if (printer.status === 'error') {
            notifications.push({
                type: "error",
                icon: "error",
                title: "Yazıcı Hatası",
                desc: `${printer.name} — ${printer.statusText}`,
                time: "Şimdi",
                printerId: printer.id
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
                    Ağı Tara
                </button>
                <p class="welcome-hint">Tarama aralığı <strong>Ayarlar &rsaquo; Ağ Tarama</strong>'dan yapılandırılır.</p>
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
    // Çevrim İçi = ulaşılabilir (çevrim dışı olmayan) — uyarı/hata da ulaşılabilir sayılır.
    // "Uyarı" bağlantı durumu değil, bunun üstünde bir sağlık katmanıdır.
    const online = printers.filter(p => p.status !== "offline").length;
    const offline = printers.filter(p => p.status === "offline").length;
    const warning = printers.filter(p => p.status === "warning" || p.status === "error").length;

    setStat("statTotal", total);
    setStat("statOnline", online);
    setStat("statOffline", offline);
    setStat("statWarning", warning);
    updateMonthlyCost();
}

// Panodaki "Bu Ay Toner Maliyeti" widget'ı — maliyet raporunun bu ayki çıkış değeri
async function updateMonthlyCost() {
    const el = document.getElementById("statMonthlyCost");
    if (!el) return;
    try {
        const cost = await apiFetch(`${API_BASE}/api/reports/cost`).then(r => r.ok ? r.json() : null);
        if (!cost) return;
        const nowMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
        const row = (cost.monthly || []).find(m => m.month === nowMonth);
        el.textContent = fmtMoney(row ? row.out_value : 0, cost.currency || 'TRY');
    } catch (e) { /* uç yoksa sessiz */ }
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

