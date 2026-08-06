/**
 * Yazıcı Kimliği ve Tarama Birleştirme
 *
 * Eskiden birleştirme yalnızca IP string'ine bakıyordu: DHCP ile adresi değişen
 * bir cihaz eski IP'sini kalıcı "çevrim dışı" kayıt olarak bırakıp yeni IP'siyle
 * yeniden ekleniyordu — liste her taramada büyüyordu. Artık kimlik
 * seri no > MAC > IP sırasıyla belirlenir.
 *
 * Bu modül saf tutulur (DB/ağ bağımlılığı yok) ki test edilebilsin;
 * yan etkiler (IP taşıma, denetim logu) callback ile dışarıdan verilir.
 */

/**
 * Bir yazıcının kimlik anahtarlarını öncelik sırasıyla döndürür.
 * Seri no en güvenilir; MAC ikinci; IP yalnızca son çare (SNMP'siz cihazlar).
 * @param {object} p
 * @returns {string[]}
 */
function identityKeys(p) {
    const keys = [];
    const sn = String(p.serialNumber || '').trim().toUpperCase();
    const mac = String(p.mac || '').trim().toLowerCase();
    if (sn) keys.push(`sn:${sn}`);
    if (mac && mac !== '00:00:00:00:00:00') keys.push(`mac:${mac}`);
    keys.push(`ip:${String(p.ip || '').trim()}`);
    return keys;
}

/**
 * Tarama sonuçlarını bilinen yazıcı listesiyle kimlik üzerinden birleştirir.
 * Bu taramada bulunamayanlar "çevrim dışı" olarak korunur — listeden düşürme
 * işi pruneStalePrinters'a aittir.
 * @param {Array} previous - önceki liste (discoveredPrinters)
 * @param {Array} results - bu taramanın SNMP sonuçları
 * @param {function} [onIpChange] - (oldIp, newIp) IP değişiminde çağrılır
 * @param {string} [nowIso] - test edilebilirlik için
 * @returns {Array} id'leri yeniden numaralanmış birleşik liste
 */
function mergeScanResults(previous, results, onIpChange, nowIso = new Date().toISOString()) {
    // Önceki kayıtları TÜM kimlik anahtarlarıyla indeksle — bir sonuç hangi
    // anahtardan eşleşirse eşleşsin aynı kaydı bulsun. Böylece SNMP'nin bu
    // taramada cevap vermediği bir cihaz IP'sinden, adresi değişmiş bir cihaz
    // da seri no/MAC'inden mevcut kaydına oturur.
    const index = new Map();
    for (const p of previous) {
        for (const key of identityKeys(p)) {
            if (!index.has(key)) index.set(key, p);
        }
    }

    const merged = [];
    const consumed = new Set();

    for (const r of results) {
        let old = null;
        for (const key of identityKeys(r)) {
            const hit = index.get(key);
            if (hit && !consumed.has(hit)) { old = hit; break; }
        }

        if (!old) {
            merged.push({ ...r, firstSeen: nowIso, lastOnline: nowIso });
            continue;
        }

        consumed.add(old);
        if (old.ip !== r.ip && onIpChange) onIpChange(old.ip, r.ip);

        merged.push({
            ...old, ...r,
            // SNMP bu taramada cevap vermediyse kimliği kaybetme — aksi halde
            // cihaz bir sonraki taramada yeniden "yeni" sayılırdı.
            serialNumber: r.serialNumber || old.serialNumber || '',
            mac: r.mac || old.mac || '',
            firstSeen: old.firstSeen || nowIso,
            lastOnline: nowIso
        });
    }

    for (const p of previous) {
        if (consumed.has(p)) continue;
        merged.push({
            ...p, status: 'offline', statusText: 'Çevrim Dışı',
            lastSeen: p.lastSeen === 'Şimdi' ? nowIso : p.lastSeen,
            snmpAvailable: false, queue: []
        });
    }

    return merged.map((p, i) => ({ ...p, id: i + 1 }));
}

/**
 * Belirtilen günden uzun süredir cevap vermeyen kayıtları listeden düşürür.
 * Ağdan tamamen kalkmış ya da kimliği çözülemeyen cihazların sonsuza kadar
 * birikmesini engeller.
 * @param {Array} list
 * @param {number} days - eşik (0 veya negatif = budama kapalı)
 * @param {number} [nowMs]
 * @returns {{kept: Array, dropped: Array}}
 */
function pruneStalePrinters(list, days, nowMs = Date.now()) {
    if (!(days > 0)) return { kept: list, dropped: [] };

    const cutoff = nowMs - days * 86400000;
    const kept = [];
    const dropped = [];

    for (const p of list) {
        const seen = Date.parse(p.lastOnline);
        // lastOnline okunamıyorsa kaydı koruruz — bu kolondan önceki
        // kurulumlardan gelen kayıtları ilk çalıştırmada topluca silmemek için.
        if (!Number.isFinite(seen) || seen >= cutoff) kept.push(p);
        else dropped.push(p);
    }

    return {
        kept: dropped.length > 0 ? kept.map((p, i) => ({ ...p, id: i + 1 })) : list,
        dropped
    };
}

module.exports = { identityKeys, mergeScanResults, pruneStalePrinters };
