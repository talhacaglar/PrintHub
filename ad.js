// ============================================
// PrintHub — Active Directory / LDAP (ad.js)
// Gerçek AD'ye ldapts ile bağlanır: kullanıcı & grup sorgular.
// Ağ klasörü okuma/yazma yetkileri Windows'ta PowerShell Get-Acl ile
// dosya sunucusundan okunur ve kullanıcının grup üyelikleriyle eşlenir.
// ISO 27001: A.5.18 Erişim hakları.
// ============================================

const { Client } = require('ldapts');
const { execFile } = require('child_process');
const { getSetting, getSecureSetting } = require('./db');

const IS_WINDOWS = process.platform === 'win32';

// Saf yardımcılar ayrı modülde (db bağımlılığı olmadan test edilebilir)
const { assertValidSam, fileTimeToISO, uacFlags } = require('./ad-utils');

function adConfig(override) {
    return {
        url: (override && override.url) || getSetting('ad_url') || '',
        baseDN: (override && override.baseDN) || getSetting('ad_base_dn') || '',
        bindDN: (override && override.bindDN) || getSetting('ad_bind_dn') || '',
        // Parola safeStorage ile şifreli saklanır; eski düz metin kayıtlar da okunur.
        password: (override && override.password) || getSecureSetting('ad_password') || '',
        // Yalnızca test ortamı: LDAPS sertifika doğrulamasını atla.
        // Kendi imzalı / domain CA sertifikası olan test DC'lerine ya da
        // sertifikanın IP yerine sunucu adına yazıldığı durumlara bağlanmayı sağlar.
        // ÜRETİMDE KAPALI (0) OLMALI — gerçek sertifika düzgün doğrulanır.
        // Canlı test isteği bir boolean gönderir; aksi halde kayıtlı ayara bakılır.
        tlsInsecure: (override && typeof override.tlsInsecure === 'boolean')
            ? override.tlsInsecure
            : getSetting('ad_tls_insecure') === '1',
    };
}

async function withClient(cfg, fn) {
    if (!cfg.url) throw new Error('AD bağlantısı yapılandırılmamış (Ayarlar > Active Directory).');
    const opts = { url: cfg.url, timeout: 30000, connectTimeout: 10000 };
    if (/^ldaps:/i.test(cfg.url) && cfg.tlsInsecure) {
        opts.tlsOptions = { rejectUnauthorized: false };
    }
    const client = new Client(opts);
    try {
        console.log('[AD] Bağlanılıyor:', cfg.url, 'baseDN:', cfg.baseDN);
        await client.bind(cfg.bindDN, cfg.password);
        console.log('[AD] Bind başarılı');
        // 25 saniyelik mutlak zaman aşımı — sonsuz asılı kalmayı engeller
        const result = await Promise.race([
            fn(client),
            new Promise((_, reject) => setTimeout(() => reject(new Error('AD sorgusu zaman aşımına uğradı (25s).')), 25000))
        ]);
        return result;
    } finally {
        try { await client.unbind(); } catch { /* ok */ }
    }
}

/**
 * Bağlantıyı test eder.
 * Windows'ta gerçek kullanıcı/grup listesiyle AYNI yolu (PowerShell RSAT +
 * -Server/-Credential) kullanır; Linux'ta ldapts ile baseDN altında arama
 * dener. Böylece "test başarılı" sonucu, "AD" sekmesinde gerçekte ne
 * olacağını doğru yansıtır.
 */
