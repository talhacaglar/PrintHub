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
        set("setSnmpCommunity", s.snmp_community);
        set("setSnmpVersion", s.snmp_version || '2c');
        set("setSnmpV3User", s.snmp_v3_user);
        set("setSnmpV3AuthProto", s.snmp_v3_auth_protocol || 'sha');
        set("setSnmpV3PrivProto", s.snmp_v3_priv_protocol || 'aes');
        toggleSnmpV3Fields();
        set("setCurrency", s.currency);
        set("setAutoRefresh", s.auto_refresh_minutes);
        set("setAdUrl", s.ad_url);
        set("setAdBaseDn", s.ad_base_dn);
        set("setAdBindDn", s.ad_bind_dn);
        try {
            const roots = JSON.parse(s.ad_share_roots || '[]');
            document.getElementById("setAdShareRoots").value = Array.isArray(roots) ? roots.join('\n') : '';
        } catch { /* ok */ }
        const tlsBox = document.getElementById("setAdTlsInsecure");
        if (tlsBox) tlsBox.checked = s.ad_tls_insecure === '1';
        document.getElementById("adPwHint").textContent = data.hasAdPassword ? '(kayıtlı — değiştirmek için doldurun)' : '(kayıtlı değil)';
        set("setRetentionDays", s.readings_retention_days);
        const winrmBox = document.getElementById("setWinrmEnabled");
        if (winrmBox) winrmBox.checked = s.winrm_enabled === '1';
        // app_access_map JSON → "Grup = Uygulama" satırları
        try {
            const map = JSON.parse(s.app_access_map || '[]');
            const el = document.getElementById("setAppAccessMap");
            if (el && Array.isArray(map)) el.value = map.map(m => `${m.group} = ${m.app}`).join('\n');
        } catch { /* ok */ }
    } catch (e) { /* ok */ }
}

// SNMP sürüm seçimine göre v2c/v3 alanlarını göster/gizle
function toggleSnmpV3Fields() {
    const isV3 = document.getElementById("setSnmpVersion")?.value === '3';
    const v2 = document.getElementById("snmpV2Fields");
    const v3 = document.getElementById("snmpV3Fields");
    if (v2) v2.style.display = isV3 ? 'none' : '';
    if (v3) v3.style.display = isV3 ? '' : 'none';
}

async function saveGeneralSettings() {
    const body = {
        scan_base_ip: document.getElementById("setBaseIp").value.trim(),
        scan_cidr: document.getElementById("setCidr").value,
        snmp_community: document.getElementById("setSnmpCommunity").value.trim() || 'public',
        snmp_version: document.getElementById("setSnmpVersion")?.value || '2c',
        snmp_v3_user: document.getElementById("setSnmpV3User")?.value.trim() || '',
        snmp_v3_auth_protocol: document.getElementById("setSnmpV3AuthProto")?.value || 'sha',
        snmp_v3_priv_protocol: document.getElementById("setSnmpV3PrivProto")?.value || 'aes',
        currency: document.getElementById("setCurrency").value.trim() || 'TRY',
        auto_refresh_minutes: document.getElementById("setAutoRefresh").value || '0',
        readings_retention_days: document.getElementById("setRetentionDays")?.value || '90'
    };
    // Sır alanları yalnız doluysa gönderilir (boş = mevcut değeri koru)
    const authKey = document.getElementById("setSnmpV3AuthKey")?.value;
    const privKey = document.getElementById("setSnmpV3PrivKey")?.value;
    if (authKey) body.snmp_v3_auth_key = authKey;
    if (privKey) body.snmp_v3_priv_key = privKey;
    const res = await apiFetch(`${API_BASE}/api/settings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const ak = document.getElementById("setSnmpV3AuthKey"); if (ak) ak.value = '';
    const pk = document.getElementById("setSnmpV3PrivKey"); if (pk) pk.value = '';
    flashButton("saveSettingsBtn", res.ok ? "Kaydedildi ✓" : "Hata");
}

async function saveAdSettings() {
    const rootsText = document.getElementById("setAdShareRoots").value;
    const roots = rootsText.split('\n').map(s => s.trim()).filter(Boolean);
    const body = {
        ad_url: document.getElementById("setAdUrl").value.trim(),
        ad_base_dn: document.getElementById("setAdBaseDn").value.trim(),
        ad_bind_dn: document.getElementById("setAdBindDn").value.trim(),
        ad_share_roots: JSON.stringify(roots),
        ad_tls_insecure: document.getElementById("setAdTlsInsecure").checked ? '1' : '0'
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
        bindDN: document.getElementById("setAdBindDn").value.trim(),
        tlsInsecure: document.getElementById("setAdTlsInsecure").checked
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
