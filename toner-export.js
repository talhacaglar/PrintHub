// ============================================
// PrintHub — Toner Takip Excel Dışa Aktarma (toner-export.js)
// Uygulamadaki toner/stok verisini, şirkette kullanılan
// Toner_Takip.xlsx dosyasıyla BİREBİR aynı yapıda üretir.
//
// Sheet düzeni (orijinal dosyadan birebir):
//   1) Toner_Degisim      A:(anahtar) B:Tarih C:Departman D:Alan Kişi
//                         E:Toner Tipi F:KaçGünSonraAldı
//   2) StokDurum          A:TONER MODELİ B:STOK GİRİŞ C:STOK ÇIKIŞ D:MEVCUT
//                         E:DEVİR HIZI F:Sütun1 H:(E/F) J:SON KULLANIMDAN
//                         SONRA GEÇEN GÜN K/L:sipariş uyarısı
//   3) StokGirisCikis     A:TONER MODELİ B:FİRMA C:ADET
//   4) Uyumluluk Tablosu  A2:TONER B2:YAZICI MARKA MODEL, B3..E3 marka başlıkları
//   5) Sayfa1             A:TONER MODELİ B:Miktar (adet)
//
// ISO 27001: A.5.9 (varlık envanteri kaydı), A.8.15 (dışa aktarma denetim izi).
// ============================================

const XLSX = require('xlsx');
const { db } = require('./db');

// Excel seri tarihi (1900 tarih sistemi) — orijinal dosyada Tarih sütunu
// ham sayı olarak tutulur (ör. 44271), biz de aynı biçimi üretiyoruz.
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86400000;

function toExcelSerial(dateStr) {
    if (!dateStr) return null;
    const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z');
    if (isNaN(d.getTime())) return null;
    return Math.round((d.getTime() - EXCEL_EPOCH_UTC) / MS_PER_DAY);
}

function todaySerial() {
    const now = new Date();
    return Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - EXCEL_EPOCH_UTC) / MS_PER_DAY);
}

// ============================================
// VERİ TOPLAMA
// ============================================

// Toner çıkışları = orijinal dosyadaki "toner değişimi" kayıtları.
// Departman/Alan Kişi uygulamada ayrı alan olarak tutulmadığı için
// yazıcı varlık kaydından (özel konum / SNMP konumu / yazıcı adı) ve
// hareketi yapan kullanıcıdan türetilir.
function fetchDegisimRows() {
    return db.prepare(`
        SELECT
            COALESCE(m.movement_date, date(m.created_at)) AS tarih,
            COALESCE(NULLIF(a.custom_location, ''), NULLIF(k.name, ''), m.printer_ip, '') AS departman,
            COALESCE(NULLIF(m.note, ''), NULLIF(m.actor, ''), '') AS alan_kisi,
            t.name AS toner_tipi,
            m.quantity AS adet
        FROM stock_movements m
        JOIN toner_types t ON t.id = m.toner_type_id
        LEFT JOIN printer_assets a ON a.printer_ip = m.printer_ip
        LEFT JOIN known_printers k ON k.printer_ip = m.printer_ip
        WHERE m.direction = 'out'
        ORDER BY tarih ASC, m.id ASC
    `).all();
}

// Stok girişleri — orijinaldeki StokGirisCikis sayfası (TONER MODELİ / FİRMA / ADET)
function fetchGirisRows() {
    return db.prepare(`
        SELECT
            t.name AS toner_modeli,
            COALESCE(NULLIF(m.note, ''), 'STOK GİRİŞİ') AS firma,
            m.quantity AS adet,
            COALESCE(m.movement_date, date(m.created_at)) AS tarih
        FROM stock_movements m
        JOIN toner_types t ON t.id = m.toner_type_id
        WHERE m.direction = 'in'
        ORDER BY tarih ASC, m.id ASC
    `).all();
}

// Toner türleri + toplam giriş/çıkış
function fetchTonerSummary() {
    return db.prepare(`
        SELECT t.id, t.name, t.printer_model,
            COALESCE(SUM(CASE WHEN m.direction='in'  THEN m.quantity END), 0) AS stok_giris,
            COALESCE(SUM(CASE WHEN m.direction='out' THEN m.quantity END), 0) AS stok_cikis
        FROM toner_types t
        LEFT JOIN stock_movements m ON m.toner_type_id = t.id
        GROUP BY t.id
        ORDER BY t.name
    `).all();
}

