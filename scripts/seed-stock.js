#!/usr/bin/env node
// ============================================================
// PrintHub — Stok Simülasyonu (seed-stock.js)
// ============================================================
// AMAÇ
//   Ağdaki GERÇEK yazıcılardan (printer_readings) yola çıkarak
//   toner türlerini tanımlar ve geçmiş kartuş tüketimini sayfa
//   sayaçlarından geriye dönük türetip stock_movements'a yazar.
//
// !!! ÖNEMLİ — BU VERİ SİMÜLASYONDUR !!!
//   Yazıcı modelleri, seri numaraları ve sayfa sayaçları GERÇEKTİR.
//   Ancak kartuş değişim TARİHLERİ ve stok hareketleri, sayfa
//   sayaçlarından TÜRETİLMİŞ TAHMİNLERDİR — fiili satın alma
//   kayıtları değildir.
//
//   Bu yüzden üretilen her satır ayırt edilebilir şekilde
//   damgalanır (SIM_TAG). Geri almak için:
//       node scripts/seed-stock.js --temizle
// ============================================================

const path = require('node:path');
const { db } = require(path.join(__dirname, '..', 'db'));

const SIM_TAG = '[SIM]';            // her simüle kaydın note alanındaki damga
const SIM_ACTOR = 'sistem(simülasyon)';

// ------------------------------------------------------------
// 1) Toner türleri — ağdaki gerçek yazıcı modellerine göre
// ------------------------------------------------------------
// Fiyatlar Türkiye piyasası orijinal kartuş ortalamalarıdır (2025, KDV hariç,
// yaklaşık). Kendi tedarikçi fiyatlarınızla güncellemelisiniz.
// yield_pages değerleri üretici ISO/IEC 19798 (renkli) ve 19752 (mono) beyanlarıdır.
const TONER_TYPES = [
    // KONICA MINOLTA bizhub C257i → TN-227 serisi (6 adet cihaz)
    { name: 'Konica Minolta TN-227K', color: 'black',   printer_model: 'bizhub C257i', yield_pages: 24000, unit_cost: 4850, min_stock: 2 },
    { name: 'Konica Minolta TN-227C', color: 'cyan',    printer_model: 'bizhub C257i', yield_pages: 21000, unit_cost: 6200, min_stock: 1 },
    { name: 'Konica Minolta TN-227M', color: 'magenta', printer_model: 'bizhub C257i', yield_pages: 21000, unit_cost: 6200, min_stock: 1 },
    { name: 'Konica Minolta TN-227Y', color: 'yellow',  printer_model: 'bizhub C257i', yield_pages: 21000, unit_cost: 6200, min_stock: 1 },

    // Samsung/HP mono cihazlar (SEC... hostname'li 2 adet) → MLT-D203E muadili
    { name: 'Samsung MLT-D203E',      color: 'black',   printer_model: 'SL-M3820/4020', yield_pages: 10000, unit_cost: 3400, min_stock: 2 },

    // HP mono cihaz (HP11E204) → CF287X
    { name: 'HP CF287X (87X)',        color: 'black',   printer_model: 'LaserJet M506/M527', yield_pages: 18000, unit_cost: 7900, min_stock: 2 },
];

// Hangi yazıcı hangi toner ailesini kullanıyor (gerçek okumalardan eşleşir)
function tonerFamilyFor(name) {
    const n = (name || '').toLowerCase();
    if (n.includes('bizhub c257i')) return 'konica';
    if (n.startsWith('sec'))        return 'samsung';
    if (n.startsWith('hp'))         return 'hp';
    return null; // SNMP'siz cihazlar / yazıcı olmayanlar hariç tutulur
}

const FAMILY_TONERS = {
    konica:  ['Konica Minolta TN-227K', 'Konica Minolta TN-227C', 'Konica Minolta TN-227M', 'Konica Minolta TN-227Y'],
    samsung: ['Samsung MLT-D203E'],
    hp:      ['HP CF287X (87X)'],
};

