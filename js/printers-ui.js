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
                        <div class="card-printer-name" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(printer.name || 'Bilinmeyen')}</div>
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
                    <span>${escapeHtml(printer.ip)}</span>
                </div>
                <div class="card-detail">
                    <span class="material-icons-round">location_on</span>
                    <span>${escapeHtml(printer.customLocation || printer.location || 'Bilinmiyor')}</span>
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
                <div class="tray-name">${escapeHtml(t.name)}</div>
                <div class="tray-size">${escapeHtml(t.size || 'Bilinmiyor')}</div>
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
                    <div class="queue-item-name">${escapeHtml(q.name)}</div>
                    <div class="queue-item-meta">${escapeHtml(q.user || '')} • ${escapeHtml(String(q.pages || '?'))} sayfa • ${escapeHtml(q.time || '')}</div>
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
                <h2>${escapeHtml(printer.name || 'Bilinmeyen Yazıcı')}</h2>
                <p>${escapeHtml(printer.model || '')} • <span class="card-status-badge ${printer.status}" style="display:inline-flex; font-size:10px; padding:3px 8px; vertical-align: middle;">${escapeHtml(printer.statusText || printer.status)}</span></p>
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
