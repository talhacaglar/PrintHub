// ============================================
// PrintHub UI — Yazıcı listesi, modal, olay dinleyicileri (printers-ui.js)
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
        } else if (currentFilter === "online") {
            // Çevrim İçi = ulaşılabilir (uyarı/hata dahil), stat sayımıyla tutarlı
            filtered = filtered.filter(p => p.status !== "offline");
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

// Cihazdan okunan toner seviyelerini çubuklara çevirir.
// Hangi çubukların çizileceği, "renkli mi" bayrağından DEĞİL, gerçekten okunan
// renklerden belirlenir: renk bilgisi bilinmeyen (color === null) bir cihazda
// da CMYK okunmuşsa gösterilir. -1 = bilinmiyor, hiç çizilmez.
const TONER_BAR_ORDER = ['cyan', 'magenta', 'yellow', 'black'];

function renderTonerBars(toner) {
    const t = toner || {};
    const siralı = [
        ...TONER_BAR_ORDER.filter(c => c in t),
        ...Object.keys(t).filter(c => !TONER_BAR_ORDER.includes(c))
    ];
    return siralı.map(color => {
        const level = t[color];
        if (typeof level !== 'number' || level < 0) return '';
        const low = level <= lowTonerPercent() ? 'low' : '';
        const etiket = color === 'black' ? 'K' : color[0].toUpperCase();
        return `
                    <div class="toner-row">
                        <span class="toner-label ${escapeHtml(color)}">${escapeHtml(etiket)}</span>
                        <div class="toner-bar-bg"><div class="toner-bar-fill ${escapeHtml(color)} ${low}" style="width:${level}%"></div></div>
                        <span class="toner-percent ${low}">${level}%</span>
                    </div>
                `;
    }).join('');
}

function createPrinterCard(printer, index) {
    const isColor = printer.color === true;
    const iconClass = isColor ? "color-printer" : "";

    // Teknoloji ve renk yalnızca cihazdan okunduysa yazılır. Eskiden
    // 'inkjet' olmayan HER şey "Lazer", color=false olan her şey "Siyah-Beyaz"
    // diye gösteriliyordu — hiç sorgulanmamış cihazlar dahil.
    const ozellikler = [
        printer.type === 'inkjet' ? 'Mürekkep Püskürtmeli' : printer.type === 'laser' ? 'Lazer' : '',
        printer.color === true ? 'Renkli' : printer.color === false ? 'Siyah-Beyaz' : ''
    ].filter(Boolean);
    const altBaslik = ozellikler.length ? ozellikler.join(' • ') : (printer.model || 'Cihaz bilgisi alınamadı');

    let tonerBars = renderTonerBars(printer.toner);
    if (!tonerBars) {
        tonerBars = `<div style="font-size:11px; color:var(--text-muted); padding:4px 0;">Toner bilgisi alınamadı</div>`;
    }

    return `
        <div class="printer-card" data-printer-id="${printer.id}" style="animation-delay: ${index * 0.05}s">
            <div class="card-header">
                <div class="card-printer-info" style="display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0;">
                    <div class="card-printer-icon ${iconClass}">
                        <span class="material-icons-round">print</span>
                    </div>
                    <div style="min-width: 0; flex: 1;">
                        <div class="card-printer-name" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(printer.name || 'Bilinmeyen')}</div>
                        <div class="card-printer-model" title="${escapeHtml(printer.model || altBaslik)}">${escapeHtml(altBaslik)}</div>
                    </div>
                </div>
                <!-- statusText cihazın kendi prtAlertDescription metni olabilir ve
                     çok uzun olabilir (ör. Samsung SL-M3825ND tek uyarıda 190
                     karakter yolluyor). Rozette kırpılır, tamamı title'da ve
                     modaldeki "Cihaz Uyarıları" bölümünde durur. -->
                <div class="card-status-badge ${printer.status}" title="${escapeHtml(printer.statusText || printer.status)}">
                    <span class="status-dot"></span>
                    <span class="badge-text">${escapeHtml(printer.statusText || printer.status)}</span>
                </div>
            </div>
            <div class="card-details">
                <div class="card-detail">
                    <span class="material-icons-round">lan</span>
                    <span>${escapeHtml(printer.ip)}</span>
                </div>
                <div class="card-detail">
                    <span class="material-icons-round">location_on</span>
                    <span>${escapeHtml(printer.customLocation || printer.location || '—')}</span>
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
            <div class="modal-empty-note">
                <span class="material-icons-round">check_circle</span>
                Bildirim yok — her şey yolunda!
            </div>
        `;
        return;
    }

    list.innerHTML = notifications.map((n, i) => {
        const clickable = (n.printerId != null || n.page);
        return `
        <div class="notif-item${clickable ? ' clickable' : ''}" data-notif-index="${i}">
            <div class="notif-icon ${n.type}">
                <span class="material-icons-round">${n.icon}</span>
            </div>
            <div class="notif-text">
                <div class="notif-title">${escapeHtml(n.title)}</div>
                <div class="notif-desc">${escapeHtml(n.desc)}</div>
            </div>
            <span class="notif-time">${escapeHtml(n.time)}</span>
        </div>`;
    }).join("");

    // Tıklama → ilgili yazıcı modalı veya sayfaya git
    list.querySelectorAll('.notif-item.clickable').forEach(el => {
        el.addEventListener('click', () => {
            const n = notifications[parseInt(el.dataset.notifIndex)];
            if (!n) return;
            document.getElementById("notificationsPanel").classList.remove("show");
            if (n.printerId != null) {
                navigateToPage('page-dashboard');
                openPrinterModal(n.printerId);
            } else if (n.page) {
                navigateToPage(n.page);
            }
        });
    });
}