// Renkli cihazlarda renk kartuşları siyah kadar hızlı tükenmez.
// Ortalama %20 renkli kapsama varsayımı (tipik ofis: metin ağırlıklı).
const COLOR_USAGE_FACTOR = { black: 1.0, cyan: 0.35, magenta: 0.35, yellow: 0.35 };

// ------------------------------------------------------------
// 2) Temizleme — simüle edilmiş her şeyi geri al
// ------------------------------------------------------------
function temizle() {
    const mv = db.prepare(`DELETE FROM stock_movements WHERE note LIKE ?`).run(SIM_TAG + '%');
    const tt = db.prepare(`DELETE FROM toner_types WHERE name IN (${TONER_TYPES.map(() => '?').join(',')})`)
        .run(...TONER_TYPES.map(t => t.name));
    const au = db.prepare(`DELETE FROM audit_log WHERE actor = ?`).run(SIM_ACTOR);
    console.log(`Temizlendi → ${mv.changes} stok hareketi, ${tt.changes} toner türü, ${au.changes} denetim kaydı.`);
}

// ------------------------------------------------------------
// 3) Yazıcı başına gerçek verileri topla
// ------------------------------------------------------------
function gercekYazicilar() {
    const ips = db.prepare('SELECT DISTINCT printer_ip FROM printer_readings').all().map(r => r.printer_ip);
    const out = [];
    for (const ip of ips) {
        const rows = db.prepare(
            `SELECT name, serial, total_printed, toner_json, captured_at
             FROM printer_readings WHERE printer_ip = ? ORDER BY captured_at ASC`).all(ip);
        if (!rows.length) continue;

        const last = rows[rows.length - 1];
        const family = tonerFamilyFor(last.name);
        if (!family) continue;                       // SNMP'siz cihaz / yazıcı değil
        if (!(last.total_printed > 0)) continue;     // sayaç okunamamış

        // Gerçek ölçülen artış (gözlem penceresi içinde)
        const valid = rows.filter(r => r.total_printed > 0);
        const olculenArtis = valid.length >= 2
            ? valid[valid.length - 1].total_printed - valid[0].total_printed : 0;
        const gunSayisi = valid.length >= 2
            ? Math.max(1, (new Date(valid[valid.length - 1].captured_at) - new Date(valid[0].captured_at)) / 86400000)
            : 0;

        let toner = {};
        try { toner = JSON.parse(last.toner_json) || {}; } catch (e) { toner = {}; }

        out.push({
            ip, name: last.name, serial: last.serial, family,
            omurSayfa: last.total_printed,          // GERÇEK: cihaz ömrü toplam sayfa
            olculenArtis,                            // GERÇEK: gözlemlenen artış
            gunSayisi,                               // GERÇEK: gözlem süresi
            gunlukOrt: gunSayisi > 0 ? olculenArtis / gunSayisi : 0,
            toner,                                   // GERÇEK: son toner seviyeleri
        });
    }
    return out;
}

