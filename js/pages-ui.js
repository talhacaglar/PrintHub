// ============================================
// PAGE RENDERS (TABS)
// ============================================
async function renderReports() {
    const view = document.getElementById("reportsView");
    if (!view) return;
    view.innerHTML = `<div class="empty-state"><span class="material-icons-round spinning">sync</span><p>Yükleniyor...</p></div>`;

    // Bellekteki yazıcılardan anlık özet.
    // Sayacı okunamamış (null) cihazlar toplama katılmaz ve ayrıca sayılır —
    // aksi halde eksik veri, "ağ bu kadar bastı" diye tam bir sayı gibi görünür.
    const sayacBilinen = printers.filter(p => typeof p.totalPrinted === 'number' && p.totalPrinted > 0);
    const totalPrinted = sayacBilinen.reduce((sum, p) => sum + p.totalPrinted, 0);
    const sayacBilinmeyen = printers.length - sayacBilinen.length;
    // color === null "bilinmiyor" demek; yalnızca kesin bilinenler sayılır.
    const colorPrinters = printers.filter(p => p.color === true).length;
    const renkBilinmeyen = printers.filter(p => p.color !== true && p.color !== false).length;
    const online = printers.filter(p => p.status === "online").length;
    const offline = printers.filter(p => p.status === "offline").length;
    const warning = printers.filter(p => p.status === "warning").length;
    let lowTonerCount = 0;
    printers.forEach(p => {
        if (p.toner) Object.values(p.toner).forEach(level => { if (level >= 0 && level <= lowTonerPercent()) lowTonerCount++; });
    });

    // Zaman serisi + maliyet uçlarından beslenen özet (varsa)
    let usage = {}, cost = {};
    try {
        [usage, cost] = await Promise.all([
            apiFetch(`${API_BASE}/api/reports/toner-usage`).then(r => r.json()).catch(() => ({})),
            apiFetch(`${API_BASE}/api/reports/cost`).then(r => r.json()).catch(() => ({}))
        ]);
    } catch (e) { /* uçlar yoksa boş özet */ }

    const cur = (cost && cost.currency) || 'TRY';
    const totalOut = (cost.byType || []).reduce((a, t) => a + (t.out_value || 0), 0);

    // Durum dağılımı barı
    const totalP = Math.max(1, printers.length);
    const statusBar = `
        <div class="status-dist-bar">
            <div class="status-seg online" style="width:${(online / totalP) * 100}%" title="Çevrim İçi: ${online}"></div>
            <div class="status-seg warning" style="width:${(warning / totalP) * 100}%" title="Uyarı: ${warning}"></div>
            <div class="status-seg offline" style="width:${(offline / totalP) * 100}%" title="Çevrim Dışı: ${offline}"></div>
        </div>
        <div class="status-dist-legend">
            <span><span class="dot online"></span>Çevrim İçi ${online}</span>
            <span><span class="dot warning"></span>Uyarı ${warning}</span>
            <span><span class="dot offline"></span>Çevrim Dışı ${offline}</span>
        </div>`;

    // Aylık ağ geneli sayfa trendi (renderCost ile aynı bar-chart deseni)
    const months = usage.monthlyTotals || [];
    const maxPages = Math.max(1, ...months.map(m => m.pages));
    const monthBars = months.length ? months.map(m => `
        <div class="bar-col">
            <div class="bar-fill" style="height:${Math.round((m.pages / maxPages) * 100)}%" title="${m.pages} sayfa"></div>
            <div class="bar-label">${m.month.slice(5)}</div>
            <div class="bar-val">${m.pages}</div>
        </div>`).join('') : '<p style="color:var(--text-muted)">Henüz tüketim verisi yok. Birkaç kez tarama yapın.</p>';

    // En çok tüketen 5 yazıcı
    const top = (usage.byPrinter || []).slice(0, 5);
    const topRows = top.length ? top.map(p => `
        <tr><td><strong>${escapeHtml(p.name)}</strong><div style="font-size:11px;color:var(--text-muted)">${escapeHtml(p.ip)}</div></td>
        <td>${p.monthlyPages}</td><td>${typeof p.currentTotal === 'number' ? p.currentTotal.toLocaleString('tr-TR') : '—'}</td></tr>`).join('')
        : `<tr><td colspan="3" style="text-align:center;color:var(--text-muted);padding:20px">Yazıcı okuma geçmişi yok.</td></tr>`;

    // CSV: özet
    registerCSV('reports', 'rapor-ozeti.csv',
        ['Metrik', 'Değer'],
        [['Toplam Yazıcı', printers.length], ['Çevrim İçi', online], ['Çevrim Dışı', offline], ['Uyarı', warning],
         ['Ağda Basılan Toplam Sayfa', totalPrinted], ['Renkli Yazıcı', colorPrinters],
         ['Sayacı Okunamayan Yazıcı', sayacBilinmeyen],
         ['Azalan/Biten Toner', lowTonerCount], ['Tahmini Toner Değişimi', usage.totalReplacements || 0],
         ['Fiyatlandırılamayan Değişim', usage.unpricedReplacements || 0],
         ['Toplam Tüketim Maliyeti', `${totalOut} ${cur}`]]);

    view.innerHTML = `
        <div style="padding:0 28px;">
            <div class="stats-grid" style="padding:0;margin-bottom:20px;">
                <div class="stat-card"><div class="stat-icon-wrap"><span class="material-icons-round">assessment</span></div><div class="stat-info"><span class="stat-value">${totalPrinted.toLocaleString('tr-TR')}</span><span class="stat-label">Ağda Basılan Toplam Sayfa${sayacBilinmeyen ? ` (${sayacBilinmeyen} cihazın sayacı okunamadı)` : ''}</span></div></div>
                <div class="stat-card"><div class="stat-icon-wrap"><span class="material-icons-round">palette</span></div><div class="stat-info"><span class="stat-value">${colorPrinters}</span><span class="stat-label">Renkli Yazıcı Sayısı${renkBilinmeyen ? ` (${renkBilinmeyen} cihaz bilinmiyor)` : ''}</span></div></div>
                <div class="stat-card"><div class="stat-icon-wrap" style="color:var(--status-error); background:var(--status-error-bg)"><span class="material-icons-round">opacity</span></div><div class="stat-info"><span class="stat-value" style="color:var(--status-error)">${lowTonerCount}</span><span class="stat-label">Azalan/Biten Toner (≤%${lowTonerPercent()})</span></div></div>
                <div class="stat-card"><div class="stat-icon-wrap"><span class="material-icons-round">payments</span></div><div class="stat-info"><span class="stat-value" style="font-size:22px">${fmtMoney(totalOut, cur)}</span><span class="stat-label">Toplam Tüketim Maliyeti</span></div></div>
            </div>
            ${usage.unpricedReplacements > 0 ? `
            <div class="note-box" style="margin-bottom:20px">
                Tespit edilen ${usage.totalReplacements} kartuş değişiminin
                <strong>${usage.unpricedReplacements}</strong> tanesi fiyatlandırılamadı:
                ilgili yazıcının modeliyle eşleşen bir toner türü tanımlı değil.
                Maliyet tahmini bu değişimleri <em>içermez</em>. Stok Yönetimi'nden
                toner türlerine "Uyumlu Yazıcı Modeli" girerek tamamlayabilirsiniz.
            </div>` : ''}

            <div class="settings-card" style="margin-bottom:20px;">
                <h3 style="margin:0 0 16px">Yazıcı Durum Dağılımı (${printers.length} yazıcı)</h3>
                ${printers.length ? statusBar : '<p style="color:var(--text-muted)">Henüz yazıcı yok. Ağı tarayın.</p>'}
            </div>

            <div class="settings-card" style="margin-bottom:20px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
                    <h3 style="margin:0">Aylık Basılan Sayfa (Ağ Geneli)</h3>
                    <button class="mini-btn" onclick="downloadCSV('reports')">⬇ Özet CSV</button>
                </div>
                <div class="bar-chart">${monthBars}</div>
            </div>

            <div class="settings-card">
                <h3 style="margin:0 0 14px">En Çok Tüketen Yazıcılar (İlk 5)</h3>
                <div class="table-container"><table class="data-table">
                    <thead><tr><th>Yazıcı</th><th>Bu Ay (sayfa)</th><th>Toplam Sayaç</th></tr></thead>
                    <tbody>${topRows}</tbody></table></div>
            </div>
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
// TONER TAKİP EXCEL DIŞA AKTARMA (tek tuş)
// Sunucu, şirketteki Toner_Takip.xlsx ile birebir aynı yapıda
// 5 sayfalık çalışma kitabı üretir; burada indirilir.
// ============================================
async function downloadTonerExcel(btn) {
    const original = btn ? btn.innerHTML : null;
    if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Hazırlanıyor...'; }
    try {
        const res = await apiFetch(`${API_BASE}/api/export/toner-excel`);
        if (!res.ok) {
            const d = await res.json().catch(() => ({}));
            throw new Error(d.error || 'Excel dosyası oluşturulamadı.');
        }
        // Dosya adını sunucunun Content-Disposition başlığından al
        const cd = res.headers.get('Content-Disposition') || '';
        const m = cd.match(/filename="?([^"]+)"?/);
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = m ? m[1] : 'Toner_Takip.xlsx';
        a.click();
        URL.revokeObjectURL(a.href);
    } catch (e) {
        alert(e.message || 'Excel dosyası indirilemedi.');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = original; }
    }
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
    tonerTypesCache = stock; // düzenle formu için önbellek

    // CSV dışa aktarma verisi (ISO 27001 kayıt kanıtı)
    registerCSV('stock', 'stok-hareketleri.csv',
        ['İşlem Tarihi', 'Kayıt Zamanı', 'Toner', 'Renk', 'Yön', 'Adet', 'Birim Maliyet', 'Yazıcı', 'Firma', 'Teslim Alan', 'Kaydeden', 'Not'],
        movements.map(m => [m.movement_date || '', m.created_at, m.toner_name, COLOR_LABEL[m.color] || m.color,
            m.direction === 'in' ? 'Giriş' : 'Çıkış', m.quantity, m.unit_cost, m.printer_ip || '',
            m.supplier || '', m.recipient || '', m.actor || '', m.note || '']));

    const stockRows = stock.length ? stock.map(s => `
        <tr>
            <td><strong>${escapeHtml(s.name)}</strong><div style="font-size:11px;color:var(--text-muted)">${escapeHtml(s.printer_model || '')}</div></td>
            <td><span class="toner-label ${s.color}" style="display:inline-flex">${(COLOR_LABEL[s.color] || s.color)[0]}</span> ${COLOR_LABEL[s.color] || s.color}</td>
            <td><strong style="font-size:16px; color:${s.low ? 'var(--status-error)' : 'var(--text-primary)'}">${s.current_stock}</strong></td>
            <td>${s.min_stock}</td>
            <td>${fmtMoney(s.unit_cost, s.currency)}</td>
            <td>${s.low ? '<span class="badge-low">Düşük Stok</span>' : '<span class="badge-ok">Yeterli</span>'}</td>
            ${canWrite ? `<td style="white-space:nowrap">
                <button class="mini-btn" onclick="openMovementForm(${s.id})" title="Stok giriş/çıkış">Hareket</button>
                <button class="mini-btn" onclick="openTonerTypeForm(${s.id})" title="Toner türünü düzenle">Düzenle</button>
                <button class="mini-btn danger" onclick="deleteTonerType(${s.id})" title="Toner türünü sil">Sil</button>
            </td>` : ''}
        </tr>`).join('') : `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:20px">Henüz toner türü tanımlanmadı.</td></tr>`;

    const moveRows = movements.length ? movements.slice(0, 50).map(m => `
        <tr>
            <td>${escapeHtml(m.movement_date || m.created_at)}</td>
            <td>${escapeHtml(m.toner_name)}</td>
            <td><span class="dir-badge ${m.direction}">${m.direction === 'in' ? '↓ Giriş' : '↑ Çıkış'}</span></td>
            <td>${m.quantity}</td>
            <td>${escapeHtml(m.printer_ip || '-')}</td>
            <td>${escapeHtml(m.supplier || m.recipient || '-')}</td>
            <td>${escapeHtml(m.actor || '-')}</td>
            <td>${escapeHtml(m.note || '')}</td>
        </tr>`).join('') : `<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:20px">Hareket kaydı yok.</td></tr>`;

    view.innerHTML = `
        <div style="padding:0 28px;">
            <div class="stats-grid" style="padding:0; margin-bottom:20px;">
                <div class="stat-card"><div class="stat-icon-wrap"><span class="material-icons-round">inventory_2</span></div><div class="stat-info"><span class="stat-value">${stock.length}</span><span class="stat-label">Toner Türü</span></div></div>
                <div class="stat-card"><div class="stat-icon-wrap"><span class="material-icons-round">tag</span></div><div class="stat-info"><span class="stat-value">${stock.reduce((a, s) => a + s.current_stock, 0)}</span><span class="stat-label">Toplam Stok Adedi</span></div></div>
                <div class="stat-card"><div class="stat-icon-wrap" style="color:var(--status-error);background:var(--status-error-bg)"><span class="material-icons-round">warning</span></div><div class="stat-info"><span class="stat-value" style="color:${lowCount ? 'var(--status-error)' : ''}">${lowCount}</span><span class="stat-label">Düşük Stok</span></div></div>
            </div>

            <div class="settings-card" style="margin-bottom:20px;">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
                    <h3 style="margin:0">Toner Türleri & Stok</h3>
                    <div style="display:flex;gap:8px;align-items:center">
                        <button class="mini-btn" onclick="downloadTonerExcel(this)" title="Toner_Takip.xlsx biçiminde tüm toner verisini indir">📊 Toner Takip Excel</button>
                        ${canWrite ? `<button class="mini-btn primary" onclick="openTonerTypeForm()">+ Toner Türü Ekle</button>` : ''}
                    </div>
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
                        <thead><tr><th>Tarih</th><th>Toner</th><th>Yön</th><th>Adet</th><th>Yazıcı</th><th>Firma / Teslim Alan</th><th>Kaydeden</th><th>Not</th></tr></thead>
                        <tbody>${moveRows}</tbody>
                    </table>
                </div>
            </div>
        </div>
        <div id="inlineFormHost"></div>
    `;
}

