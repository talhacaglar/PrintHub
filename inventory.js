// ============================================
// PrintHub — Kişi IT Envanteri (inventory.js)
// Kullanıcıya atanmış cihazlar + yüklü yazılımlar.
// Kaynaklar:
//   ad     → Get-ADComputer (ManagedBy/Description eşlemesi) — hafif
//   winrm  → Invoke-Command ile CPU/RAM/disk/seri + yüklü uygulamalar
//            (yalnız winrm_enabled=1 ve Windows'ta)
//   manual → operatörün elle atadığı cihazlar
// ISO 27001: A.5.9 Varlık envanteri, A.5.18 Erişim hakları.
// ============================================

const { db, getSetting } = require('./db');
const ad = require('./ad');

const HOSTNAME_RE = /^[A-Za-z0-9._-]{1,255}$/;
function assertValidHostname(h) {
    if (!HOSTNAME_RE.test(String(h || ''))) throw new Error('Geçersiz bilgisayar adı biçimi.');
    return h;
}

function winrmEnabled() {
    return getSetting('winrm_enabled') === '1' && ad.IS_WINDOWS;
}

// ============================================
// DB erişimi
// ============================================
function getDevicesForUser(sam) {
    const devices = db.prepare('SELECT * FROM user_devices WHERE sam = ? ORDER BY hostname').all(sam);
    const swStmt = db.prepare(`SELECT name, version, publisher, install_date, captured_at
                               FROM device_software WHERE device_id = ? ORDER BY name`);
    return devices.map(d => ({ ...d, software: swStmt.all(d.id) }));
}

function upsertDevice({ sam, hostname, source, model, serial, cpu, ram_gb, disk_gb, os, asset_tag, notes, last_seen }) {
    ad.assertValidSam(sam);
    assertValidHostname(hostname);
    const info = db.prepare(`
        INSERT INTO user_devices (sam, hostname, source, model, serial, cpu, ram_gb, disk_gb, os, asset_tag, notes, last_seen, updated_at)
        VALUES (@sam, @hostname, @source, @model, @serial, @cpu, @ram_gb, @disk_gb, @os, @asset_tag, @notes, @last_seen, datetime('now'))
        ON CONFLICT(sam, hostname) DO UPDATE SET
            source = CASE WHEN excluded.source != 'ad' THEN excluded.source ELSE user_devices.source END,
            model = CASE WHEN excluded.model != '' THEN excluded.model ELSE user_devices.model END,
            serial = CASE WHEN excluded.serial != '' THEN excluded.serial ELSE user_devices.serial END,
            cpu = CASE WHEN excluded.cpu != '' THEN excluded.cpu ELSE user_devices.cpu END,
            ram_gb = CASE WHEN excluded.ram_gb > 0 THEN excluded.ram_gb ELSE user_devices.ram_gb END,
            disk_gb = CASE WHEN excluded.disk_gb > 0 THEN excluded.disk_gb ELSE user_devices.disk_gb END,
            os = CASE WHEN excluded.os != '' THEN excluded.os ELSE user_devices.os END,
            asset_tag = CASE WHEN excluded.asset_tag != '' THEN excluded.asset_tag ELSE user_devices.asset_tag END,
            notes = CASE WHEN excluded.notes != '' THEN excluded.notes ELSE user_devices.notes END,
            last_seen = CASE WHEN excluded.last_seen != '' THEN excluded.last_seen ELSE user_devices.last_seen END,
            updated_at = datetime('now')
    `).run({
        sam, hostname,
        source: source || 'manual',
        model: model || '', serial: serial || '', cpu: cpu || '',
        ram_gb: Number(ram_gb) || 0, disk_gb: Number(disk_gb) || 0,
        os: os || '', asset_tag: asset_tag || '', notes: notes || '',
        last_seen: last_seen || ''
    });
    const row = db.prepare('SELECT id FROM user_devices WHERE sam = ? AND hostname = ?').get(sam, hostname);
    return row ? row.id : info.lastInsertRowid;
}

function updateDevice(id, fields) {
    const cur = db.prepare('SELECT * FROM user_devices WHERE id = ?').get(id);
    if (!cur) throw new Error('Cihaz bulunamadı.');
    const b = fields || {};
    db.prepare(`UPDATE user_devices SET model=?, serial=?, asset_tag=?, notes=?, updated_at=datetime('now') WHERE id=?`)
        .run(b.model ?? cur.model, b.serial ?? cur.serial, b.asset_tag ?? cur.asset_tag, b.notes ?? cur.notes, id);
    return true;
}

function deleteDevice(id) {
    db.prepare('DELETE FROM user_devices WHERE id = ?').run(id);
}

function replaceSoftware(deviceId, softwareList) {
    const tx = db.transaction((list) => {
        db.prepare('DELETE FROM device_software WHERE device_id = ?').run(deviceId);
        const ins = db.prepare(`INSERT INTO device_software (device_id, name, version, publisher, install_date)
                                VALUES (?, ?, ?, ?, ?)`);
        for (const s of list) {
            if (!s || !s.name) continue;
            ins.run(deviceId, String(s.name), String(s.version || ''), String(s.publisher || ''), String(s.install_date || ''));
        }
    });
    tx(softwareList || []);
}