async function testConnection(override) {
    if (IS_WINDOWS) {
        const { preamble, env } = adPsContext(override);
        const ps = `
            Import-Module ActiveDirectory
            ${preamble}
            $r = Get-ADUser @connArgs -Filter * -ResultSetSize 1
            [PSCustomObject]@{ Count = @($r).Count } | ConvertTo-Json -Compress
        `;
        let out;
        try {
            out = await runPowerShell(ps, env);
        } catch (e) {
            throw new Error(translatePsAdError(e.message));
        }
        const parsed = safeParse(out.trim()) || { Count: 0 };
        return { ok: true, sampleCount: parsed.Count || 0 };
    }
    const cfg = adConfig(override);
    return withClient(cfg, async (client) => {
        const { searchEntries } = await client.search(cfg.baseDN, {
            scope: 'sub', filter: '(objectClass=user)', sizeLimit: 1, attributes: ['sAMAccountName']
        });
        return { ok: true, sampleCount: searchEntries.length };
    });
}

// ============================================
// TTL'li bellek cache — AD sorguları ve ACL sonuçları için
// ============================================
const USER_CACHE_TTL = 5 * 60 * 1000;   // 5 dk — kullanıcı listesi
const ACL_CACHE_TTL = 10 * 60 * 1000;   // 10 dk — klasör ACL'leri (kullanıcıdan bağımsız)
const cache = new Map(); // key -> { value, expires }

function cacheGet(key) {
    const e = cache.get(key);
    if (e && e.expires > Date.now()) return e.value;
    cache.delete(key);
    return undefined;
}
function cacheSet(key, value, ttl) {
    cache.set(key, { value, expires: Date.now() + ttl });
}
function clearCache() { cache.clear(); }

function attr(entry, name) {
    const v = entry[name];
    if (Array.isArray(v)) return v;
    return v == null ? '' : v;
}

// Tekil öznitelik: ldapts boş alanı [] (boş dizi) döndürür — bu, JSON'a
// [] olarak sızıp frontend'de .slice/.toUpperCase hatalarına yol açar.
// Her zaman düz string döndürür.
function attrOne(entry, name) {
    const v = entry[name];
    if (Array.isArray(v)) return v.length ? String(v[0]) : '';
    return v == null ? '' : String(v);
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
 * Windows'ta PowerShell Get-ADUser kullanılır (ldapts WS2025 LDAPS'te asılı kalıyor).
 * Linux'ta (Docker test vb.) ldapts kullanılır.
 */
async function getUsers(override) {
    // Override yoksa cache kullan (5 dk TTL)
    if (!override) {
        const cached = cacheGet('ad_users');
        if (cached) return cached;
    }
    const users = IS_WINDOWS ? await getUsersViaPS(override) : await getUsersViaLdap(override);
    if (!override) cacheSet('ad_users', users, USER_CACHE_TTL);
    return users;
}

// ============================================
// Windows PowerShell (RSAT ActiveDirectory modülü) bağlantı bağlamı
// ============================================
// PowerShell AD modülü, LDAP simple-bind DN'i (CN=...,DC=...) DEĞİL,
// Kerberos/NTLM kimliği bekler: "kullanici@alanadi.local" ya da
// "ALANADI\\kullanici". Ayarlar'daki Bind DN alanı bu biçimde olmalıdır.
function adPsContext(override) {
    const cfg = adConfig(override);
    let serverArg = '';
    if (cfg.url) {
        const m = /^ldaps?:\/\/([^/:]+)(?::(\d+))?/i.exec(cfg.url.trim());
        if (m) {
            const isLdaps = /^ldaps:/i.test(cfg.url.trim());
            serverArg = `${m[1]}:${m[2] || (isLdaps ? '636' : '389')}`;
        }
    }
    const hasCred = !!(cfg.bindDN && cfg.password);
    if (hasCred && /^(CN|OU|DC)=/i.test(cfg.bindDN.trim())) {
        console.warn('[AD] Uyarı: Bağlantı hesabı bir LDAP DN gibi görünüyor. PowerShell AD modülü '
            + '"kullanici@alanadi.local" veya "ALANADI\\kullanici" biçimini bekler; kimlik doğrulama başarısız olabilir.');
    }
    const env = {};
    let preamble = '$connArgs = @{}\n';
    if (serverArg) {
        env.PRINTHUB_AD_SERVER = serverArg;
        preamble += `if ($env:PRINTHUB_AD_SERVER) { $connArgs.Server = $env:PRINTHUB_AD_SERVER }\n`;
    }
    if (hasCred) {
        env.PRINTHUB_AD_USER = cfg.bindDN;
        env.PRINTHUB_AD_PASS = cfg.password;
        preamble += `
        $__secPass = ConvertTo-SecureString $env:PRINTHUB_AD_PASS -AsPlainText -Force
        $connArgs.Credential = New-Object System.Management.Automation.PSCredential($env:PRINTHUB_AD_USER, $__secPass)
        `;
    }
    return { cfg, preamble, env };
}

