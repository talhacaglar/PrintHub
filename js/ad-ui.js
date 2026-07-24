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
        <tr class="ad-user-row" onclick="openADUser('${escapeHtml(u.sam)}')" ${u.disabled ? 'style="opacity:.55"' : ''}>
            <td><div class="ad-avatar">${escapeHtml((u.displayName || u.sam).slice(0, 2).toUpperCase())}</div></td>
            <td><strong>${escapeHtml(u.displayName)}</strong><div style="font-size:11px;color:var(--text-muted)">${escapeHtml(u.sam)}</div></td>
            <td>${escapeHtml(u.department || '-')}</td>
            <td>${escapeHtml(u.title || '-')}</td>
            <td>${escapeHtml(u.mail || '-')}</td>
            <td>${adStatusBadge(u)}</td>
            <td style="font-size:12px;color:var(--text-muted)">${fmtAdDate(u.lastLogon)}</td>
        </tr>`).join('') : `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:20px">Kullanıcı bulunamadı.</td></tr>`;

    view.innerHTML = `
        <div style="padding:0 28px;">
            <div class="settings-card">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
                    <h3 style="margin:0">Kullanıcılar (${adUsersCache.length})</h3>
                    <div style="display:flex;gap:8px;align-items:center">
                        <button class="mini-btn" onclick="renderADGroups()">👥 Grup Görünümü</button>
                        <input type="text" class="form-input" id="adSearch" placeholder="Ara..." style="max-width:240px" oninput="filterADUsers()">
                    </div>
                </div>
                <div class="table-container"><table class="data-table">
                    <thead><tr><th></th><th>Ad</th><th>Departman</th><th>Ünvan</th><th>E-posta</th><th>Durum</th><th>Son Giriş</th></tr></thead>
                    <tbody id="adUserTbody">${rows}</tbody></table></div>
                <p style="font-size:12px;color:var(--text-muted);margin-top:10px">Detay (gruplar, klasör yetkileri, cihaz envanteri, uygulama erişimleri) için bir kullanıcıya tıklayın.</p>
            </div>
        </div>
    `;
}

function adStatusBadge(u) {
    if (u.disabled) return '<span class="status-badge offline">Devre Dışı</span>';
    if (u.lockedOut) return '<span class="status-badge warning">Kilitli</span>';
    return '<span class="status-badge online">Aktif</span>';
}

function fmtAdDate(iso) {
    if (!iso) return '—';
    try {
        const d = new Date(iso);
        if (isNaN(d)) return '—';
        return d.toLocaleDateString('tr-TR') + ' ' + d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    } catch { return '—'; }
}

