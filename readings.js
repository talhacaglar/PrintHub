// ============================================
// PrintHub — Yazıcı Okumaları & Toner Tüketimi (readings.js)
// Her tarama/yenileme sonrası yazıcıların sayfa sayacı ve toner
// seviyeleri zaman serisi olarak kaydedilir; aylık tüketim ve
// toner değişim sayısı buradan hesaplanır.
// ============================================

const { db } = require('./db');

const TONER_JUMP_THRESHOLD = 30; // seviye bu kadar puan yukarı sıçrarsa = kartuş değişimi
const TONER_NEW_MIN_LEVEL = 75;  // yanlış pozitif azaltma: yeni kartuş en az bu seviyede başlamalı
                                 // (SNMP okuma dalgalanmaları 30 puanlık sahte sıçrama yapabilir;
                                 //  gerçek değişimde seviye ~%100'e çıkar)

/**
 * Tek bir yazıcının anlık durumunu kaydeder.
 */
function recordReading(printer) {
    if (!printer || !printer.ip) return;

    // SNMP yanıtı olmayan cihaz için okuma UYDURULMAZ. Fonksiyonun eski hâli
    // "anlamlı veri yoksa kayıt tutma" diye yorumlanmıştı ama `Number(x) || 0`
    // ile total_printed=0 ve toner {"black":-1} yazıyordu. server.js recordAll'ı
    // çevrim dışı yazıcılar dahil TÜM listeyle çağırdığı için her yenilemede
    // erişilemeyen her cihaz için bir satır ekleniyordu. İki ayrı bozulma:
    //   1) 0 sayfa okuması aylık tüketimde min olarak alınıp cihazın ömür boyu
    //      sayacı kadar sahte tüketim üretiyordu (getTonerUsageReport bunu
    //      savunma amaçlı tp<=0 ile eliyordu — kendi ürettiğimiz veriye karşı),
    //   2) -1 seviyesi bir sayı olduğu için, cihaz geri döndüğünde -1 → 88
    //      geçişi "89 puanlık sıçrama" sayılıp HAYALİ kartuş değişimi ve
    //      maliyet üretiyordu. Çevrim dışı olup dönen her yazıcı için bir tane.
    if (printer.snmpAvailable === false) return;

    const total = Number(printer.totalPrinted);
    const sayfaVar = Number.isFinite(total) && total > 0;

    // Bilinmeyen (negatif) seviyeler zaman serisine yazılmaz — "bilinmiyor"
    // bir ölçüm değildir.
    const toner = Object.fromEntries(
        Object.entries(printer.toner || {})
            .filter(([, v]) => typeof v === 'number' && v >= 0)
    );

    if (!sayfaVar && Object.keys(toner).length === 0) return; // kaydedilecek ölçüm yok

    db.prepare(`INSERT INTO printer_readings (printer_ip, serial, name, total_printed, toner_json)
                VALUES (?, ?, ?, ?, ?)`)
        .run(printer.ip, printer.serialNumber || '', printer.name || '',
             sayfaVar ? total : null, JSON.stringify(toner));
}

/**
 * Bir dizi yazıcı için toplu kayıt.
 */
function recordAll(printers) {
    const tx = db.transaction((list) => {
        for (const p of list) recordReading(p);
    });
    tx(printers || []);
}

/**
 * Belirli bir yazıcının okuma geçmişi.
 */