// PowerShell/RSAT hatalarını kullanıcının anlayacağı Türkçe mesaja çevirir.
function translatePsAdError(message) {
    const m = String(message || '');
    if (/is not recognized as the name of a cmdlet|Import-Module.*ActiveDirectory|assembly.*ActiveDirectory/i.test(m)) {
        return 'PowerShell "Active Directory" modülü (RSAT) bu makinede kurulu değil. '
            + 'Ayarlar > Uygulamalar > İsteğe Bağlı Özellikler\'den "RSAT: Active Directory Domain Services ve Lightweight Directory Tools" bileşenini ekleyin.';
    }
    if (/logon failure|unknown user name or bad password|user name or password is incorrect|the specified user account has expired/i.test(m)) {
        return 'Active Directory kimlik doğrulaması başarısız. Bağlantı hesabı adı/parolasını kontrol edin '
            + '(Kerberos/NTLM için "kullanici@alanadi.local" biçiminde olmalı, LDAP DN — CN=... — kullanılamaz).';
    }
    if (/unable to contact the server|server is not operational|network path was not found|rpc server is unavailable|no such host is known/i.test(m)) {
        return 'Active Directory sunucusuna ulaşılamadı. Sunucu adresini (Ayarlar > Active Directory) ve ağ/DNS erişimini kontrol edin.';
    }
    return m;
}

/**
 * ldapts ile kullanıcı listesi — paged search (200 kayıt sınırı yok).
 */
async function getUsersViaLdap(override) {
    const cfg = adConfig(override);
    return withClient(cfg, async (client) => {
        const { searchEntries } = await client.search(cfg.baseDN, {
            scope: 'sub',
            filter: '(&(objectClass=user)(!(objectClass=computer)))',
            attributes: ['sAMAccountName', 'displayName', 'mail', 'department', 'title',
                         'userAccountControl', 'lastLogonTimestamp'],
            paged: { pageSize: 500 }, // büyük AD'lerde tam liste
            timeLimit: 20
        });
        return searchEntries.map(e => {
            const flags = uacFlags(attrOne(e, 'userAccountControl'));
            return {
                sam: attrOne(e, 'sAMAccountName'),
                displayName: attrOne(e, 'displayName') || attrOne(e, 'sAMAccountName'),
                mail: attrOne(e, 'mail'),
                department: attrOne(e, 'department'),
                title: attrOne(e, 'title'),
                disabled: flags.disabled,
                lockedOut: flags.lockedOut,
                lastLogon: fileTimeToISO(attrOne(e, 'lastLogonTimestamp')),
            };
        }).filter(u => u.sam);
    });
}

/**
 * PowerShell Get-ADUser ile kullanıcı listesi (pasif hesaplar dahil).
 * Ayarlar'da girilen sunucu adresi + bağlantı hesabı -Server/-Credential
 * olarak geçirilir (domain'e katılı olmayan / farklı kullanıcıyla oturum
 * açılmış makinelerde de çalışması için).
 */