// Grup bazlı görünüm — ISO A.5.18 erişim gözden geçirmesi için
async function renderADGroups() {
    const view = document.getElementById("adView");
    if (!view) return;
    view.innerHTML = `<div class="empty-state"><span class="material-icons-round spinning">sync</span><p>AD grupları yükleniyor...</p></div>`;
    let data;
    try {
        const res = await apiFetch(`${API_BASE}/api/ad/groups`);
        data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Hata');
    } catch (e) {
        view.innerHTML = `<div class="empty-state"><span class="material-icons-round">error</span><p>${escapeHtml(e.message)}</p></div>`;
        return;
    }
    const groups = data.groups || [];
    const rows = groups.length ? groups.map(g => `
        <tr>
            <td><strong>${escapeHtml(g.name)}</strong></td>
            <td style="font-size:12px;color:var(--text-muted)">${escapeHtml(g.description || '-')}</td>
            <td>${g.memberCount}</td>
            <td style="font-size:11px;max-width:400px">${(g.members || []).slice(0, 15).map(m => `<span class="chip-tag">${escapeHtml(m)}</span>`).join(' ')}${g.memberCount > 15 ? ` <span style="color:var(--text-muted)">+${g.memberCount - 15} daha</span>` : ''}</td>
        </tr>`).join('') : `<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:20px">Grup bulunamadı.</td></tr>`;
    view.innerHTML = `
        <div style="padding:0 28px;">
            <div class="settings-card">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
                    <h3 style="margin:0">Gruplar (${groups.length})</h3>
                    <button class="mini-btn" onclick="renderAD()">← Kullanıcı Görünümü</button>
                </div>
                <div class="table-container"><table class="data-table">
                    <thead><tr><th>Grup</th><th>Açıklama</th><th>Üye Sayısı</th><th>Üyeler</th></tr></thead>
                    <tbody>${rows}</tbody></table></div>
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

    // Uygulama erişimleri (grup → uygulama eşlemesinden)
    const apps = user.appAccess || [];
    const appsHtml = apps.length
        ? apps.map(a => `<div class="modal-info-item"><span class="material-icons-round">apps</span><div class="info-content"><span class="info-label">${escapeHtml(a.app)}</span><span class="info-value">Grup: ${escapeHtml(a.viaGroup)}</span></div></div>`).join('')
        : '<div class="note-box">Eşlenmiş uygulama erişimi yok. Ayarlar > Kişi IT Envanteri bölümünden grup→uygulama eşlemesi tanımlayabilirsiniz.</div>';

    // Cihaz envanteri
    const devices = user.devices || [];
    const devicesHtml = devices.length
        ? `<div class="table-container"><table class="data-table">
            <thead><tr><th>Cihaz</th><th>Model</th><th>OS</th><th>CPU</th><th>RAM</th><th>Disk</th><th>Yazılım</th><th>Kaynak</th></tr></thead>
            <tbody>${devices.map(d => `<tr>
                <td><strong>${escapeHtml(d.hostname)}</strong>${d.serial ? `<div style="font-size:10px;color:var(--text-muted)">SN: ${escapeHtml(d.serial)}</div>` : ''}</td>
                <td style="font-size:12px">${escapeHtml(d.model || '-')}</td>
                <td style="font-size:12px">${escapeHtml(d.os || '-')}</td>
                <td style="font-size:11px">${escapeHtml(d.cpu || '-')}</td>
                <td>${d.ram_gb ? d.ram_gb + ' GB' : '-'}</td>
                <td>${d.disk_gb ? d.disk_gb + ' GB' : '-'}</td>
                <td>${(d.software || []).length ? `<span class="chip-tag" title="${escapeHtml((d.software || []).slice(0, 30).map(s => s.name).join(', '))}">${d.software.length} uygulama</span>` : '—'}</td>
                <td><span class="chip-tag">${escapeHtml(d.source)}</span></td>
            </tr>`).join('')}</tbody></table></div>`
        : '<div class="note-box">Bu kullanıcıya atanmış cihaz kaydı yok.</div>';
    const collectBtn = hasRole('operator')
        ? `<button class="mini-btn" onclick="collectInventory('${escapeHtml(user.sam)}')" style="margin-top:8px">🔄 AD/WinRM ile Envanter Topla</button>`
        : '';

    const statusLine = [
        user.disabled ? '⛔ Devre Dışı' : '✅ Aktif',
        user.lockedOut ? '🔒 Kilitli' : '',
        user.lastLogon ? `Son giriş: ${fmtAdDate(user.lastLogon)}` : ''
    ].filter(Boolean).join(' • ');

    openGenericModal(`
        <div class="modal-header">
            <div class="modal-printer-icon"><span class="material-icons-round">badge</span></div>
            <div class="modal-printer-info"><h2>${escapeHtml(user.displayName)}</h2><p>${escapeHtml(user.sam)} • ${escapeHtml(user.title || '')} ${user.department ? '• ' + escapeHtml(user.department) : ''}</p>
            <p style="font-size:12px;color:var(--text-muted)">${statusLine}</p></div>
        </div>
        <div class="modal-section">
            <div class="modal-section-title"><span class="material-icons-round">group</span> Grup Üyelikleri (${(user.groups || []).length})${(user.directGroups && user.groups && user.groups.length > user.directGroups.length) ? ` <small style="opacity:.7">(iç içe gruplar dahil)</small>` : ''}</div>
            <div class="chip-tags">${groups}</div>
        </div>
        <div class="modal-section">
            <div class="modal-section-title"><span class="material-icons-round">folder_shared</span> Ağ Klasörü Yetkileri</div>
            ${folderHtml}
        </div>
        <div class="modal-section">
            <div class="modal-section-title"><span class="material-icons-round">apps</span> Uygulama Erişimleri (${apps.length})</div>
            <div class="modal-info-grid">${appsHtml}</div>
        </div>
        <div class="modal-section">
            <div class="modal-section-title"><span class="material-icons-round">computer</span> Cihaz Envanteri (${devices.length})</div>
            ${devicesHtml}
            ${collectBtn}
        </div>
        <div class="modal-section">
            <div class="modal-section-title"><span class="material-icons-round">devices</span> Genel Kullanılan Kaynaklar</div>
            <div class="modal-info-grid">${usedHtml}</div>
        </div>
    `);
}

// AD + WinRM envanter toplama tetikleyicisi; bittiğinde modal yenilenir
async function collectInventory(sam) {
    try {
        const res = await apiFetch(`${API_BASE}/api/inventory/collect/${encodeURIComponent(sam)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Hata');
        openADUser(sam); // güncel envanterle modalı yenile
    } catch (e) {
        alert('Envanter toplama hatası: ' + e.message);
    }
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
