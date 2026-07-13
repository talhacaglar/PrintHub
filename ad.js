// ============================================
// PrintHub — Active Directory / LDAP (ad.js)
// Gerçek AD'ye ldapts ile bağlanır: kullanıcı & grup sorgular.
// Ağ klasörü okuma/yazma yetkileri Windows'ta PowerShell Get-Acl ile
// dosya sunucusundan okunur ve kullanıcının grup üyelikleriyle eşlenir.
// ISO 27001: A.5.18 Erişim hakları.
// ============================================

const { Client } = require('ldapts');
const { execFile } = require('child_process');
const { getSetting } = require('./db');

const IS_WINDOWS = process.platform === 'win32';

function adConfig(override) {
    return {
        url: (override && override.url) || getSetting('ad_url') || '',
        baseDN: (override && override.baseDN) || getSetting('ad_base_dn') || '',
        bindDN: (override && override.bindDN) || getSetting('ad_bind_dn') || '',
        password: (override && override.password) || getSetting('ad_password') || '',
    };
}

async function withClient(cfg, fn) {
    if (!cfg.url) throw new Error('AD bağlantısı yapılandırılmamış (Ayarlar > Active Directory).');
    const client = new Client({ url: cfg.url, timeout: 8000, connectTimeout: 8000 });
    try {
        await client.bind(cfg.bindDN, cfg.password);
        return await fn(client);
    } finally {
        try { await client.unbind(); } catch { /* ok */ }
    }
}

/**
 * Bağlantıyı test eder — baseDN altında bir arama dener.
 */
async function testConnection(override) {
    const cfg = adConfig(override);
    return withClient(cfg, async (client) => {
        const { searchEntries } = await client.search(cfg.baseDN, {
            scope: 'sub', filter: '(objectClass=user)', sizeLimit: 1, attributes: ['sAMAccountName']
        });
        return { ok: true, sampleCount: searchEntries.length };
    });
}

function attr(entry, name) {
    const v = entry[name];
    if (Array.isArray(v)) return v;
    return v == null ? '' : v;
}

/**
 * memberOf DN listesinden grup CN'lerini çıkarır.
 */
function groupsFromMemberOf(memberOf) {
    const list = Array.isArray(memberOf) ? memberOf : (memberOf ? [memberOf] : []);
    return list.map(dn => {
        const m = /^CN=([^,]+)/i.exec(dn);
        return m ? m[1] : dn;
    });
}

/**
 * Tüm kullanıcıları listeler (özet alanlar).
 */
async function getUsers(override) {
    const cfg = adConfig(override);
    return withClient(cfg, async (client) => {
        const { searchEntries } = await client.search(cfg.baseDN, {
            scope: 'sub',
            filter: '(&(objectCategory=person)(objectClass=user))',
            attributes: ['sAMAccountName', 'displayName', 'mail', 'department', 'title']
        });
        return searchEntries.map(e => ({
            sam: attr(e, 'sAMAccountName'),
            displayName: attr(e, 'displayName') || attr(e, 'sAMAccountName'),
            mail: attr(e, 'mail'),
            department: attr(e, 'department'),
            title: attr(e, 'title'),
        })).filter(u => u.sam);
    });
}

/**
 * Tek kullanıcının detayları: gruplar + klasör yetkileri.
 */