async function getUsersViaPS(override) {
    console.log('[AD] PowerShell Get-ADUser ile kullanıcılar sorgulanıyor...');
    const { preamble, env } = adPsContext(override);
    const ps = `
        Import-Module ActiveDirectory
        ${preamble}
        Get-ADUser @connArgs -Filter * -Properties DisplayName,Department,Title,EmailAddress,Enabled,LockedOut,LastLogonDate |
        Select-Object SamAccountName,DisplayName,Department,Title,EmailAddress,Enabled,LockedOut,
            @{Name='LastLogon';Expression={ if ($_.LastLogonDate) { $_.LastLogonDate.ToString('o') } else { '' } }} |
        ConvertTo-Json -Compress
    `;
    let out;
    try {
        out = await runPowerShell(ps, env);
    } catch (e) {
        throw new Error(translatePsAdError(e.message));
    }
    const raw = safeParse(out.trim());
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    console.log('[AD] PowerShell bulunan kullanıcı:', list.length);
    return list.map(u => ({
        sam: u.SamAccountName || '',
        displayName: u.DisplayName || u.SamAccountName || '',
        mail: u.EmailAddress || '',
        department: u.Department || '',
        title: u.Title || '',
        disabled: u.Enabled === false,
        lockedOut: !!u.LockedOut,
        lastLogon: u.LastLogon || '',
    })).filter(u => u.sam);
}

/**
 * Tek kullanıcının detayları: gruplar + klasör yetkileri.
 * Windows'ta PowerShell, Linux'ta ldapts.
 */
async function getUserDetail(sam, override) {
    assertValidSam(sam); // enjeksiyon savunması (PowerShell + LDAP)
    let user;
    if (IS_WINDOWS) {
        user = await getUserDetailViaPS(sam, override);
    } else {
        const cfg = adConfig(override);
        user = await withClient(cfg, async (client) => {
            const { searchEntries } = await client.search(cfg.baseDN, {
                scope: 'sub',
                filter: `(&(objectClass=user)(sAMAccountName=${escapeFilter(sam)}))`,
                attributes: ['sAMAccountName', 'displayName', 'mail', 'department', 'title', 'memberOf',
                             'lastLogonTimestamp', 'whenCreated', 'userAccountControl', 'distinguishedName'],
                sizeLimit: 1,
                timeLimit: 15
            });
            if (searchEntries.length === 0) throw new Error('Kullanıcı bulunamadı.');
            const e = searchEntries[0];
            const flags = uacFlags(attrOne(e, 'userAccountControl'));
            const directGroups = groupsFromMemberOf(attr(e, 'memberOf'));

            // İç içe (nested) gruplar — LDAP_MATCHING_RULE_IN_CHAIN (1.2.840.113556.1.4.1941)
            // Doğrudan üyeliklerin de üyesi olduğu tüm grupları tek sorguda döndürür.
            let allGroups = directGroups;
            try {
                const dn = attrOne(e, 'distinguishedName');
                if (dn) {
                    const { searchEntries: groupEntries } = await client.search(cfg.baseDN, {
                        scope: 'sub',
                        filter: `(&(objectClass=group)(member:1.2.840.113556.1.4.1941:=${escapeFilter(dn)}))`,
                        attributes: ['cn'],
                        paged: { pageSize: 500 },
                        timeLimit: 15
                    });
                    const nested = groupEntries.map(g => attrOne(g, 'cn')).filter(Boolean);
                    if (nested.length) allGroups = [...new Set([...directGroups, ...nested])];
                }
            } catch (err) {
                console.error('[AD] Nested grup sorgusu başarısız (doğrudan gruplarla devam):', err.message);
            }

            return {
                sam: attrOne(e, 'sAMAccountName'),
                displayName: attrOne(e, 'displayName') || attrOne(e, 'sAMAccountName'),
                mail: attrOne(e, 'mail'),
                department: attrOne(e, 'department'),
                title: attrOne(e, 'title'),
                whenCreated: attrOne(e, 'whenCreated'),
                lastLogon: fileTimeToISO(attrOne(e, 'lastLogonTimestamp')),
                disabled: flags.disabled,
                lockedOut: flags.lockedOut,
                groups: allGroups,
                directGroups,
            };
        });
    }

    // Klasör yetkileri — kullanıcının kendi adı + tüm (nested dahil) grupları ile eşleştir
    const identities = new Set([user.sam.toLowerCase(), ...user.groups.map(g => g.toLowerCase())]);
    user.folderPermissions = await resolveFolderPermissions(identities);

    // Uygulama erişimleri — grup → uygulama eşleme tablosundan (Ayarlar)
    user.appAccess = resolveAppAccess(user.groups);
    return user;
}