// Toner türü ekleme/düzenleme formu (modalde).
// tonerId verilirse mevcut kayıt önbellekten yüklenir ve PUT yapılır; yoksa POST.
function openTonerTypeForm(tonerId) {
    const ex = tonerId != null ? tonerTypesCache.find(x => x.id === tonerId) : null;
    const isEdit = !!ex;
    const colorOpt = (v, label) => `<option value="${v}" ${ex && ex.color === v ? 'selected' : ''}>${label}</option>`;
    openGenericModal(`
        <div class="modal-section-title" style="margin-bottom:16px"><span class="material-icons-round">${isEdit ? 'edit' : 'add_box'}</span> ${isEdit ? 'Toner Türünü Düzenle' : 'Yeni Toner Türü'}</div>
        <form id="ttForm">
            <div class="form-group"><label>Ad</label><input class="form-input" id="tt_name" required placeholder="HP 26X CF226X" value="${escapeHtml(ex ? ex.name : '')}"></div>
            <div class="form-group"><label>Renk</label>
                <select class="form-input" id="tt_color">
                    ${colorOpt('black', 'Siyah')}${colorOpt('cyan', 'Cyan')}${colorOpt('magenta', 'Magenta')}${colorOpt('yellow', 'Sarı')}
                </select>
            </div>
            <div class="form-group"><label>Uyumlu Yazıcı Modeli</label><input class="form-input" id="tt_model" placeholder="HP LaserJet Pro M402" value="${escapeHtml(ex ? (ex.printer_model || '') : '')}"></div>
            <div class="form-group"><label>Kartuş Verimi (sayfa)</label><input class="form-input" id="tt_yield" type="number" value="${ex ? ex.yield_pages : 0}"></div>
            <div class="form-group"><label>Birim Maliyet</label><input class="form-input" id="tt_cost" type="number" step="0.01" value="${ex ? ex.unit_cost : 0}"></div>
            <div class="form-group"><label>Minimum Stok Eşiği</label><input class="form-input" id="tt_min" type="number" value="${ex ? ex.min_stock : 2}"></div>
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
        const url = isEdit ? `${API_BASE}/api/toner-types/${ex.id}` : `${API_BASE}/api/toner-types`;
        const res = await apiFetch(url, { method: isEdit ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!res.ok) { const d = await res.json(); document.getElementById("tt_err").textContent = d.error || 'Hata'; return; }
        closeGenericModal(); renderStock();
    });
}

// Toner türünü sil (operator+). Stok hareketleri de ON DELETE CASCADE ile silinir.
async function deleteTonerType(tonerId) {
    const t = tonerTypesCache.find(x => x.id === tonerId);
    const name = t ? t.name : '#' + tonerId;
    if (!confirm(`"${name}" toner türü ve ona ait tüm stok hareketleri silinecek. Emin misiniz?`)) return;
    const res = await apiFetch(`${API_BASE}/api/toner-types/${tonerId}`, { method: 'DELETE' });
    if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Silme başarısız.'); return; }
    renderStock();
}

// Stok giriş/çıkış hareketi formu.
// opts: { direction, printerIp } — yazıcı detayından hızlı çıkış için önseçim.
function openMovementForm(tonerId, tonerName, opts = {}) {
    if (!tonerName) {
        const t = tonerTypesCache.find(x => x.id === tonerId);
        tonerName = t ? t.name : '';
    }
    const dir = opts.direction || 'in';
    const preIp = opts.printerIp || '';
    const printerOpts = printers.map(p => `<option value="${p.ip}" ${p.ip === preIp ? 'selected' : ''}>${escapeHtml(p.name)} (${p.ip})</option>`).join('');
    openGenericModal(`
        <div class="modal-section-title" style="margin-bottom:16px"><span class="material-icons-round">swap_vert</span> Stok Hareketi — ${escapeHtml(tonerName)}</div>
        <form id="mvForm">
            <div class="form-group"><label>Yön</label>
                <select class="form-input" id="mv_dir"><option value="in" ${dir === 'in' ? 'selected' : ''}>Giriş (stoğa ekle)</option><option value="out" ${dir === 'out' ? 'selected' : ''}>Çıkış (yazıcıya ver / kullan)</option></select>
            </div>
            <div class="form-group"><label>Adet</label><input class="form-input" id="mv_qty" type="number" min="1" value="1" required></div>
            <div class="form-group"><label>İşlem Tarihi</label><input class="form-input" id="mv_date" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
            <div class="form-group"><label>Birim Maliyet (opsiyonel)</label><input class="form-input" id="mv_cost" type="number" step="0.01" placeholder="varsayılan tür maliyeti"></div>
            <div class="form-group"><label>Yazıcı (çıkış için)</label><select class="form-input" id="mv_printer"><option value="">— Seçilmedi —</option>${printerOpts}</select></div>
            <!-- Firma ve Teslim Alan Excel raporunda ayrı sütunlardır. Doldurulmazsa
                 o hücreler BOŞ kalır; uygulama artık nottan ya da giriş yapan
                 kullanıcı adından tedarikçi/kişi türetmiyor. -->
            <div class="form-group"><label>Firma / Tedarikçi <small class="pw-hint">(giriş için)</small></label><input class="form-input" id="mv_supplier" placeholder="boş bırakılabilir"></div>
            <div class="form-group"><label>Teslim Alan Kişi <small class="pw-hint">(çıkış için)</small></label><input class="form-input" id="mv_recipient" placeholder="boş bırakılabilir"></div>
            <div class="form-group"><label>Not</label><input class="form-input" id="mv_note" placeholder="ör: fatura no"></div>
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
            movement_date: document.getElementById("mv_date").value,
            unit_cost: document.getElementById("mv_cost").value || null,
            printer_ip: document.getElementById("mv_printer").value || null,
            supplier: document.getElementById("mv_supplier").value.trim(),
            recipient: document.getElementById("mv_recipient").value.trim(),
            note: document.getElementById("mv_note").value.trim()
        };
        const res = await apiFetch(`${API_BASE}/api/stock/movements`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!res.ok) { const d = await res.json(); document.getElementById("mv_err").textContent = d.error || 'Hata'; return; }
        closeGenericModal(); renderStock();
    });
}

