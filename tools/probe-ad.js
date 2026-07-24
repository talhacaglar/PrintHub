#!/usr/bin/env node
// ============================================
// PrintHub — AD Keşif & Otomatik Yapılandırma Aracı
//
// Kullanım:
//   node tools/probe-ad.js <sunucu-ip> <kullanıcı> <parola> [--save]
//   node tools/probe-ad.js 192.168.137.10 Administrator 'Admin1234' --save
//
// Ne yapar:
//   1. LDAP portlarına (389/636) TCP erişimini kontrol eder
//   2. RootDSE'den Base DN (defaultNamingContext) ve domain adını keşfeder
//   3. Verilen hesapla bind'ı doğrular ve örnek kullanıcı sorgusu yapar
//   4. --save verilirse ayarları PrintHub veritabanına yazar
// ============================================

const net = require('net');
const path = require('path');
const { Client } = require('ldapts');

const [, , host, username, password, saveFlag] = process.argv;

if (!host || !username || !password) {
    console.log('Kullanım: node tools/probe-ad.js <ip> <kullanıcı> <parola> [--save]');
    console.log("Örnek  : node tools/probe-ad.js 192.168.137.10 Administrator 'Admin1234' --save");
    process.exit(1);
}
const SAVE = saveFlag === '--save';

function checkPort(ip, port, timeout = 3000) {
    return new Promise((resolve) => {
        const s = new net.Socket();
        let done = false;
        const end = (ok) => { if (!done) { done = true; s.destroy(); resolve(ok); } };
        s.setTimeout(timeout);
        s.on('connect', () => end(true));
        s.on('timeout', () => end(false));
        s.on('error', () => end(false));
        s.connect(port, ip);
    });
}

// Base DN → domain adı: DC=printhub,DC=local → printhub.local
function dnToDomain(dn) {
    return String(dn).split(',')
        .map(p => p.trim()).filter(p => /^DC=/i.test(p))
        .map(p => p.slice(3)).join('.');
}

async function main() {
    console.log(`\n[1/4] TCP erişim kontrolü → ${host} ...`);
    const [p389, p636] = await Promise.all([checkPort(host, 389), checkPort(host, 636)]);
    console.log(`      389 (LDAP)  : ${p389 ? 'AÇIK ✓' : 'kapalı ✗'}`);
    console.log(`      636 (LDAPS) : ${p636 ? 'AÇIK ✓' : 'kapalı ✗'}`);
    if (!p389 && !p636) {
        console.error('\n✗ Sunucuya LDAP portlarından erişilemiyor.');
        console.error('  - Aynı ağda mısınız? (ping ' + host + ')');
        console.error('  - Sunucuda AD DS rolü kurulu ve çalışıyor mu?');
        console.error('  - Windows Güvenlik Duvarı 389/636 portlarına izin veriyor mu?');
        process.exit(2);
    }
    // LDAPS varsa tercih edilir (parola şifreli gider); self-signed sertifika
    // ihtimaline karşı testte doğrulama atlanır.
    const useLdaps = p636;
    const url = useLdaps ? `ldaps://${host}:636` : `ldap://${host}:389`;

    console.log(`\n[2/4] RootDSE keşfi → ${url} ...`);
    const opts = { url, timeout: 15000, connectTimeout: 8000 };
    if (useLdaps) opts.tlsOptions = { rejectUnauthorized: false };
    const client = new Client(opts);

    let baseDN = '', domain = '', dnsHostName = '';
    try {
        // RootDSE anonim okunabilir (bind gerekmez)
        const { searchEntries } = await client.search('', {
            scope: 'base', filter: '(objectClass=*)',
            attributes: ['defaultNamingContext', 'dnsHostName']
        });
        const root = searchEntries[0] || {};
        baseDN = String(root.defaultNamingContext || '');
        dnsHostName = String(root.dnsHostName || '');
        domain = dnToDomain(baseDN);
        console.log(`      Base DN : ${baseDN || '(bulunamadı)'}`);
        console.log(`      DC adı  : ${dnsHostName || '(bulunamadı)'}`);
        console.log(`      Domain  : ${domain || '(bulunamadı)'}`);
    } catch (e) {
        console.error('✗ RootDSE okunamadı:', e.message);
    }
    if (!baseDN) {
        console.error('\n✗ Base DN keşfedilemedi — sunucu bir AD Domain Controller olmayabilir.');
        console.error('  (AD DS rolü kurulup domain provision yapıldı mı?)');
        try { await client.unbind(); } catch { /* ok */ }
        process.exit(3);
    }

    // Bind DN: UPN biçimi (Administrator@domain) her AD'de çalışır
    const bindDN = username.includes('@') || username.includes('=')
        ? username : `${username}@${domain}`;

    console.log(`\n[3/4] Kimlik doğrulama → ${bindDN} ...`);
    try {
        await client.bind(bindDN, password);
        console.log('      Bind başarılı ✓');
        const { searchEntries } = await client.search(baseDN, {
            scope: 'sub',
            filter: '(&(objectClass=user)(!(objectClass=computer)))',
            attributes: ['sAMAccountName'], sizeLimit: 5
        });
        console.log(`      Örnek sorgu ✓ (görülen kullanıcılar: ${searchEntries.map(e => e.sAMAccountName).join(', ')})`);
    } catch (e) {
        console.error('✗ Bind/sorgu başarısız:', e.message);
        console.error('  Kullanıcı adı veya parolayı kontrol edin.');
        try { await client.unbind(); } catch { /* ok */ }
        process.exit(4);
    }
    try { await client.unbind(); } catch { /* ok */ }

    console.log(`\n[4/4] PrintHub ayarları:`);
    const settings = {
        ad_url: url,
        ad_base_dn: baseDN,
        ad_bind_dn: bindDN,
        ad_password: password,
        ad_tls_insecure: useLdaps ? '1' : '0', // self-signed sertifika için (test)
    };
    for (const [k, v] of Object.entries(settings)) {
        console.log(`      ${k.padEnd(16)} = ${k === 'ad_password' ? '********' : v}`);
    }

    if (SAVE) {
        // DB'ye yaz — Electron dışı çalışırken parola düz metin saklanır;
        // uygulama Electron'da açılınca migratePlaintextSecrets() şifreye taşır.
        const { setSetting, setSecureSetting } = require(path.join(__dirname, '..', 'db'));
        for (const [k, v] of Object.entries(settings)) {
            if (k === 'ad_password') setSecureSetting(k, v);
            else setSetting(k, v);
        }
        console.log('\n✓ Ayarlar PrintHub veritabanına kaydedildi.');
        console.log('  Uygulamayı açın → AD Kullanıcıları sekmesi doğrudan çalışır.');
    } else {
        console.log('\nℹ Kaydetmek için sonuna --save ekleyin, veya değerleri');
        console.log('  Ayarlar → Active Directory ekranına elle girin.');
    }
    console.log('\n⚠ Güvenlik notu: Administrator yerine salt-okur bir servis hesabı');
    console.log('  kullanmak en az ayrıcalık ilkesine uygundur (ISO 27001 A.5.15).\n');
}

main().catch(e => { console.error('Beklenmeyen hata:', e.message); process.exit(10); });