function getHistory(ip, limit = 200) {
    return db.prepare(`SELECT id, total_printed, toner_json, captured_at
                       FROM printer_readings WHERE printer_ip = ?
                       ORDER BY captured_at ASC LIMIT ?`).all(ip, limit)
        .map(r => ({ ...r, toner: safeParse(r.toner_json) }));
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
function ym(dateStr) { return (dateStr || '').slice(0, 7); } // 'YYYY-MM'

/**
 * Toner tipine tanımlı uyumlu yazıcı modeli ile cihazın bildirdiği sysDescr'ı
 * eşleştirir. İki yönlü `includes` kullanılır çünkü sysDescr genelde daha uzundur
 * ("HP LaserJet M506dn, Firmware 2.4" ⊃ "LaserJet M506"), bazen de kısadır.
 * İkisinden biri boşsa eşleşme YOK sayılır — boş alanı joker kabul etmek,
 * maliyeti rastgele bir toner tipine yazmak demek olurdu.
 */
function modelEslesir(tonerModel, yaziciModel) {
    const a = String(tonerModel || '').trim().toLowerCase();
    const b = String(yaziciModel || '').trim().toLowerCase();
    if (!a || !b) return false;
    return a.includes(b) || b.includes(a);
}

/**
 * Toner tüketim raporu:
 *  - byPrinter: yazıcı bazlı bu ayki sayfa, toplam sayfa aralığı, renk bazlı değişim sayısı
 *  - monthlyTotals: ay bazlı ağ geneli basılan sayfa
 *  - toplam tahmini toner değişimi & maliyet (toner_types birim maliyetleriyle)
 */
function getTonerUsageReport() {
    const tonerTypes = db.prepare('SELECT * FROM toner_types').all();
    const nowMonth = ym(new Date().toISOString());

    // N+1 yerine tek sorgu: tüm okumalar bir kerede çekilir, JS'te IP bazında
    // gruplanır. Yazıcı modeli maliyet eşleştirmesi için known_printers'tan alınır.
    const allRows = db.prepare(`SELECT r.printer_ip, r.total_printed, r.toner_json,
                                       r.captured_at, r.name, k.model AS printer_model
                                FROM printer_readings r
                                LEFT JOIN known_printers k ON k.printer_ip = r.printer_ip
                                ORDER BY r.printer_ip, r.captured_at ASC`).all();
    const rowsByIp = new Map();
    for (const r of allRows) {
        if (!rowsByIp.has(r.printer_ip)) rowsByIp.set(r.printer_ip, []);
        rowsByIp.get(r.printer_ip).push(r);
    }

    const byPrinter = [];
    const monthlyMap = {};   // 'YYYY-MM' -> pages
    let totalReplacements = 0;
    let pricedReplacements = 0;
    let unpricedReplacements = 0;
    let totalCost = 0;
    const currency = (db.prepare("SELECT value FROM settings WHERE key='currency'").get() || {}).value || 'TRY';

    for (const [ip, rows] of rowsByIp) {
        if (rows.length === 0) continue;

        const name = rows[rows.length - 1].name || ip;

        // Aylık sayfa: her ay için (max - min) total_printed
        // ÖNEMLİ: SNMP yanıt vermediğinde sayaç 0 kaydedilir. Bu sıfırlar min
        // olarak alınırsa aylık tüketim, cihazın ömür boyu sayacı kadar şişer
        // (ör. 0 → 349.985 = "bu ay 349 bin sayfa"). Bu yüzden yalnızca
        // pozitif okumalar hesaba katılır.
        const perMonth = {}; // month -> {min,max}
        for (const r of rows) {
            const tp = r.total_printed || 0;
            if (tp <= 0) continue; // geçersiz/SNMP'siz okuma
            const m = ym(r.captured_at);
            if (!perMonth[m]) perMonth[m] = { min: tp, max: tp };
            perMonth[m].min = Math.min(perMonth[m].min, tp);
            perMonth[m].max = Math.max(perMonth[m].max, tp);
        }
        for (const [m, v] of Object.entries(perMonth)) {
            const pages = Math.max(0, v.max - v.min);
            monthlyMap[m] = (monthlyMap[m] || 0) + pages;
        }
        const monthlyPages = perMonth[nowMonth] ? Math.max(0, perMonth[nowMonth].max - perMonth[nowMonth].min) : 0;

        // Renk bazlı kartuş değişim tespiti (seviye yukarı sıçraması).
        // Negatif ("bilinmiyor") seviyeler açıkça elenir: -1 de bir sayı olduğu
        // için -1 → 88 geçişi 89 puanlık sıçrama sayılıp hayali kartuş değişimi
        // üretiyordu. recordReading artık negatif yazmıyor; bu kontrol eski
        // kayıtlar için savunmadır.
        const replacements = {};
        let prev = null;
        for (const r of rows) {
            const toner = safeParse(r.toner_json);
            if (prev) {
                for (const [color, level] of Object.entries(toner)) {
                    const p = prev[color];
                    // Değişim = büyük yukarı sıçrama VE yeni seviyenin dolu kartuşa yakın olması
                    if (typeof p === 'number' && p >= 0
                        && typeof level === 'number' && level >= 0
                        && level - p >= TONER_JUMP_THRESHOLD
                        && level >= TONER_NEW_MIN_LEVEL) {
                        replacements[color] = (replacements[color] || 0) + 1;
                    }
                }
            }
            prev = toner;
        }

        // Maliyet: yalnızca BU yazıcının modeline tanımlanmış toner tipinden
        // hesaplanır. Eskiden o renkteki ilk toner tipi kullanılıyordu — yani
        // bir Konica değişimi, tabloda ilk sırada duran siyah tonerin fiyatıyla
        // faturalanıyordu. Model eşleşmesi yoksa maliyet UYDURULMAZ; değişim
        // "fiyatlandırılamadı" olarak ayrıca raporlanır.
        const printerModel = rows[rows.length - 1].printer_model || '';
        for (const [color, count] of Object.entries(replacements)) {
            totalReplacements += count;
            const match = tonerTypes.find(t => t.color === color && modelEslesir(t.printer_model, printerModel));
            if (match) {
                pricedReplacements += count;
                totalCost += count * (match.unit_cost || 0);
            } else {
                unpricedReplacements += count;
            }
        }

        // Sayaç alanları yalnızca GERÇEK okumalardan gelir. total_printed artık
        // NULL olabiliyor (sayaç okunamadı); `|| 0` ile 0'a düşürmek "cihaz hiç
        // basmamış" demek olurdu.
        const sayacli = rows.filter(r => typeof r.total_printed === 'number' && r.total_printed > 0);
        const ilk = sayacli.length ? sayacli[0].total_printed : null;
        const son = sayacli.length ? sayacli[sayacli.length - 1].total_printed : null;

        byPrinter.push({
            ip, name,
            monthlyPages,
            totalRange: son !== null && ilk !== null ? son - ilk : null,
            currentTotal: son,
            replacements,
            readings: rows.length
        });
    }

    const monthlyTotals = Object.entries(monthlyMap)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([month, pages]) => ({ month, pages }));

    return {
        byPrinter: byPrinter.sort((a, b) => b.monthlyPages - a.monthlyPages),
        monthlyTotals,
        totalReplacements,
        // estimatedCost KISMİdir: yalnızca modeli bir toner tipiyle eşleşen
        // değişimleri kapsar. Arayüz fiyatlandırılamayan sayıyı ayrıca gösterir
        // ki kullanıcı eksik bir toplamı tam sanmasın.
        pricedReplacements,
        unpricedReplacements,
        estimatedCost: Math.round(totalCost * 100) / 100,
        currency,
        currentMonth: nowMonth
    };
}

/**
 * Saklama (retention) politikası — printer_readings sınırsız büyümesin.
 * retentionDays'ten eski kayıtlar gün bazında özetlenir (her yazıcı+gün için
 * son okuma tutulur, ara okumalar silinir). Böylece aylık tüketim hesabı
 * (ay içi min/max) bozulmadan tablo küçük kalır.
 */
function pruneReadings(retentionDays = 90) {
    const days = parseInt(retentionDays) || 90;
    if (days <= 0) return { deleted: 0 };
    const info = db.prepare(`
        DELETE FROM printer_readings
        WHERE captured_at < datetime('now', ?)
          AND id NOT IN (
              SELECT MAX(id) FROM printer_readings
              WHERE captured_at < datetime('now', ?)
              GROUP BY printer_ip, date(captured_at)
          )
    `).run(`-${days} days`, `-${days} days`);
    if (info.changes > 0) {
        console.log(`[Readings] Saklama politikası: ${info.changes} eski ham okuma özetlendi (${days} günden eski).`);
    }
    return { deleted: info.changes };
}

module.exports = { recordReading, recordAll, getHistory, getTonerUsageReport, pruneReadings };
