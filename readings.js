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
    // Anlamlı veri yoksa (SNMP yok) kayıt tutma
    const total = Number(printer.totalPrinted) || 0;
    const toner = printer.toner || {};
    db.prepare(`INSERT INTO printer_readings (printer_ip, serial, name, total_printed, toner_json)
                VALUES (?, ?, ?, ?, ?)`)
        .run(printer.ip, printer.serialNumber || '', printer.name || '', total, JSON.stringify(toner));
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
 * Toner tüketim raporu:
 *  - byPrinter: yazıcı bazlı bu ayki sayfa, toplam sayfa aralığı, renk bazlı değişim sayısı
 *  - monthlyTotals: ay bazlı ağ geneli basılan sayfa
 *  - toplam tahmini toner değişimi & maliyet (toner_types birim maliyetleriyle)
 */
function getTonerUsageReport() {
    const tonerTypes = db.prepare('SELECT * FROM toner_types').all();
    const nowMonth = ym(new Date().toISOString());

    // N+1 yerine tek sorgu: tüm okumalar bir kerede çekilir, JS'te IP bazında gruplanır
    const allRows = db.prepare(`SELECT printer_ip, total_printed, toner_json, captured_at, name
                                FROM printer_readings
                                ORDER BY printer_ip, captured_at ASC`).all();
    const rowsByIp = new Map();
    for (const r of allRows) {
        if (!rowsByIp.has(r.printer_ip)) rowsByIp.set(r.printer_ip, []);
        rowsByIp.get(r.printer_ip).push(r);
    }

    const byPrinter = [];
    const monthlyMap = {};   // 'YYYY-MM' -> pages
    let totalReplacements = 0;
    let totalCost = 0;
    const currency = (db.prepare("SELECT value FROM settings WHERE key='currency'").get() || {}).value || 'TRY';

    for (const [ip, rows] of rowsByIp) {
        if (rows.length === 0) continue;

        const name = rows[rows.length - 1].name || ip;

        // Aylık sayfa: her ay için (max - min) total_printed
        const perMonth = {}; // month -> {min,max}
        for (const r of rows) {
            const m = ym(r.captured_at);
            const tp = r.total_printed || 0;
            if (!perMonth[m]) perMonth[m] = { min: tp, max: tp };
            perMonth[m].min = Math.min(perMonth[m].min, tp);
            perMonth[m].max = Math.max(perMonth[m].max, tp);
        }
        for (const [m, v] of Object.entries(perMonth)) {
            const pages = Math.max(0, v.max - v.min);
            monthlyMap[m] = (monthlyMap[m] || 0) + pages;
        }
        const monthlyPages = perMonth[nowMonth] ? Math.max(0, perMonth[nowMonth].max - perMonth[nowMonth].min) : 0;

        // Renk bazlı kartuş değişim tespiti (seviye yukarı sıçraması)
        const replacements = {};
        let prev = null;
        for (const r of rows) {
            const toner = safeParse(r.toner_json);
            if (prev) {
                for (const [color, level] of Object.entries(toner)) {
                    const p = prev[color];
                    // Değişim = büyük yukarı sıçrama VE yeni seviyenin dolu kartuşa yakın olması
                    if (typeof p === 'number' && typeof level === 'number'
                        && level - p >= TONER_JUMP_THRESHOLD
                        && level >= TONER_NEW_MIN_LEVEL) {
                        replacements[color] = (replacements[color] || 0) + 1;
                    }
                }
            }
            prev = toner;
        }

        // Maliyet: renk bazlı değişim * eşleşen toner tipi birim maliyeti
        for (const [color, count] of Object.entries(replacements)) {
            totalReplacements += count;
            const match = tonerTypes.find(t => t.color === color) || null;
            if (match) totalCost += count * (match.unit_cost || 0);
        }

        byPrinter.push({
            ip, name,
            monthlyPages,
            totalRange: (rows[rows.length - 1].total_printed || 0) - (rows[0].total_printed || 0),
            currentTotal: rows[rows.length - 1].total_printed || 0,
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