// Yazıcı detayından hızlı toner çıkışı — toner türü seçilir, yön=çıkış,
// ilgili yazıcı önseçili olarak stok hareketi kaydedilir.
async function openPrinterTonerOut(printerIp, printerName) {
    let types = [];
    try {
        const d = await apiFetch(`${API_BASE}/api/toner-types`).then(r => r.json());
        types = d.tonerTypes || [];
    } catch (e) { /* ok */ }

    const typeOpts = types.map(t => `<option value="${t.id}">${escapeHtml(t.name)} (${COLOR_LABEL[t.color] || t.color})</option>`).join('');
    openGenericModal(`
        <div class="modal-section-title" style="margin-bottom:16px"><span class="material-icons-round">north_east</span> Toner Çıkışı — ${escapeHtml(printerName || printerIp)}</div>
        ${types.length ? `
        <form id="ptoForm">
            <div class="form-group"><label>Toner Türü</label><select class="form-input" id="pto_type" required>${typeOpts}</select></div>
            <div class="form-group"><label>Adet</label><input class="form-input" id="pto_qty" type="number" min="1" value="1" required></div>
            <div class="form-group"><label>İşlem Tarihi</label><input class="form-input" id="pto_date" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
            <div class="form-group"><label>Teslim Alan Kişi <small class="pw-hint">(opsiyonel)</small></label><input class="form-input" id="pto_recipient" placeholder="boş bırakılabilir"></div>
            <div class="form-group"><label>Not</label><input class="form-input" id="pto_note" placeholder="ör: kartuş değişimi"></div>
            <div class="login-error" id="pto_err"></div>
            <button type="submit" class="login-btn">Çıkışı Kaydet</button>
        </form>` : `
        <div class="note-box">Önce Stok Yönetimi'nde toner türü tanımlamalısınız.</div>`}
    `);
    if (!types.length) return;
    document.getElementById("ptoForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const body = {
            toner_type_id: parseInt(document.getElementById("pto_type").value, 10),
            direction: 'out',
            quantity: document.getElementById("pto_qty").value,
            movement_date: document.getElementById("pto_date").value,
            printer_ip: printerIp,
            recipient: document.getElementById("pto_recipient").value.trim(),
            note: document.getElementById("pto_note").value.trim()
        };
        const res = await apiFetch(`${API_BASE}/api/stock/movements`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!res.ok) { const d = await res.json(); document.getElementById("pto_err").textContent = d.error || 'Hata'; return; }
        closeGenericModal();
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
