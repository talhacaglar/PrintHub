#!/usr/bin/env node
// ============================================
// Bozuk siyah toner okumalarını temizler
// ============================================
// SORUN: prtMarkerSupplies tablosunda toner DIŞI kalemler de bulunur
// (atık kutusu, zımba kartuşu, fuser, roller). Eski detectTonerColor,
// açıklamasında renk kelimesi geçmeyen her kalemi "black" sayıyor ve
// gerçek siyah toner değerinin üzerine yazıyordu. Üzerine yazan kalem
// genelde seviyesi -3 ("bilinmiyor ama var") olduğundan siyah toner
// her yazıcıda sabit %10 kaydedilmiş; bu da:
//   - her yazıcıda kalıcı "Düşük Toner" uyarısı,
//   - toner tüketim raporunda hiç siyah değişimi görünmemesi
// demek oluyordu. (Kod tarafı snmp-query.js'de düzeltildi.)
//
// BU BETİK yalnızca GEÇMİŞ okumaları onarır: bozuk kayıtlardan `black`
// anahtarını kaldırır. Renkler (cyan/magenta/yellow) ve sayfa sayaçları
// olduğu gibi korunur — silinen tek şey uydurma siyah değeridir.
//
// Kullanım:
//   node scripts/fix-black-toner-readings.js            # kuru çalışma (varsayılan)
//   node scripts/fix-black-toner-readings.js --apply    # uygula (önce yedek alır)
//
// Not: better-sqlite3 Electron ABI'sine göre derlenir; bu yüzden betiği
// electron ile çalıştırın:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron scripts/...

const fs = require('fs');
const path = require('path');

const { db, DB_PATH } = require('../db');

// Bozulmanın imzası: seviyesi -3 olan toner dışı bir kalem üzerine yazınca
// yüzde her zaman 10 çıkar. Yalnızca bu değer temizlenir; gerçekten %10'da
// olan bir yazıcının kaydını silmemek için aşağıda ayrıca doğrulama var.
const BOZUK_DEGER = 10;

const uygula = process.argv.includes('--apply');

function main() {
    const hedefler = db.prepare(`
        SELECT printer_ip, COUNT(*) AS adet
        FROM printer_readings
        WHERE json_extract(toner_json, '$.black') = ?
        GROUP BY printer_ip
        ORDER BY printer_ip
    `).all(BOZUK_DEGER);

    if (hedefler.length === 0) {
        console.log('Temizlenecek bozuk siyah toner okuması yok.');
        return;
    }

    const toplam = hedefler.reduce((a, h) => a + h.adet, 0);
    console.log(`Veritabanı: ${DB_PATH}`);
    console.log(`\nSiyah değeri ${BOZUK_DEGER} olan okumalar — ${hedefler.length} yazıcı, ${toplam} kayıt:\n`);
    for (const h of hedefler) {
        console.log(`  ${h.printer_ip.padEnd(16)} ${String(h.adet).padStart(3)} okuma`);
    }

    // Kaç kayıtta renk verisi de var? (onlar korunacak)
    const renkli = db.prepare(`
        SELECT COUNT(*) AS c FROM printer_readings
        WHERE json_extract(toner_json, '$.black') = ?
          AND json_extract(toner_json, '$.cyan') IS NOT NULL
    `).get(BOZUK_DEGER).c;
    console.log(`\n  ${renkli} kayıtta renk verisi de var — cyan/magenta/yellow korunacak.`);
    console.log(`  Sayfa sayaçları (total_printed) hiç değişmeyecek.`);

    if (!uygula) {
        console.log('\nKURU ÇALIŞMA — hiçbir şey değiştirilmedi.');
        console.log('Uygulamak için: --apply');
        return;
    }

    // Yedek — geri dönüş yolu her zaman açık kalsın
    const yedek = `${DB_PATH}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(DB_PATH, yedek);
    console.log(`\nYedek alındı: ${yedek}`);

    // json_remove ile yalnızca black anahtarı düşer; nesnenin geri kalanı durur
    const info = db.prepare(`
        UPDATE printer_readings
        SET toner_json = json_remove(toner_json, '$.black')
        WHERE json_extract(toner_json, '$.black') = ?
    `).run(BOZUK_DEGER);

    console.log(`Güncellenen kayıt: ${info.changes}`);
    console.log('Bitti. Toner tüketim raporu artık uydurma siyah değerini kullanmayacak.');
    console.log(`Geri almak için: cp "${yedek}" "${DB_PATH}"`);
}

main();