async function getUserDetail(sam, override) {
    const cfg = adConfig(override);
    const user = await withClient(cfg, async (client) => {
        const { searchEntries } = await client.search(cfg.baseDN, {
            scope: 'sub',
            filter: `(&(objectClass=user)(sAMAccountName=${escapeFilter(sam)}))`,
            attributes: ['sAMAccountName', 'displayName', 'mail', 'department', 'title', 'memberOf', 'lastLogonTimestamp', 'whenCreated']
        });
        if (searchEntries.length === 0) throw new Error('Kullanıcı bulunamadı.');
        const e = searchEntries[0];
        return {
            sam: attr(e, 'sAMAccountName'),
            displayName: attr(e, 'displayName') || attr(e, 'sAMAccountName'),
            mail: attr(e, 'mail'),
            department: attr(e, 'department'),
            title: attr(e, 'title'),
            whenCreated: attr(e, 'whenCreated'),
            groups: groupsFromMemberOf(attr(e, 'memberOf')),
        };
    });

    // Klasör yetkileri — kullanıcının kendi adı + grupları ile eşleştir
    const identities = new Set([user.sam.toLowerCase(), ...user.groups.map(g => g.toLowerCase())]);
    user.folderPermissions = await resolveFolderPermissions(identities);
    return user;
}

function escapeFilter(s) {
    return String(s).replace(/[\\()*\0]/g, c => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

// ============================================
// Klasör ACL çözümleme (Windows / PowerShell Get-Acl)
// ============================================
function rightsToReadWrite(rights) {
    const r = String(rights || '');
    const read = /Read|ListDirectory|ReadAndExecute|FullControl/i.test(r);
    const write = /Write|Modify|FullControl|CreateFiles|Delete/i.test(r);
    return { read, write };
}

function runPowerShell(psCommand) {
    return new Promise((resolve, reject) => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand],
            { maxBuffer: 1024 * 1024 * 8, timeout: 15000 }, (err, stdout) => {
                if (err) return reject(err);
                resolve(stdout);
            });
    });
}

/**
 * Yapılandırılmış paylaşım kök yollarındaki her klasör için ACL okur,
 * verilen kimlik kümesiyle eşleşen okuma/yazma yetkilerini döndürür.
 */
async function resolveFolderPermissions(identitySet) {
    const roots = safeParse(getSetting('ad_share_roots')) || [];
    if (!IS_WINDOWS) {
        return { supported: false, note: 'Klasör ACL okuma yalnızca Windows üzerinde desteklenir.', folders: [] };
    }
    if (!roots.length) {
        return { supported: true, note: 'Paylaşım kök yolu tanımlı değil (Ayarlar > Active Directory).', folders: [] };
    }

    const folders = [];
    for (const root of roots) {
        try {
            // Kök + birinci seviye alt klasörler
            const ps = `Get-ChildItem -LiteralPath '${root.replace(/'/g, "''")}' -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }`;
            const listOut = await runPowerShell(ps);
            const paths = [root, ...listOut.split(/\r?\n/).map(s => s.trim()).filter(Boolean)];

            for (const p of paths) {
                const aclCmd = `(Get-Acl -LiteralPath '${p.replace(/'/g, "''")}').Access | Select-Object IdentityReference,FileSystemRights,AccessControlType | ConvertTo-Json -Compress`;
                let aclOut;
                try { aclOut = await runPowerShell(aclCmd); } catch { continue; }
                const aces = normalizeJson(safeParse(aclOut));
                let read = false, write = false;
                const matched = [];
                for (const ace of aces) {
                    if (String(ace.AccessControlType) !== '0' && !/Allow/i.test(String(ace.AccessControlType))) continue;
                    const idRef = String(ace.IdentityReference?.Value || ace.IdentityReference || '');
                    const idName = idRef.split('\\').pop().toLowerCase();
                    if (identitySet.has(idName)) {
                        const rw = rightsToReadWrite(ace.FileSystemRights);
                        read = read || rw.read;
                        write = write || rw.write;
                        matched.push(idRef);
                    }
                }
                if (read || write) {
                    folders.push({ path: p, read, write, via: [...new Set(matched)] });
                }
            }
        } catch (e) {
            folders.push({ path: root, error: e.message });
        }
    }
    return { supported: true, folders };
}

function normalizeJson(v) {
    if (!v) return [];
    return Array.isArray(v) ? v : [v];
}
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

module.exports = { testConnection, getUsers, getUserDetail, resolveFolderPermissions, adConfig };