// ============================================
// AD tabanlı cihaz keşfi (hafif — yalnız Windows'ta)
// Kullanıcının ManagedBy / Description eşleşen computer nesneleri.
// ============================================
async function discoverAdComputers(sam) {
    ad.assertValidSam(sam);
    if (!ad.IS_WINDOWS) {
        return { supported: false, note: 'AD bilgisayar keşfi yalnızca Windows üzerinde desteklenir.', computers: [] };
    }
    const { preamble, env } = ad.adPsContext();
    const ps = `
        Import-Module ActiveDirectory
        ${preamble}
        $sam = $env:PRINTHUB_AD_SAM
        $u = Get-ADUser @connArgs -Identity $sam -ErrorAction Stop
        $byManaged = Get-ADComputer @connArgs -Filter "ManagedBy -eq '$($u.DistinguishedName)'" -Properties OperatingSystem,LastLogonDate,Description -ErrorAction SilentlyContinue
        $byDesc = Get-ADComputer @connArgs -Filter "Description -like '*$($u.SamAccountName)*'" -Properties OperatingSystem,LastLogonDate,Description -ErrorAction SilentlyContinue
        @($byManaged) + @($byDesc) | Where-Object { $_ } | Sort-Object Name -Unique | ForEach-Object {
            [PSCustomObject]@{
                Name = $_.Name
                OS = $_.OperatingSystem
                LastLogon = if ($_.LastLogonDate) { $_.LastLogonDate.ToString('o') } else { '' }
                Description = $_.Description
            }
        } | ConvertTo-Json -Compress
    `;
    let out;
    try {
        out = await ad.runPowerShell(ps, { ...env, PRINTHUB_AD_SAM: sam });
    } catch (e) {
        throw new Error(ad.translatePsAdError(e.message));
    }
    const raw = safeParse(out.trim());
    const list = !raw ? [] : (Array.isArray(raw) ? raw : [raw]);
    const computers = list.filter(c => c && c.Name).map(c => ({
        hostname: c.Name, os: c.OS || '', lastLogon: c.LastLogon || '', description: c.Description || ''
    }));
    // Bulunanları envantere kaydet (source=ad)
    for (const c of computers) {
        try {
            upsertDevice({ sam, hostname: c.hostname, source: 'ad', os: c.os, last_seen: c.lastLogon, notes: c.description });
        } catch (e) { /* geçersiz hostname vb. — atla */ }
    }
    return { supported: true, computers };
}

// ============================================
// WinRM ile canlı envanter toplama (donanım + yazılım)
// Win32_Product KULLANILMAZ (yavaş + MSI onarımı tetikler);
// registry Uninstall anahtarları okunur.
// ============================================
async function collectViaWinRM(sam, hostname) {
    ad.assertValidSam(sam);
    assertValidHostname(hostname);
    if (!winrmEnabled()) {
        throw new Error('WinRM envanter toplama kapalı veya bu platformda desteklenmiyor (Ayarlar > Envanter).');
    }
    const ps = `
        $ErrorActionPreference = 'Stop'
        $target = $env:PRINTHUB_INV_HOST
        $result = Invoke-Command -ComputerName $target -ScriptBlock {
            $cs = Get-CimInstance Win32_ComputerSystem
            $bios = Get-CimInstance Win32_BIOS
            $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
            $os = Get-CimInstance Win32_OperatingSystem
            $disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3"
            $sw = @()
            $paths = @(
                'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
                'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
            )
            foreach ($p in $paths) {
                $sw += Get-ItemProperty $p -ErrorAction SilentlyContinue |
                    Where-Object { $_.DisplayName } |
                    ForEach-Object { @{ name = $_.DisplayName; version = [string]$_.DisplayVersion; publisher = [string]$_.Publisher; install_date = [string]$_.InstallDate } }
            }
            @{
                model = $cs.Model
                manufacturer = $cs.Manufacturer
                serial = $bios.SerialNumber
                cpu = $cpu.Name
                ram_gb = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
                disk_gb = [math]::Round((($disks | Measure-Object -Property Size -Sum).Sum) / 1GB, 1)
                os = "$($os.Caption) $($os.Version)"
                software = $sw
            }
        }
        $result | ConvertTo-Json -Compress -Depth 4
    `;
    const out = await ad.runPowerShell(ps, { PRINTHUB_INV_HOST: hostname });
    const data = safeParse(out.trim());
    if (!data) throw new Error('Uzak envanter verisi alınamadı.');

    const deviceId = upsertDevice({
        sam, hostname, source: 'winrm',
        model: [data.manufacturer, data.model].filter(Boolean).join(' '),
        serial: data.serial || '', cpu: data.cpu || '',
        ram_gb: data.ram_gb || 0, disk_gb: data.disk_gb || 0,
        os: data.os || '', last_seen: new Date().toISOString()
    });

    const software = Array.isArray(data.software) ? data.software : (data.software ? [data.software] : []);
    // Aynı uygulama iki registry yolunda görünebilir — ada göre tekilleştir
    const seen = new Set();
    const unique = software.filter(s => {
        const key = (s.name || '').toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    replaceSoftware(deviceId, unique);
    return { deviceId, softwareCount: unique.length };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

module.exports = {
    getDevicesForUser, upsertDevice, updateDevice, deleteDevice,
    discoverAdComputers, collectViaWinRM, winrmEnabled, assertValidHostname
};