// ============================================
// MODAL
// ============================================
// prtAlertTrainingLevel → kullanıcıya ne anlatıyor.
// Bir uyarının teknisyen mi yoksa kullanıcı müdahalesi mi istediğini
// yalnızca bu alan söyler; rozetteki metin tek başına bunu ayırt ettirmez.
const MUDAHALE_ETIKET = {
    fieldService: { metin: 'Teknisyen gerekir', ikon: 'engineering' },
    management: { metin: 'Yönetici müdahalesi', ikon: 'admin_panel_settings' },
    trained: { metin: 'Yetkili kullanıcı çözebilir', ikon: 'person' },
    untrained: { metin: 'Kullanıcı çözebilir', ikon: 'person' }
};

// Yazıcının bildirdiği uyarıları listeler. Kaynak öncelikle prtAlertTable;
// cihaz o tabloyu desteklemiyorsa hrPrinterDetectedErrorState bitleri.
// Rozete yalnızca en ağırı sığdığı için tamamı burada gösterilir.
// Uyarı yoksa hiç bölüm basılmaz.
function renderPrinterErrors(printer) {
    const errors = Array.isArray(printer.errors) ? printer.errors : [];
    if (errors.length === 0) return '';

    const items = errors.map(e => {
        const seviye = e.seviye === 'error' ? 'error' : 'warning';
        const ikon = e.olay ? 'history' : (seviye === 'error' ? 'error' : 'warning');
        // Geçmiş olaylar (binaryChangeEvent) kalıcı bir arıza değil; soluk gösterilir.
        const renk = e.olay ? 'var(--text-muted)' : `var(--status-${seviye})`;
        const mudahale = MUDAHALE_ETIKET[e.mudahale];
        const altSatir = e.olay
            ? 'Geçmiş olay — kalıcı arıza değil'
            : (mudahale ? mudahale.metin : '');
        return `
            <div class="modal-info-item alert-item">
                <span class="material-icons-round" style="color: ${renk}">${ikon}</span>
                <div class="info-content">
                    <span class="info-value" style="color: ${renk}">${escapeHtml(e.mesaj)}</span>
                    ${altSatir ? `<span class="info-label">${escapeHtml(altSatir)}</span>` : ''}
                </div>
            </div>`;
    }).join("");

    // Bit dizisi teknisyen gerekip gerekmediğini ayırt edemez — kullanıcıya
    // rozetin ne kadar güvenilir olduğunu söylemek gerekir.
    const kaynakNotu = printer.alertKaynak === 'errorBits'
        ? `<div class="note-box">Bu cihaz ayrıntılı uyarı tablosunu (prtAlertTable) desteklemiyor. Uyarılar tek bitlik durum dizisinden okundu; "Servis Gerekiyor" gibi genel bayraklar cihaz normal çalışırken de yanabilir.</div>`
        : '';

    return `
        <div class="modal-section">
            <div class="modal-section-title">
                <span class="material-icons-round">report_problem</span>
                Cihaz Uyarıları
                ${printer.needsService ? '<span class="chip-tag" style="background:var(--status-error-bg);color:var(--status-error)">Teknisyen gerekir</span>' : ''}
            </div>
            <div class="modal-info-grid alert-grid">${items}</div>
            ${kaynakNotu}
        </div>`;
}