// ============================================
// SHEET 1 — Toner_Degisim
// ============================================
// A sütunu orijinalde IF(E2="","",C2&D2&E2) formülüyle üretilen gizli anahtar;
// F sütunu aynı anahtarın son iki alımı arasındaki gün farkı ("ilk" = ilk alım).
function buildTonerDegisim(rows) {
    const aoa = [['', 'Tarih', 'Departman', 'Alan Kişi', 'Toner Tipi', 'KaçGünSonraAldı']];
    const lastSerialByKey = new Map();

    for (const r of rows) {
        const serial = toExcelSerial(r.tarih);
        const key = `${r.departman}${r.alan_kisi}${r.toner_tipi}`;
        const prev = lastSerialByKey.get(key);
        const gun = (prev != null && serial != null) ? serial - prev : 'ilk';
        if (serial != null) lastSerialByKey.set(key, serial);

        // Tek harekette birden fazla kartuş varsa her biri ayrı satır
        // (orijinal dosyada her değişim tek satırdır).
        const adet = Math.max(1, Number(r.adet) || 1);
        for (let i = 0; i < adet; i++) {
            aoa.push([key, serial, r.departman, r.alan_kisi, r.toner_tipi, i === 0 ? gun : 0]);
        }
    }

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // Tarih sütunu (B) orijinaldeki gibi gg.aa.yyyy biçiminde gösterilir
    for (let i = 2; i <= aoa.length; i++) {
        const cell = ws[`B${i}`];
        if (cell && typeof cell.v === 'number') { cell.t = 'n'; cell.z = 'dd.mm.yyyy'; }
    }
    ws['!cols'] = [{ wch: 2.6 }, { wch: 11.7 }, { wch: 23.7 }, { wch: 21.3 }, { wch: 19.9 }, { wch: 21 }];
    ws['!autofilter'] = { ref: `B1:F${Math.max(1, aoa.length)}` };
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    return ws;
}

// ============================================
// SHEET 2 — StokDurum
// ============================================
// Orijinaldeki türetilmiş sütunlar:
//   E DEVİR HIZI = (son alım - ilk alım) / toplam alım adedi
//   F Sütun1     = toplam değişim adedi
//   H            = E / F
//   J            = bugün - son alım tarihi (gün)
//   L            = IF(D*E < J; "SİPARİŞ"; "")
function buildStokDurum(summary, degisimRows) {
    const stats = new Map(); // toner adı -> { count, min, max }
    for (const r of degisimRows) {
        const s = toExcelSerial(r.tarih);
        if (s == null) continue;
        const adet = Math.max(1, Number(r.adet) || 1);
        const cur = stats.get(r.toner_tipi) || { count: 0, min: s, max: s };
        cur.count += adet;
        if (s < cur.min) cur.min = s;
        if (s > cur.max) cur.max = s;
        stats.set(r.toner_tipi, cur);
    }

    const today = todaySerial();
    const aoa = [[
        'TONER MODELİ', 'STOK GİRİŞ', 'STOK ÇIKIŞ', 'MEVCUT', 'DEVİR HIZI', 'Sütun1',
        '', '', '', 'SON KULLANIMDAN SONRA GEÇEN GÜN', '', '', 'Miktar'
    ]];

    for (const t of summary) {
        const st = stats.get(t.name);
        const count = st ? st.count : 0;
        const devirHizi = (st && count > 0) ? (st.max - st.min) / count : 0;
        const mevcut = t.stok_giris - t.stok_cikis;
        const gecenGun = st ? today - st.max : '';
        const hOran = count > 0 ? devirHizi / count : 0;
        const siparis = (st && mevcut * devirHizi < (today - st.max)) ? 'SİPARİŞ' : '';

        aoa.push([t.name, t.stok_giris, t.stok_cikis, mevcut, devirHizi, count,
            '', hOran, '', gecenGun, '', siparis, '']);
    }

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [
        { wch: 35.4 }, { wch: 15.6 }, { wch: 15.1 }, { wch: 20.1 }, { wch: 21.6 },
        { wch: 9.1, hidden: true }, { wch: 9.1, hidden: true }, { wch: 9.1, hidden: true },
        { wch: 9.1, hidden: true }, { wch: 24.3 }, { wch: 15.3, hidden: true }, { wch: 9.1 }, { wch: 9.1 }
    ];
    ws['!autofilter'] = { ref: `J1:M${Math.max(1, aoa.length)}` };
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    return ws;
}