/**
 * Ayarlar'daki grup→uygulama eşlemesinden kullanıcının erişebildiği
 * uygulamaları çıkarır (ISO A.5.18 — uygulama erişim görünümü).
 */
function resolveAppAccess(groups) {
    const map = safeParse(getSetting('app_access_map')) || [];
    const groupSet = new Set((groups || []).map(g => String(g).toLowerCase()));
    const apps = [];
    for (const m of map) {
        if (m && m.group && groupSet.has(String(m.group).toLowerCase())) {
            apps.push({ app: m.app || m.group, viaGroup: m.group, note: m.note || '' });
        }
    }
    return apps;
}

/**
 * PowerShell Get-ADUser ile tek kullanıcı detayı.
 */
async function getUserDetailViaPS(sam, override) {
    console.log('[AD] PowerShell ile kullanıcı detayı:', sam);
    assertValidSam(sam);
    const { preamble, env } = adPsContext(override);
    // sam değeri komut metnine gömülmez; ortam değişkeni üzerinden geçirilir
    // (tek tırnak kaçışına ek olarak $, `, ; gibi karakterlere karşı da güvenli).
    const ps = `
        Import-Module ActiveDirectory
        ${preamble}
        $sam = $env:PRINTHUB_AD_SAM
        $u = Get-ADUser @connArgs -Identity $sam -Properties DisplayName,Department,Title,EmailAddress,MemberOf,WhenCreated,Enabled,LockedOut,LastLogonDate
        $direct = @()
        if ($u.MemberOf) { $direct = $u.MemberOf | ForEach-Object { ($_ -split ',')[0] -replace '^CN=' } }
        # Nested (iç içe) gruplar — doğrudan üyeliklerin üst grupları da dahil
        $all = $direct
        try {
            $all = Get-ADPrincipalGroupMembership @connArgs -Identity $sam -ErrorAction Stop | Select-Object -ExpandProperty Name
            # Get-ADPrincipalGroupMembership yalnız 1 seviye verir; tam zincir için token groups:
            $tg = Get-ADUser @connArgs -Identity $sam -Properties TokenGroups -ErrorAction SilentlyContinue
            if ($tg -and $tg.TokenGroups) {
                $sids = $tg.TokenGroups | ForEach-Object { $_.Value }
                $names = foreach ($s in $sids) { try { (Get-ADGroup @connArgs -Identity $s -ErrorAction Stop).Name } catch { } }
                if ($names) { $all = @($all) + @($names) | Sort-Object -Unique }
            }
        } catch { }
        [PSCustomObject]@{
            SamAccountName = $u.SamAccountName
            DisplayName    = $u.DisplayName
            Department     = $u.Department
            Title          = $u.Title
            EmailAddress   = $u.EmailAddress
            WhenCreated    = if ($u.WhenCreated) { $u.WhenCreated.ToString('o') } else { '' }
            LastLogon      = if ($u.LastLogonDate) { $u.LastLogonDate.ToString('o') } else { '' }
            Enabled        = $u.Enabled
            LockedOut      = $u.LockedOut
            DirectGroups   = @($direct)
            Groups         = @($all)
        } | ConvertTo-Json -Compress
    `;
    let out;
    try {
        out = await runPowerShell(ps, { ...env, PRINTHUB_AD_SAM: sam });
    } catch (e) {
        throw new Error(translatePsAdError(e.message));
    }
    const u = safeParse(out.trim());
    if (!u) throw new Error('Kullanıcı bulunamadı.');
    const toArr = v => Array.isArray(v) ? v : (v ? [v] : []);
    return {
        sam: u.SamAccountName || '',
        displayName: u.DisplayName || u.SamAccountName || '',
        mail: u.EmailAddress || '',
        department: u.Department || '',
        title: u.Title || '',
        whenCreated: u.WhenCreated || '',
        lastLogon: u.LastLogon || '',
        disabled: u.Enabled === false,
        lockedOut: !!u.LockedOut,
        groups: toArr(u.Groups).length ? toArr(u.Groups) : toArr(u.DirectGroups),
        directGroups: toArr(u.DirectGroups),
    };
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

function runPowerShell(psCommand, extraEnv) {
    return new Promise((resolve, reject) => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand],
            {
                maxBuffer: 1024 * 1024 * 8,
                timeout: 30000,
                env: extraEnv ? { ...process.env, ...extraEnv } : process.env
            }, (err, stdout, stderr) => {
                if (err) return reject(new Error(stderr || err.message));
                resolve(stdout);
            });
    });
}

