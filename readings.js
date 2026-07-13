// ============================================
// PrintHub — Yazıcı Okumaları & Toner Tüketimi (readings.js)
// Her tarama/yenileme sonrası yazıcıların sayfa sayacı ve toner
// seviyeleri zaman serisi olarak kaydedilir; aylık tüketim ve
// toner değişim sayısı buradan hesaplanır.
// ============================================

const { db } = require('./db');

const TONER_JUMP_THRESHOLD = 30; // seviye bu kadar puan yukarı sıçrarsa = kartuş değişimi

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
    const ips = db.prepare('SELECT DISTINCT printer_ip FROM printer_readings').all().map(r => r.printer_ip);
    const tonerTypes = db.prepare('SELECT * FROM toner_types').all();
    const nowMonth = ym(new Date().toISOString());

    const byPrinter = [];
    const monthlyMap = {};   // 'YYYY-MM' -> pages
    let totalReplacements = 0;
    let totalCost = 0;
    const currency = (db.prepare("SELECT value FROM settings WHERE key='currency'").get() || {}).value || 'TRY';

    for (const ip of ips) {
        const rows = db.prepare(`SELECT total_printed, toner_json, captured_at, name
                                 FROM printer_readings WHERE printer_ip = ?
                                 ORDER BY captured_at ASC`).all(ip);
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
                    if (typeof p === 'number' && typeof level === 'number' && level - p >= TONER_JUMP_THRESHOLD) {
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

module.exports = { recordReading, recordAll, getHistory, getTonerUsageReport };
