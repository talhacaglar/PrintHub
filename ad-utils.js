// ============================================
// PrintHub — AD saf yardımcı fonksiyonlar (ad-utils.js)
// db/ldap bağımlılığı YOK — birim testleri doğrudan çalıştırabilir.
// ============================================

// sAMAccountName biçim doğrulaması — PowerShell/LDAP enjeksiyonuna karşı
// birincil savunma hattı. AD'de sAM şu karakterleri zaten içeremez:
// " / \ [ ] : ; | = , + * ? < >  — güvenli alt kümeye izin veriyoruz.
const SAM_RE = /^[A-Za-z0-9._$-]{1,64}$/;
function assertValidSam(sam) {
    if (!SAM_RE.test(String(sam || ''))) {
        throw new Error('Geçersiz kullanıcı adı biçimi.');
    }
    return sam;
}

/**
 * AD FILETIME (1601'den beri 100ns) → ISO tarih. lastLogonTimestamp için.
 */
function fileTimeToISO(ft) {
    const n = Number(ft);
    if (!n || n <= 0) return '';
    const ms = n / 10000 - 11644473600000; // 100ns → ms, epoch farkı
    if (ms <= 0) return '';
    try { return new Date(ms).toISOString(); } catch { return ''; }
}

/**
 * userAccountControl bit alanından hesap durumu.
 * 0x2 = ACCOUNTDISABLE, 0x10 = LOCKOUT
 */
function uacFlags(uac) {
    const n = parseInt(uac) || 0;
    return { disabled: !!(n & 0x2), lockedOut: !!(n & 0x10) };
}

module.exports = { assertValidSam, fileTimeToISO, uacFlags, SAM_RE };