/**
 * TÜM paylaşım köklerinin ACL'lerini TEK PowerShell çağrısıyla toplar.
 * Sonuç kullanıcıdan bağımsızdır → 10 dk cache'lenir (her kullanıcı
 * detayında powershell.exe başlatma maliyeti ödenmez).
 * Dönen yapı: [{ path, aces: [{ id, rights, type }] }]
 */
async function collectAllAcls() {
    const roots = safeParse(getSetting('ad_share_roots')) || [];
    if (!roots.length) return [];

    const cacheKey = 'acl_all:' + roots.join('|');
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    // Kök yollar tek env değişkeninde | ile birleştirilir (komuta gömülmez)
    const ps = `
        $ErrorActionPreference = 'SilentlyContinue'
        $roots = $env:PRINTHUB_ACL_ROOTS -split '\\|' | Where-Object { $_ }
        $result = @()
        foreach ($root in $roots) {
            $paths = @($root)
            $paths += Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
            foreach ($p in $paths) {
                $acl = Get-Acl -LiteralPath $p -ErrorAction SilentlyContinue
                if (-not $acl) { continue }
                $aces = @($acl.Access | ForEach-Object {
                    @{ id = $_.IdentityReference.Value; rights = $_.FileSystemRights.ToString(); type = $_.AccessControlType.ToString() }
                })
                $result += @{ path = $p; aces = $aces }
            }
        }
        $result | ConvertTo-Json -Compress -Depth 5
    `;
    const out = await runPowerShell(ps, { PRINTHUB_ACL_ROOTS: roots.join('|') });
    const parsed = normalizeJson(safeParse(out.trim()));
    cacheSet(cacheKey, parsed, ACL_CACHE_TTL);
    return parsed;
}

/**
 * Yapılandırılmış paylaşım kök yollarındaki her klasör için ACL okur,
 * verilen kimlik kümesiyle eşleşen okuma/yazma yetkilerini döndürür.
 * Deny ACE'leri de işlenir: Deny, Allow'u geçersiz kılar.
 */