// ------------------------------------------------------------
// 4) Toner türlerini ekle
// ------------------------------------------------------------
function tonerTurleriniEkle(currency) {
    const ins = db.prepare(`INSERT INTO toner_types (name, color, printer_model, yield_pages, unit_cost, currency, min_stock)
                            VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const idMap = {};
    for (const t of TONER_TYPES) {
        const mevcut = db.prepare('SELECT id FROM toner_types WHERE name = ?').get(t.name);
        idMap[t.name] = mevcut
            ? mevcut.id
            : ins.run(t.name, t.color, t.printer_model, t.yield_pages, t.unit_cost, currency, t.min_stock).lastInsertRowid;
    }
    return idMap;
}

/**
 * Bir yazıcının ömrü boyunca tükettiği kartuş sayısını sayfa sayacından türetir.
 *   kartuş = ömür_sayfa / kartuş_verimi * renk_faktörü
 * Cihaz yeni takılan kartuşla geldiği için 1 kartuş düşülür (ilk dolum).
 */
function kartusSayisi(omurSayfa, yieldPages, color) {
    const faktor = COLOR_USAGE_FACTOR[color] ?? 1;
    const ham = (omurSayfa / yieldPages) * faktor;
    return Math.max(0, Math.floor(ham));
}

// Gözlem penceresinden önceki tarihlere kartuş değişimlerini yayar.
// Sayfa hızına göre geriye doğru gider: her kartuş, kendi verimi kadar
// sayfa basıldığında değişmiş sayılır.
function degisimTarihleri(adet, gunlukOrt, yieldPages, faktor, sonTarih) {
    if (adet <= 0) return [];
    const etkinYield = yieldPages / (faktor || 1);
    // Bu kadar sayfa için kaç gün gerekir (gözlemlenen hızla)
    const gunPerKartus = gunlukOrt > 0 ? etkinYield / gunlukOrt : 365;
    const tarihler = [];
    let t = new Date(sonTarih);
    for (let i = 0; i < adet; i++) {
        t = new Date(t.getTime() - gunPerKartus * 86400000);
        if (t.getFullYear() < 2015) break; // makul olmayan geçmişe gitme
        tarihler.push(new Date(t));
    }
    return tarihler.reverse(); // eskiden yeniye
}

// ------------------------------------------------------------
// 5) Ana akış
// ------------------------------------------------------------
function calistir() {
    const currency = (db.prepare("SELECT value FROM settings WHERE key='currency'").get() || {}).value || 'TRY';
    const yazicilar = gercekYazicilar();

    if (!yazicilar.length) {
        console.log('Uygun yazıcı bulunamadı. Önce bir ağ taraması yapın.');
        return;
    }

    const idMap = tonerTurleriniEkle(currency);
    const tipByName = {};
    for (const t of TONER_TYPES) tipByName[t.name] = t;

    const insMv = db.prepare(`INSERT INTO stock_movements
        (toner_type_id, direction, quantity, unit_cost, printer_ip, note, actor, movement_date, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`);

    const bugun = new Date();
    const ozet = [];   // rapor için
    let toplamCikis = 0, toplamMaliyet = 0;

    const tx = db.transaction(() => {
        for (const y of yazicilar) {
            const tonerAdlari = FAMILY_TONERS[y.family];
            for (const ad of tonerAdlari) {
                const tip = tipByName[ad];
                const faktor = COLOR_USAGE_FACTOR[tip.color] ?? 1;
                const adet = kartusSayisi(y.omurSayfa, tip.yield_pages, tip.color);
                if (adet <= 0) continue;

                const tarihler = degisimTarihleri(adet, y.gunlukOrt, tip.yield_pages, faktor, bugun);
                for (const t of tarihler) {
                    const gun = t.toISOString().slice(0, 10);
                    insMv.run(idMap[ad], 'out', 1, tip.unit_cost, y.ip,
                        `${SIM_TAG} ${y.name} — sayfa sayacından türetildi (${y.omurSayfa} sayfa / ${tip.yield_pages} verim)`,
                        SIM_ACTOR, gun);
                    toplamCikis++;
                    toplamMaliyet += tip.unit_cost;
                }
                ozet.push({ ip: y.ip, yazici: y.name, toner: ad, adet: tarihler.length, birim: tip.unit_cost });
            }
        }

        // Çıkışları karşılayacak giriş (satın alma) hareketleri + emniyet stoğu.
        // Aksi halde stok bakiyesi negatif görünür.
        for (const t of TONER_TYPES) {
            const cikis = db.prepare(
                `SELECT COALESCE(SUM(quantity),0) c FROM stock_movements
                 WHERE toner_type_id = ? AND direction='out'`).get(idMap[t.name]).c;
            if (cikis <= 0) continue;
            const emniyet = t.min_stock + 1;       // elde kalan makul stok
            const girisAdet = cikis + emniyet;
            insMv.run(idMap[t.name], 'in', girisAdet, t.unit_cost, null,
                `${SIM_TAG} Başlangıç envanteri + geçmiş alımlar (toplu)`,
                SIM_ACTOR, '2024-01-15');
        }

        db.prepare(`INSERT INTO audit_log (actor, action, entity, entity_id, detail, ip)
                    VALUES (?, 'seed', 'stock', NULL, ?, '127.0.0.1')`)
            .run(SIM_ACTOR, `${toplamCikis} simüle kartuş çıkışı üretildi (${SIM_TAG})`);
    });
    tx();

    // ---------------- Rapor ----------------
    console.log('\n' + '='.repeat(78));
    console.log('  SİMÜLASYON TAMAMLANDI — veriler ' + SIM_TAG + ' ile damgalandı');
    console.log('='.repeat(78));
    console.log(`Kapsanan gerçek yazıcı : ${yazicilar.length}`);
    console.log(`Üretilen kartuş çıkışı : ${toplamCikis} adet`);
    console.log(`Toplam geçmiş maliyet  : ${toplamMaliyet.toLocaleString('tr-TR')} ${currency}`);

    console.log('\n--- Yazıcı bazında (ömür boyu tahmini tüketim) ---');
    for (const o of ozet.filter(o => o.adet > 0)) {
        console.log(`  ${o.ip.padEnd(15)} ${o.toner.padEnd(26)} ${String(o.adet).padStart(3)} kartuş`);
    }

    // Gerçek ölçüme dayalı ileriye dönük projeksiyon
    console.log('\n--- GERÇEK ölçüme dayalı günlük hız (gözlem penceresi) ---');
    let gunlukToplam = 0;
    for (const y of yazicilar) {
        if (y.gunlukOrt > 0) {
            console.log(`  ${y.ip.padEnd(15)} ${String(Math.round(y.gunlukOrt)).padStart(5)} sayfa/gün  (${y.olculenArtis} sayfa / ${y.gunSayisi.toFixed(1)} gün)`);
            gunlukToplam += y.gunlukOrt;
        }
    }
    console.log(`  ${'TOPLAM'.padEnd(15)} ${String(Math.round(gunlukToplam)).padStart(5)} sayfa/gün`);

    // Yıllık maliyet projeksiyonu — sayfa başı maliyetten
    let sayfaBasiMaliyetToplam = 0, agirlik = 0;
    for (const y of yazicilar) {
        const toners = FAMILY_TONERS[y.family].map(n => tipByName[n]);
        const sbm = toners.reduce((s, t) =>
            s + (t.unit_cost / t.yield_pages) * (COLOR_USAGE_FACTOR[t.color] ?? 1), 0);
        sayfaBasiMaliyetToplam += sbm * (y.gunlukOrt || 0);
        agirlik += (y.gunlukOrt || 0);
    }
    const ortSayfaMaliyet = agirlik > 0 ? sayfaBasiMaliyetToplam / agirlik : 0;
    const yillikSayfa = gunlukToplam * 365;
    console.log('\n--- Projeksiyon (gerçek hıza dayalı) ---');
    console.log(`  Ortalama sayfa başı toner maliyeti : ${ortSayfaMaliyet.toFixed(4)} ${currency}`);
    console.log(`  Yıllık tahmini sayfa               : ${Math.round(yillikSayfa).toLocaleString('tr-TR')}`);
    console.log(`  Yıllık tahmini toner maliyeti      : ${Math.round(yillikSayfa * ortSayfaMaliyet).toLocaleString('tr-TR')} ${currency}`);
    console.log('\nGeri almak için: node scripts/seed-stock.js --temizle\n');
}

// ------------------------------------------------------------
if (require.main === module) {
    const arg = process.argv[2];
    if (arg === '--temizle') temizle();
    else calistir();
}

module.exports = { SIM_TAG, SIM_ACTOR, TONER_TYPES, tonerFamilyFor, FAMILY_TONERS, COLOR_USAGE_FACTOR, db, temizle, gercekYazicilar, tonerTurleriniEkle, kartusSayisi, degisimTarihleri, calistir };