function openPrinterModal(printerId) {
    const printer = printers.find(p => p.id === printerId);
    if (!printer) return;

    const modal = document.getElementById("modalOverlay");
    const content = document.getElementById("modalContent");

    const hasToner = printer.toner && Object.keys(printer.toner).length > 0;

    // Toner kalemleri — hangi renklerin gösterileceği "renkli mi" bayrağından
    // değil, cihazdan GERÇEKTEN okunan anahtarlardan gelir. Seviyesi bilinmeyen
    // (-1) kalem "?" olarak gösterilir, sıfır dolulukmuş gibi çizilmez.
    let tonerItems = '';
    if (hasToner) {
        const colorMap = { cyan: 'Cyan', magenta: 'Magenta', yellow: 'Yellow', black: 'Black' };
        const colorCss = { cyan: 'var(--toner-cyan)', magenta: 'var(--toner-magenta)', yellow: 'var(--toner-yellow)', black: 'var(--toner-black)' };
        const bgCss = { black: 'var(--toner-black-bar)' };

        const mevcut = TONER_BAR_ORDER.filter(c => c in printer.toner);
        const tekKalem = mevcut.length === 1;

        for (const color of mevcut) {
            const level = printer.toner[color];
            const bilinmiyor = typeof level !== 'number' || level < 0;
            const display = bilinmiyor ? '?' : level + '%';
            const width = bilinmiyor ? 0 : level;
            const bg = bgCss[color] || colorCss[color];
            const label = colorMap[color] || color;
            tonerItems += `
                    <div class="modal-toner-item"${tekKalem ? ' style="grid-column: span 2"' : ''}>
                        <div class="toner-header">
                            <span class="toner-name" style="color: ${colorCss[color]}">${escapeHtml(label)}</span>
                            <span class="toner-val" style="color: ${colorCss[color]}">${display}</span>
                        </div>
                        <div class="modal-toner-bar"><div class="modal-toner-bar-fill" style="width:${width}%; background: ${bg}"></div></div>
                    </div>
                `;
        }
    }
    if (!tonerItems) {
        tonerItems = '<div style="font-size:13px; color:var(--text-muted); padding: 12px;">Toner bilgisi mevcut değil.</div>';
    }

    // Paper trays
    const paperTraysHtml = (printer.paperTrays && printer.paperTrays.length > 0)
        ? printer.paperTrays.map(t => `
            <div class="modal-paper-item">
                <div class="tray-name">${escapeHtml(t.name)}</div>
                <div class="tray-size">${escapeHtml(t.size || 'Bilinmiyor')}</div>
                <div class="tray-status ${t.status}">
                    ${t.status === 'ok' ? `✓ ${t.current}/${t.capacity}` : t.status === 'low' ? `⚠ ${t.current}/${t.capacity}` : '✕ Boş'}
                </div>
            </div>
        `).join("")
        : '<div style="font-size:13px; color:var(--text-muted); padding: 12px;">Tepsi bilgisi mevcut değil.</div>';

    content.innerHTML = `
        <div class="modal-header">
            <div class="modal-printer-icon">
                <span class="material-icons-round">print</span>
            </div>
            <div class="modal-printer-info">
                <h2>${escapeHtml(printer.name || 'Bilinmeyen Yazıcı')}</h2>
                <!-- Uzun uyarı metni burada kırpılır; tamamı hemen altındaki
                     "Cihaz Uyarıları" bölümünde satır satır listeleniyor. -->
                <p>${escapeHtml(printer.model || 'Model bilinmiyor')} • <span class="card-status-badge modal-status-badge ${printer.status}" title="${escapeHtml(printer.statusText || printer.status)}"><span class="badge-text">${escapeHtml(printer.statusText || printer.status)}</span></span></p>
            </div>
        </div>

        ${renderPrinterErrors(printer)}

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
                        <span class="info-value">${escapeHtml(printer.ip)}</span>
                    </div>
                </div>
                <div class="modal-info-item">
                    <span class="material-icons-round">router</span>
                    <div class="info-content">
                        <span class="info-label">MAC Adresi</span>
                        <span class="info-value">${escapeHtml(printer.mac || 'Bilinmiyor')}</span>
                    </div>
                </div>
                <div class="modal-info-item">
                    <span class="material-icons-round">location_on</span>
                    <div class="info-content">
                        <span class="info-label">Konum</span>
                        <span class="info-value">${escapeHtml(printer.location || 'Bilinmiyor')}</span>
                    </div>
                </div>
                <div class="modal-info-item">
                    <span class="material-icons-round">qr_code</span>
                    <div class="info-content">
                        <span class="info-label">Seri Numarası</span>
                        <span class="info-value">${escapeHtml(printer.serialNumber || 'Bilinmiyor')}</span>
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
                        <span class="info-value">${escapeHtml(printer.lastSeen || 'Bilinmiyor')}</span>
                    </div>
                </div>
                <div class="modal-info-item">
                    <span class="material-icons-round">rss_feed</span>
                    <div class="info-content">
                        <span class="info-label">SNMP</span>
                        <span class="info-value">${printer.snmpVersion
                            ? 'v' + escapeHtml(printer.snmpVersion)
                            : 'Yanıt yok'}</span>
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
            <div class="modal-section-title" style="justify-content:space-between">
                <span style="display:inline-flex;align-items:center;gap:8px"><span class="material-icons-round">colorize</span> Toner / Mürekkep Seviyeleri</span>
                ${hasRole('operator') ? `<button class="mini-btn" onclick="openPrinterTonerOut('${escapeHtml(printer.ip)}','${escapeHtml((printer.name || '').replace(/'/g, ' '))}')" title="Bu yazıcı için toner çıkışı kaydet">+ Toner Çıkışı</button>` : ''}
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

    // Taramayı Durdur — geniş maskelerde erken bitirme
    const stopBtn = document.getElementById("scanStopBtn");
    if (stopBtn) stopBtn.addEventListener("click", stopScan);

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
            <div class="modal-empty-note">
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
        if (e.key === "Escape") {
            closePrinterModal();
            document.getElementById("notificationsPanel").classList.remove("show");
        }
        // Ctrl/Cmd+K → arama kutusuna odaklan
        if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
            e.preventDefault();
            const s = document.getElementById("searchInput");
            if (s) { s.focus(); s.select(); }
        }
    });

    // Sidebar Toggle (Mobile)
    document.getElementById("menuToggle").addEventListener("click", () => {
        document.getElementById("sidebar").classList.toggle("open");
    });

    // Sidebar Navigation
    document.querySelectorAll(".nav-item").forEach(item => {
        item.addEventListener("click", (e) => {
            e.preventDefault();
            navigateToPage(item.id.replace("nav-", "page-"));
        });
    });

    // Ayarlar kaydet (tarama + para birimi)
    const saveBtn = document.getElementById("saveSettingsBtn");
    if (saveBtn) saveBtn.addEventListener("click", saveGeneralSettings);
    const saveAdBtn = document.getElementById("saveAdBtn");
    if (saveAdBtn) saveAdBtn.addEventListener("click", saveAdSettings);
    const testAdBtn = document.getElementById("testAdBtn");
    if (testAdBtn) testAdBtn.addEventListener("click", testAdConnection);
    const saveInvBtn = document.getElementById("saveInvBtn");
    if (saveInvBtn) saveInvBtn.addEventListener("click", saveInventorySettings);
}

// Envanter ayarları: WinRM anahtarı + "Grup = Uygulama" eşleme satırları
async function saveInventorySettings() {
    const mapText = document.getElementById("setAppAccessMap").value;
    const map = mapText.split('\n')
        .map(line => line.trim()).filter(Boolean)
        .map(line => {
            const idx = line.indexOf('=');
            if (idx < 1) return null;
            return { group: line.slice(0, idx).trim(), app: line.slice(idx + 1).trim() };
        })
        .filter(m => m && m.group && m.app);
    const body = {
        winrm_enabled: document.getElementById("setWinrmEnabled").checked ? '1' : '0',
        app_access_map: JSON.stringify(map)
    };
    const res = await apiFetch(`${API_BASE}/api/settings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    flashButton("saveInvBtn", res.ok ? "Kaydedildi ✓" : "Hata");
}

// ============================================