async function resolveFolderPermissions(identitySet) {
    const roots = safeParse(getSetting('ad_share_roots')) || [];
    if (!IS_WINDOWS) {
        return { supported: false, note: 'Klasör ACL okuma yalnızca Windows üzerinde desteklenir.', folders: [] };
    }
    if (!roots.length) {
        return { supported: true, note: 'Paylaşım kök yolu tanımlı değil (Ayarlar > Active Directory).', folders: [] };
    }

    let aclData;
    try {
        aclData = await collectAllAcls();
    } catch (e) {
        console.error('[AD] ACL toplama hatası:', e.message);
        return { supported: true, note: 'Klasör ACL bilgisi alınamadı.', folders: [] };
    }

    const folders = [];
    for (const entry of aclData) {
        const aces = normalizeJson(entry.aces);
        let allowRead = false, allowWrite = false, denyRead = false, denyWrite = false;
        const matched = [];
        for (const ace of aces) {
            const idRef = String(ace.id || '');
            const idName = idRef.split('\\').pop().toLowerCase();
            if (!identitySet.has(idName)) continue;
            const rw = rightsToReadWrite(ace.rights);
            const isDeny = /Deny/i.test(String(ace.type)) || String(ace.type) === '1';
            if (isDeny) {
                denyRead = denyRead || rw.read;
                denyWrite = denyWrite || rw.write;
            } else {
                allowRead = allowRead || rw.read;
                allowWrite = allowWrite || rw.write;
            }
            matched.push((isDeny ? '⛔ ' : '') + idRef);
        }
        const read = allowRead && !denyRead;
        const write = allowWrite && !denyWrite;
        if (read || write || denyRead || denyWrite) {
            folders.push({
                path: entry.path, read, write,
                denied: (denyRead || denyWrite) ? { read: denyRead, write: denyWrite } : null,
                via: [...new Set(matched)]
            });
        }
    }
    return { supported: true, folders };
}

// ============================================
// Grup bazlı görünüm (ISO A.5.18 erişim gözden geçirme)
// grup → üye sayısı + üyeler; klasör eşlemesi UI tarafında ACL ile birleşir.
// ============================================
async function getGroups(override) {
    if (!override) {
        const cached = cacheGet('ad_groups');
        if (cached) return cached;
    }
    const groups = IS_WINDOWS ? await getGroupsViaPS(override) : await getGroupsViaLdap(override);
    if (!override) cacheSet('ad_groups', groups, USER_CACHE_TTL);
    return groups;
}

async function getGroupsViaLdap(override) {
    const cfg = adConfig(override);
    return withClient(cfg, async (client) => {
        const { searchEntries } = await client.search(cfg.baseDN, {
            scope: 'sub',
            filter: '(objectClass=group)',
            attributes: ['cn', 'description', 'member'],
            paged: { pageSize: 500 },
            timeLimit: 20
        });
        return searchEntries.map(e => {
            const members = attr(e, 'member');
            const list = Array.isArray(members) ? members : (members ? [members] : []);
            return {
                name: attrOne(e, 'cn'),
                description: attrOne(e, 'description'),
                memberCount: list.length,
                members: list.map(dn => {
                    const m = /^CN=([^,]+)/i.exec(String(dn));
                    return m ? m[1] : String(dn);
                }).slice(0, 200) // UI için makul sınır
            };
        }).filter(g => g.name);
    });
}

async function getGroupsViaPS(override) {
    const { preamble, env } = adPsContext(override);
    const ps = `
        Import-Module ActiveDirectory
        ${preamble}
        Get-ADGroup @connArgs -Filter * -Properties Description,Member |
        ForEach-Object {
            [PSCustomObject]@{
                Name        = $_.Name
                Description = $_.Description
                MemberCount = @($_.Member).Count
                Members     = @($_.Member | Select-Object -First 200 | ForEach-Object { ($_ -split ',')[0] -replace '^CN=' })
            }
        } | ConvertTo-Json -Compress -Depth 4
    `;
    let out;
    try {
        out = await runPowerShell(ps, env);
    } catch (e) {
        throw new Error(translatePsAdError(e.message));
    }
    const raw = safeParse(out.trim());
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    return list.map(g => ({
        name: g.Name || '',
        description: g.Description || '',
        memberCount: g.MemberCount || 0,
        members: Array.isArray(g.Members) ? g.Members : (g.Members ? [g.Members] : [])
    })).filter(g => g.name);
}

function normalizeJson(v) {
    if (!v) return [];
    return Array.isArray(v) ? v : [v];
}
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

module.exports = {
    testConnection, getUsers, getUserDetail, getGroups,
    resolveFolderPermissions, resolveAppAccess, adConfig,
    clearCache, assertValidSam, runPowerShell,
    fileTimeToISO, uacFlags, IS_WINDOWS,
    adPsContext, translatePsAdError
};