// ============================================
// SHEET 3 — StokGirisCikis
// ============================================
function buildStokGirisCikis(girisRows) {
    const aoa = [['TONER MODELİ', 'FİRMA', 'ADET']];
    for (const r of girisRows) aoa.push([r.toner_modeli, r.firma, r.adet]);

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 42.7 }, { wch: 21.4 }, { wch: 10.4 }];
    ws['!autofilter'] = { ref: `A1:C${Math.max(1, aoa.length)}` };
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    return ws;
}

// ============================================
// SHEET 4 — Uyumluluk Tablosu
// ============================================
// Orijinal düzen: 1. satır boş, A2/B2 başlık, 3. satırda marka sütunları,
// 4. satırdan itibaren toner → ilgili marka sütununda yazıcı modelleri.
const BRAND_COLUMNS = ['HP', 'CANON', 'SAMSUNG', 'BROTHER'];

function detectBrandIndex(text) {
    const up = String(text || '').toUpperCase();
    for (let i = 0; i < BRAND_COLUMNS.length; i++) {
        if (up.includes(BRAND_COLUMNS[i])) return i;
    }
    return -1;
}

function buildUyumluluk(summary) {
    const aoa = [
        [],
        ['TONER', 'YAZICI MARKA MODEL'],
        ['', ...BRAND_COLUMNS]
    ];

    for (const t of summary) {
        if (!t.printer_model) continue;
        const row = ['', '', '', '', ''];
        row[0] = t.name;
        // Marka önce yazıcı modelinden, bulunamazsa toner adından çıkarılır
        let bi = detectBrandIndex(t.printer_model);
        if (bi < 0) bi = detectBrandIndex(t.name);
        if (bi < 0) bi = 0; // eşleşme yoksa ilk sütuna yaz
        row[bi + 1] = t.printer_model;
        aoa.push(row);
    }

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 34 }, { wch: 26 }, { wch: 26 }, { wch: 26 }, { wch: 34 }];
    return ws;
}

// ============================================
// SHEET 5 — Sayfa1 (sayım listesi)
// ============================================
function buildSayfa1(summary) {
    const aoa = [['TONER MODELİ', 'Miktar (adet)']];
    for (const t of summary) {
        const mevcut = t.stok_giris - t.stok_cikis;
        aoa.push([t.name, mevcut > 0 ? mevcut : '']);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 35 }, { wch: 14 }];
    ws['!autofilter'] = { ref: `A1:B${Math.max(1, aoa.length)}` };
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    return ws;
}

// ============================================
// ANA ÜRETİCİ
// ============================================
function buildWorkbook() {
    const degisimRows = fetchDegisimRows();
    const girisRows = fetchGirisRows();
    const summary = fetchTonerSummary();

    const wb = XLSX.utils.book_new();
    // Sheet sırası orijinal dosyayla birebir aynı
    XLSX.utils.book_append_sheet(wb, buildTonerDegisim(degisimRows), 'Toner_Degisim');
    XLSX.utils.book_append_sheet(wb, buildStokDurum(summary, degisimRows), 'StokDurum');
    XLSX.utils.book_append_sheet(wb, buildStokGirisCikis(girisRows), 'StokGirisCikis');
    XLSX.utils.book_append_sheet(wb, buildUyumluluk(summary), 'Uyumluluk Tablosu');
    XLSX.utils.book_append_sheet(wb, buildSayfa1(summary), 'Sayfa1');

    wb.Props = { Title: 'Toner Takip', Author: 'PrintHub', CreatedDate: new Date() };

    return {
        buffer: XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }),
        stats: {
            degisim: degisimRows.length,
            giris: girisRows.length,
            tonerTypes: summary.length
        }
    };
}

// Toner_Takip_YYYY-MM-DD_HHmm.xlsx
function buildFileName(date = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `Toner_Takip_${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
        + `_${p(date.getHours())}${p(date.getMinutes())}.xlsx`;
}

module.exports = { buildWorkbook, buildFileName, toExcelSerial };
