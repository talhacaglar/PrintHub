const snmp = require('net-snmp');

/**
 * SNMP Sorgu Modülü — Yazıcılardan SNMP v1/v2c ile detaylı bilgi çeker.
 *
 * Standart Yazıcı MIB OID'leri:
 *   - RFC 3805 (Printer MIB v2)
 *   - RFC 1213 (MIB-II)
 *   - HOST-RESOURCES-MIB
 */

// ============================================
// OID Tanımları
// ============================================
const OID = {
    // Sistem Bilgileri (MIB-II)
    sysDescr:        '1.3.6.1.2.1.1.1.0',
    sysName:         '1.3.6.1.2.1.1.5.0',
    sysLocation:     '1.3.6.1.2.1.1.6.0',
    sysUpTime:       '1.3.6.1.2.1.1.3.0',

    // Arayüz — MAC adresi
    ifPhysAddress:   '1.3.6.1.2.1.2.2.1.6',

    // Yazıcı Durumu (HOST-RESOURCES-MIB)
    hrPrinterStatus: '1.3.6.1.2.1.25.3.5.1.1.1',
    // 1=other, 2=unknown, 3=idle, 4=printing, 5=warmup
    // Asıl sebep burada: hrPrinterStatus çoğu zaman "other(1)" döner ve tek
    // başına hiçbir şey anlatmaz; gerçek durum (kağıt bitti, kapak açık,
    // sıkışma...) bu bit dizisinde bildirilir.
    hrPrinterDetectedErrorState: '1.3.6.1.2.1.25.3.5.1.2.1',

    // Yazıcı Genel (Printer MIB)
    prtGeneralSerialNumber: '1.3.6.1.2.1.43.5.1.1.17.1',

    // Marker (Toner/Mürekkep) Bilgileri
    prtMarkerSuppliesDescription: '1.3.6.1.2.1.43.11.1.1.6.1',  // + index
    prtMarkerSuppliesMaxCapacity: '1.3.6.1.2.1.43.11.1.1.8.1',   // + index
    prtMarkerSuppliesLevel:       '1.3.6.1.2.1.43.11.1.1.9.1',   // + index
    prtMarkerSuppliesType:        '1.3.6.1.2.1.43.11.1.1.4.1',   // + index

    // Marker Colorant
    prtMarkerColorantValue: '1.3.6.1.2.1.43.12.1.1.4.1',  // + index

    // Input (Kağıt Tepsileri)
    prtInputDescription:  '1.3.6.1.2.1.43.8.2.1.18.1',  // + index
    prtInputMediaName:    '1.3.6.1.2.1.43.8.2.1.12.1',  // + index
    prtInputMaxCapacity:  '1.3.6.1.2.1.43.8.2.1.9.1',   // + index
    prtInputCurrentLevel: '1.3.6.1.2.1.43.8.2.1.10.1',  // + index

    // Sayfa Sayacı
    prtMarkerLifeCount: '1.3.6.1.2.1.43.10.2.1.4.1.1',

    // Subtree prefixes (for walking)
    markerSuppliesSubtree: '1.3.6.1.2.1.43.11.1.1',
    markerColorantSubtree: '1.3.6.1.2.1.43.12.1.1',
    inputSubtree:          '1.3.6.1.2.1.43.8.2.1',

    // Uyarı Tablosu (Printer MIB) — hrPrinterDetectedErrorState'in tek bitlik
    // serviceRequested bayrağı bir torba bayraktır: çoğu satıcı onu bakım
    // sayacı dolduğunda, muadil kartuş takıldığında, hatta temizlenmiş bir
    // sıkışmadan sonra bile yakar ve elektrik kesilene kadar yanık bırakır.
    // Bu tablo aynı bilgiyi şiddet (prtAlertSeverityLevel), gereken müdahale
    // seviyesi (prtAlertTrainingLevel) ve cihazın kendi metniyle verir.
    alertSubtree:          '1.3.6.1.2.1.43.18.1.1',
};

// Yazıcı durum kodları
const PRINTER_STATUS = {
    1: 'other',
    2: 'unknown',
    3: 'idle',
    4: 'printing',
    5: 'warmup'
};

// hrPrinterDetectedErrorState bit dizisi (RFC 3805 / HOST-RESOURCES-MIB).
// Sıra ÖNEMLİ: bit 0 ilk baytın en anlamlı biti. Ağırlık, aynı anda birden
// çok bit yanarken hangi mesajın gösterileceğini belirler (büyük = öncelikli).
const PRINTER_ERROR_BITS = [
    { ad: 'lowPaper',            mesaj: 'Kağıt Azaldı',        seviye: 'warning', agirlik: 2 },
    { ad: 'noPaper',             mesaj: 'Kağıt Yok',           seviye: 'error',   agirlik: 8 },
    { ad: 'lowToner',            mesaj: 'Toner Azaldı',        seviye: 'warning', agirlik: 3 },
    { ad: 'noToner',             mesaj: 'Toner Bitti',         seviye: 'error',   agirlik: 9 },
    { ad: 'doorOpen',            mesaj: 'Kapak Açık',          seviye: 'error',   agirlik: 7 },
    { ad: 'jammed',              mesaj: 'Kağıt Sıkışması',     seviye: 'error',   agirlik: 10 },
    { ad: 'offline',             mesaj: 'Çevrim Dışı',         seviye: 'error',   agirlik: 11 },
    { ad: 'serviceRequested',    mesaj: 'Servis Gerekiyor',    seviye: 'error',   agirlik: 6 },
    { ad: 'inputTrayMissing',    mesaj: 'Giriş Tepsisi Yok',   seviye: 'error',   agirlik: 5 },
    { ad: 'outputTrayMissing',   mesaj: 'Çıkış Tepsisi Yok',   seviye: 'error',   agirlik: 5 },
    { ad: 'markerSupplyMissing', mesaj: 'Kartuş Takılı Değil', seviye: 'error',   agirlik: 9 },
    { ad: 'outputNearFull',      mesaj: 'Çıkış Neredeyse Dolu', seviye: 'warning', agirlik: 1 },
    { ad: 'outputFull',          mesaj: 'Çıkış Dolu',          seviye: 'error',   agirlik: 6 },
    { ad: 'inputTrayEmpty',      mesaj: 'Kağıt Tepsisi Boş',   seviye: 'warning', agirlik: 4 },
    { ad: 'overduePreventMaint', mesaj: 'Bakım Zamanı Geçti',  seviye: 'warning', agirlik: 1 }
];

/**
 * hrPrinterDetectedErrorState bit dizisini okunur uyarı listesine çevirir.
 * @param {Buffer|string} value
 * @returns {Array<{mesaj: string, seviye: string, agirlik: number}>}
 */
function parsePrinterErrors(value) {
    if (!value) return [];
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'binary');
    const aktif = [];
    for (let i = 0; i < PRINTER_ERROR_BITS.length; i++) {
        const byte = buf[Math.floor(i / 8)];
        if (byte === undefined) break;
        if (byte & (0x80 >> (i % 8))) aktif.push(PRINTER_ERROR_BITS[i]);
    }
    return aktif;
}

// ============================================
// prtAlertTable (RFC 3805 § prtAlertEntry) — 1.3.6.1.2.1.43.18.1.1
// ============================================

// prtAlertSeverityLevel. binaryChangeEvent(5) KALICI BİR DURUM DEĞİL, olup
// bitmiş bir olaydır ("kapak açıldı", "cihaz açıldı") — rozete yansıtılmaz.
const ALERT_SEVERITY = { 1: 'other', 3: 'critical', 4: 'warning', 5: 'binaryChangeEvent' };

// prtAlertTrainingLevel — "gerçekten servis mi istiyor?" sorusunun cevabı
// tam olarak burada. Yalnızca fieldService(5) teknisyen çağırmak demektir;
// untrained(3)/trained(4) kullanıcının kendi gidereceği şeylerdir (kağıt koy,
// kapak kapat, kartuş değiştir). noInterventionRequired(7) salt bilgidir.
const ALERT_TRAINING = {
    1: 'other', 2: 'unknown', 3: 'untrained', 4: 'trained',
    5: 'fieldService', 6: 'management', 7: 'noInterventionRequired'
};

// PrtAlertCodeTC — yaygın kodların okunur karşılıkları. Cihaz kendi
// prtAlertDescription metnini verirse o tercih edilir; bu tablo yalnızca
// açıklama boş geldiğinde (birçok yazıcıda boştur) devreye girer.
const ALERT_CODES = {
    1: 'Diğer', 2: 'Bilinmeyen Durum',
    3: 'Kapak Açık', 4: 'Kapak Kapandı', 5: 'Kilit Açık', 6: 'Kilit Kapandı',
    7: 'Yapılandırma Değişti', 8: 'Kağıt Sıkışması',
    9: 'Birim Takılı Değil', 10: 'Birim Ömrü Bitmek Üzere', 11: 'Birim Ömrü Doldu',
    12: 'Birim Neredeyse Boş', 13: 'Birim Boş',
    14: 'Birim Neredeyse Dolu', 15: 'Birim Dolu',
    22: 'Birim Çevrim Dışı',
    29: 'Giderilebilir Birim Arızası', 30: 'Kalıcı Birim Arızası',
    33: 'Motor Arızası', 34: 'Bellek Doldu',
    35: 'Birim Sıcaklığı Düşük', 36: 'Birim Aşırı Isındı',
    37: 'Zamanlama Arızası', 38: 'Termistör Arızası',
    501: 'Kapak Açık', 502: 'Kapak Kapandı',
    503: 'Cihaz Açıldı', 504: 'Cihaz Kapandı',
    505: 'Uzaktan Sıfırlandı', 506: 'Elle Sıfırlandı', 507: 'Yazdırmaya Hazır',
    801: 'Giriş Tepsisi Yok', 807: 'Kağıt Azaldı', 808: 'Kağıt Bitti',
    809: 'Kağıt Değişimi Bekleniyor', 810: 'Elle Besleme Bekleniyor',
    811: 'Tepsi Konum Hatası', 812: 'Tepsi Yükseltme Hatası',
    813: 'Seçilen Boyut Beslenemiyor',
    901: 'Çıkış Tepsisi Yok', 902: 'Çıkış Neredeyse Dolu', 903: 'Çıkış Dolu',
    1001: 'Fuser Sıcaklığı Düşük', 1002: 'Fuser Aşırı Isındı',
    1003: 'Fuser Zamanlama Arızası', 1004: 'Fuser Termistör Arızası',
    1005: 'Baskı Kalitesi Ayarlanıyor',
    1101: 'Toner Bitti', 1102: 'Mürekkep Bitti', 1103: 'Şerit Bitti',
    1104: 'Toner Azaldı', 1105: 'Mürekkep Azaldı', 1106: 'Şerit Azaldı',
    1107: 'Atık Toner Kutusu Neredeyse Dolu', 1108: 'Atık Mürekkep Kutusu Neredeyse Dolu',
    1109: 'Atık Toner Kutusu Dolu', 1110: 'Atık Mürekkep Kutusu Dolu',
    1111: 'Drum Ömrü Bitmek Üzere', 1112: 'Drum Ömrü Doldu',
    1113: 'Developer Azaldı', 1114: 'Developer Bitti',
    1115: 'Toner Kartuşu Takılı Değil',
    1301: 'Kağıt Yolu Tepsisi Yok', 1303: 'Kağıt Yolu Dolu',
    1304: 'Seçilen Kağıtta Çift Taraflı Basılamıyor'
};

// Tek bir yazıcı yüzlerce geçmiş uyarı biriktirebiliyor (RFC tabloyu güncel
// uyarılara ayırsa da bazı satıcılar günlük gibi kullanıyor). Rozet hesabı
// için tamamını işlemeye gerek yok.
const MAX_ALERTS = 50;

/**
 * prtAlertTable walk sonucunu uyarı nesnelerine çevirir.
 *
 * @param {Array<{oid: string, value: *}>} rows - snmpWalk çıktısı
 * @returns {Array<{mesaj: string, seviye: string, mudahale: string,
 *                  kod: number, olay: boolean, agirlik: number}>}
 */
function parseAlertTable(rows) {
    const girdiler = {};
    for (const r of rows) {
        // OID biçimi: <alertSubtree>.{sutun}.{hrDeviceIndex}.{prtAlertIndex}
        // Satır anahtarı İKİ indeksin birleşimidir: prtAlertEntry
        // {hrDeviceIndex, prtAlertIndex} ile indekslenir. Yalnızca son bileşeni
        // kullanmak, çok fonksiyonlu bir cihazın iki alt-yazıcısındaki aynı
        // numaralı uyarıları (…1.2.1.1 ve …1.2.2.1) tek kovaya düşürüp
        // birbirinin şiddet/kod değerini ezmesine yol açıyordu.
        const parts = String(r.oid).split('.');
        const sutun = parts[parts.length - 3];
        const index = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
        if (!girdiler[index]) girdiler[index] = {};

        const sayi = (v) => (typeof v === 'number' ? v : parseInt(v, 10));
        if (sutun === '2') girdiler[index].severity = sayi(r.value);
        else if (sutun === '3') girdiler[index].training = sayi(r.value);
        else if (sutun === '6') girdiler[index].location = sayi(r.value);
        else if (sutun === '7') girdiler[index].code = sayi(r.value);
        else if (sutun === '8') girdiler[index].description = bufferToString(r.value);
    }

    const uyarilar = [];
    for (const idx of Object.keys(girdiler)) {
        const g = girdiler[idx];
        // Şiddet ya da kod hiç gelmediyse satır kullanılamaz (bazı cihazlar
        // tablonun yalnız index sütununu doldurup gerisini boş bırakıyor).
        if (g.severity === undefined && g.code === undefined) continue;

        const mudahale = ALERT_TRAINING[g.training] || 'unknown';
        // Cihaz "müdahale gerekmiyor" diyorsa uyarı olarak göstermenin anlamı yok.
        if (mudahale === 'noInterventionRequired') continue;

        const siddet = ALERT_SEVERITY[g.severity] || 'warning';
        const olay = siddet === 'binaryChangeEvent';
        const seviye = siddet === 'critical' ? 'error' : 'warning';

        // Cihazın kendi metni her zaman kod tablosundan iyidir — model adı,
        // tepsi numarası, hata kodu gibi ayrıntıyı yalnızca o taşır.
        const mesaj = g.description
            || ALERT_CODES[g.code]
            || (g.code !== undefined ? `Uyarı kodu ${g.code}` : 'Bilinmeyen Uyarı');

        // Sıralama: gerçek servis çağrıları en üstte, geçmiş olaylar en altta.
        let agirlik = seviye === 'error' ? 15 : 5;
        if (mudahale === 'fieldService') agirlik += 10;
        if (olay) agirlik = 0;

        uyarilar.push({
            mesaj, seviye, mudahale,
            kod: g.code === undefined ? null : g.code,
            olay, agirlik
        });
    }

    // Kırpma SIRALAMADAN SONRA yapılır. Eskiden ham anahtar listesi kesiliyordu;
    // JS tam-sayı benzeri anahtarları artan sırada döndürdüğü için index 1-50
    // tutulup üstü atılıyordu. Birçok üretici prtAlertIndex'i döngüsel günlük
    // gibi kullanır, yani atılanlar tam olarak EN YENİ ve en kritik uyarılardı:
    // 60 tane "Cihaz Açıldı" olayının ardından gelen fırın arızası hiç
    // görünmüyordu.
    return uyarilar.sort((a, b) => b.agirlik - a.agirlik).slice(0, MAX_ALERTS);
}

const SNMP_TIMEOUT = 4000;
const COMMUNITY = 'public'; // Varsayılan SNMP community string
// Ayarlarda low_toner_percent tanımlı değilse kullanılan eşik.
const DEFAULT_LOW_TONER_PERCENT = 10;
// Bir subtree walk'ın tümü için üst sınır (tek isteğin timeout'u değil).
const WALK_TIMEOUT = 15000;

/**
 * Tek bir SNMP GET isteği yapar.
 */
function snmpGet(session, oids) {
    return new Promise((resolve, reject) => {
        session.get(oids, (error, varbinds) => {
            if (error) {
                reject(error);
            } else {
                const result = {};
                for (const vb of varbinds) {
                    if (snmp.isVarbindError(vb)) {
                        result[vb.oid] = null;
                    } else {
                        result[vb.oid] = vb.value;
                    }
                }
                resolve(result);
            }
        });
    });
}

/**
 * SNMP subtree walk yapar (tüm alt OID'leri gezer).
 */
function snmpWalk(session, oid, timeoutMs = WALK_TIMEOUT) {
    return new Promise((resolve) => {
        const results = [];
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(guard);
            resolve(results);
        };

        // net-snmp bazı hata yollarında tamamlanma callback'ini hiç çağırmıyor
        // (aynı tuzak probeSnmp'de de var). Guard olmadan takılan tek bir cihaz,
        // server.js'teki 6 eşzamanlı SNMP yuvasından birini süresiz tutuyordu —
        // prtAlertTable bazı cihazlarda yüzlerce satır olduğu için bu walk
        // özellikle uzun sürebiliyor. Süre dolarsa o ana kadar toplananı döndür.
        const guard = setTimeout(done, timeoutMs);

        try {
            session.subtree(oid, (varbinds) => {
                for (const vb of varbinds) {
                    if (!snmp.isVarbindError(vb)) {
                        results.push({ oid: vb.oid, value: vb.value, type: vb.type });
                    }
                }
            }, () => done()); // hata olsa bile toplananları döndür
        } catch (e) {
            done();
        }
    });
}

/**
 * Buffer değerini okunabilir stringe çevirir.
 */
function bufferToString(val) {
    if (val === null || val === undefined) return '';
    if (Buffer.isBuffer(val)) return val.toString('utf8').replace(/\0/g, '').trim();
    return String(val).trim();
}

/**
 * Buffer'ı MAC adresine çevirir.
 */
function bufferToMac(val) {
    if (!Buffer.isBuffer(val) || val.length < 6) return '';
    return Array.from(val.slice(0, 6))
        .map(b => b.toString(16).padStart(2, '0').toUpperCase())
        .join(':');
}

/**
 * Toner açıklamasından rengi belirler.
 * Eşleşme yoksa null döner — eskiden 'black' dönüyordu ve bu, aynı tabloda
 * bildirilen toner DIŞI sarf malzemelerinin (atık kutusu, zımba kartuşu)
 * gerçek siyah toner değerinin üzerine yazmasına yol açıyordu.
 * @returns {'cyan'|'magenta'|'yellow'|'black'|null}
 */
function detectTonerColor(description) {
    const desc = String(description || '').toLowerCase();
    if (desc.includes('cyan') || desc.includes('mavi')) return 'cyan';
    if (desc.includes('magenta') || desc.includes('kirmizi') || desc.includes('kırmızı')) return 'magenta';
    if (desc.includes('yellow') || desc.includes('sari') || desc.includes('sarı')) return 'yellow';
    if (desc.includes('black') || desc.includes('siyah')) return 'black';
    return null;
}

/**
 * sysDescr metninden baskı teknolojisini belirler.
 *
 * RFC 3805'te baskı teknolojisi için sorgulanabilir bir OID yoktur; elimizdeki
 * tek kanıt cihazın kendi tanım metnidir. Bu yüzden yalnızca metin AÇIKÇA
 * söylüyorsa karar veririz. Eşleşme yoksa '' (bilinmiyor) döner ve arayüz
 * teknoloji satırını hiç yazmaz — eskiden 'inkjet' değilse her şey 'laser'
 * sayılıyordu, yani bir Epson EcoTank ya da nokta vuruşlu yazıcı bile
 * kullanıcıya "Lazer" diye gösteriliyordu.
 *
 * @param {string} model - sysDescr metni
 * @returns {'inkjet'|'laser'|''}
 */
function detectPrinterType(model) {
    const m = String(model || '').toLowerCase();
    if (/inkjet|ink[- ]?tank|deskjet|officejet|pixma|ecotank|stylus|maxify|inkbenefit/.test(m)) return 'inkjet';
    if (/laser|lbp\b|imageclass|phaser|colorqube/.test(m)) return 'laser';
    return '';
}

/**
 * prtMarkerSupplies satırından toner doluluk yüzdesini hesaplar.
 *
 * RFC 3805 negatif kodları: currentLevel -1 = other, -2 = unknown,
 * -3 = "bir miktar var ama seviye bilinmiyor"; maxCapacity -1 = other,
 * -2 = unknown. HİÇBİRİ "boş" demek değildir.
 *
 * Yüzde ancak POZİTİF bir kapasite ile hesaplanabilir. Kapasite gelmediğinde
 * 100 varsaymak ya da ham seviyeyi yüzde diye sunmak uydurmadır: kapasitesi
 * bilinmeyen ve 4200 birim bildiren bir kartuş, kırpma sonrası "%100 dolu"
 * görünüyordu. Bilinmiyorsa -1 döner; arayüz "?" gösterir ve düşük toner
 * hesabı negatifleri zaten eler.
 *
 * @param {{currentLevel: *, maxCapacity: *}} supply
 * @returns {number} 0-100 arası yüzde, ya da bilinmiyorsa -1
 */
function tonerPercent(supply) {
    const current = supply && supply.currentLevel;
    const max = supply && supply.maxCapacity;
    if (typeof current !== 'number' || current < 0) return -1;
    if (typeof max !== 'number' || max <= 0) return -1;
    return Math.max(0, Math.min(100, Math.round((current / max) * 100)));
}

// prtMarkerSuppliesTypeTC (RFC 3805) — tüketilen boya sınıfları.
// 3=toner, 5=ink, 6=inkCartridge, 21=tonerCartridge
const TONER_SUPPLY_TYPES = new Set([3, 5, 6, 21]);

/**
 * Açıklamasına göre toner OLMAYAN sarf malzemesi mi?
 *
 * prtMarkerSuppliesType tek başına yeterli değildir: bazı cihazlar tabloya
 * koydukları HER kalemi "tip 3 = toner" diye bildirir. Sahadan ölçülmüş örnek,
 * Samsung SL-M3825ND (192.168.2.222):
 *
 *   [1] type=3  4900/5000   "Black Toner Cartridge"          ← gerçek toner
 *   [2] type=3 30000/30000  "Black Imaging Unit (OPC Unit)"  ← drum
 *   [3] type=3  6309/90000  "Fuser"
 *   [4] type=3 16309/100000 "Transfer Roller"
 *
 * Açıklamada "Black" geçtiği için hem toner hem de drum 'black' rengine
 * eşleşiyor ve döngüde SONRAKİ olan öncekini eziyordu: cihaz arayüzde
 * drum'ın %100'ünü "siyah toner %100" diye gösteriyordu — gerçek toner %98,
 * ve kartuş boşalırken bu fark büyüyerek düşük toner uyarısını tamamen
 * susturuyordu. Konica bizhub'lar da zımba kartuşunu type=3 bildiriyor.
 *
 * Bu yüzden tipe ek olarak açıklama da elenir. Tahmin değil: bu kelimeler
 * geçen bir kalem tanım gereği boya kabı değildir.
 */
const NON_TONER_DESC = /drum|imaging unit|opc|photoconductor|fuser|f[uü]zer|roller|silindir|belt|kay[ıi][şs]|transfer|waste|at[ıi]k|staple|z[ıi]mba|maintenance|bak[ıi]m|developer|geli[şs]tirici|kit\b|cleaner|temizle/i;

// Açıklamada boya kabı olduğunu AÇIKÇA söyleyen kelimeler. Aynı renge birden
// çok kalem eşleştiğinde hangisinin gerçek toner olduğunu seçmek için kullanılır.
const TONER_DESC = /toner|ink|m[uü]rekkep|cartridge|kartu[şs]/i;

/**
 * prtMarkerSupplies tablosundan toner seviyelerini seçer.
 *
 * Tablo SADECE toner içermez: atık kutusu, zımba kartuşu, drum, fuser, silindir
 * gibi kalemler de aynı tabloda gelir — üstelik bazı cihazlar hepsini
 * "tip 3 = toner" diye bildirir (bkz. NON_TONER_DESC). Bu yüzden hem tipe hem
 * açıklamaya bakılır ve aynı renge birden çok kalem düşerse gerçek boya kabı
 * seçilir.
 *
 * @param {Object<string, {description?: string, type?: number,
 *                         currentLevel?: number, maxCapacity?: number}>} supplies
 * @returns {{toner: Object<string, number>, color: boolean|null}}
 *   color: true = renkli, false = siyah-beyaz, null = tabloda toner bulunamadı
 *   (bilinmiyor — arayüz iddiada bulunmaz).
 */
function selectToners(supplies) {
    const renkli = [];      // rengi tespit edilenler
    const renksiz = [];     // açıklamasından renk çıkmayanlar

    // Satırlar tablo indeksine göre sırayla işlenir; üreticiler gerçek boya
    // kabını genelde en küçük indekse koyar.
    const sirali = Object.keys(supplies || {}).sort((a, b) => Number(a) - Number(b));

    for (const idx of sirali) {
        const supply = supplies[idx] || {};
        const type = supply.type;
        if (WASTE_SUPPLY_TYPES.has(type)) continue;              // atık haznesi
        if (type && !TONER_SUPPLY_TYPES.has(type)) continue;     // drum, fuser, kayış...
        // Tip yanlış bildirilmiş olabilir; açıklama daha belirleyicidir.
        if (NON_TONER_DESC.test(supply.description || '')) continue;

        const color = detectTonerColor(supply.description);
        if (color) renkli.push({ color, supply });
        else renksiz.push(supply);
    }

    // Aynı renge birden çok kalem eşleşirse SESSİZCE ÜZERİNE YAZILMAZ.
    // Açıklaması boya kabı olduğunu söyleyen kalem seçilir; eşitlikte en küçük
    // tablo indeksi kazanır. Eskiden döngüdeki SON kalem kazanıyordu ve drum'ın
    // doluluğu toner seviyesi diye raporlanıyordu.
    const enIyi = new Map(); // color -> supply
    for (const { color, supply } of renkli) {
        const mevcut = enIyi.get(color);
        if (!mevcut) { enIyi.set(color, supply); continue; }
        if (TONER_DESC.test(supply.description || '') && !TONER_DESC.test(mevcut.description || '')) {
            enIyi.set(color, supply);
        }
    }

    const toner = {};
    for (const [color, supply] of enIyi) toner[color] = tonerPercent(supply);

    // Tek renkli yazıcılar bazen "Toner Cartridge" gibi renk içermeyen bir
    // açıklama verir; başka toner bulunamadıysa onu siyah sayarız.
    // (Birden fazlaysa hangisi olduğu belirsiz — zımba/drum olabilir.)
    if (renkli.length === 0 && renksiz.length === 1) {
        toner.black = tonerPercent(renksiz[0]);
    }

    // Renkli/siyah-beyaz ancak tabloda gerçekten toner bulunduğunda söylenebilir.
    let color = null;
    if (renkli.some(r => r.color !== 'black')) color = true;
    else if (renkli.length > 0 || renksiz.length === 1) color = false;

    if (Object.keys(toner).length === 0) toner.black = -1; // -1 = bilinmiyor
    return { toner, color };
}
// Atık hazneleri: dolulukları toner seviyesi değildir.
// 4=wasteToner, 8=wasteInk, 14=wasteWax, 24=wasteWater, 26=wastePaper
const WASTE_SUPPLY_TYPES = new Set([4, 8, 14, 24, 26]);

/**
 * SNMP oturumu oluşturur — v2c (community) veya v3 (auth/priv) destekler.
 * @param {string} ip
 * @param {string|object} opts - string ise v2c community;
 *   object ise { version:'3', user, authProtocol:'sha'|'md5'|'none',
 *                authKey, privProtocol:'aes'|'des'|'none', privKey }
 *   veya { version:'2c', community }
 * @param {object} [overrides] - { timeout, retries, snmpVersion } — varsayılanları ezer.
 *   snmpVersion ile v1'e düşülebilir (eski Canon/OKI cihazları yalnızca v1
 *   konuşur ve v2c isteğine hiç cevap vermez). v3 oturumlarında yok sayılır.
 */
function createSnmpSession(ip, opts, overrides) {
    const { snmpVersion, ...rest } = overrides || {};
    const base = { timeout: SNMP_TIMEOUT, retries: 1, ...rest };

    if (opts && typeof opts === 'object' && opts.version === '3') {
        // SNMPv3 — community düz metin gitmez; USM kullanıcı + auth/priv
        const AUTH = { sha: snmp.AuthProtocols.sha, md5: snmp.AuthProtocols.md5 };
        const PRIV = { aes: snmp.PrivProtocols.aes, des: snmp.PrivProtocols.des };
        const user = { name: opts.user || '' };
        const hasAuth = opts.authProtocol && opts.authProtocol !== 'none' && opts.authKey;
        const hasPriv = hasAuth && opts.privProtocol && opts.privProtocol !== 'none' && opts.privKey;
        if (hasPriv) {
            user.level = snmp.SecurityLevel.authPriv;
            user.authProtocol = AUTH[opts.authProtocol] || snmp.AuthProtocols.sha;
            user.authKey = opts.authKey;
            user.privProtocol = PRIV[opts.privProtocol] || snmp.PrivProtocols.aes;
            user.privKey = opts.privKey;
        } else if (hasAuth) {
            user.level = snmp.SecurityLevel.authNoPriv;
            user.authProtocol = AUTH[opts.authProtocol] || snmp.AuthProtocols.sha;
            user.authKey = opts.authKey;
        } else {
            user.level = snmp.SecurityLevel.noAuthNoPriv;
        }
        return snmp.createV3Session(ip, user, base);
    }

    const community = typeof opts === 'string' ? opts : (opts && opts.community) || COMMUNITY;
    // DİKKAT: snmp.Version1 === 0, yani falsy. `snmpVersion || Version2c`
    // yazılırsa v1 sessizce v2c'ye düşer — açıkça undefined kontrolü şart.
    const version = snmpVersion === undefined ? snmp.Version2c : snmpVersion;
    return snmp.createSession(ip, community, { ...base, version });
}

/**
 * Ağ keşfi için hafif SNMP yoklaması — tek sysDescr GET, tekrar denemesiz.
 * 9100/631/515 kapalı ama SNMP açık yazıcıları yakalamak için kullanılır.
 * Asla throw etmez ve her yolda oturumu kapatır (80 eşzamanlı UDP soketi
 * sızdırmamak kritik).
 * @returns {Promise<boolean>} SNMP cevap verdi mi
 */
function probeSnmp(ip, opts, timeout = 800) {
    return new Promise((resolve) => {
        let session;
        try {
            session = createSnmpSession(ip, opts, { timeout, retries: 0 });
        } catch (e) {
            return resolve(false);
        }

        let settled = false;
        const done = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(guard);
            try { session.close(); } catch (e) { /* zaten kapalı */ }
            resolve(result);
        };

        // net-snmp bazı hata yollarında callback'i hiç çağırmıyor — soket sızmasın
        const guard = setTimeout(() => done(false), timeout + 500);

        try {
            session.get([OID.sysDescr], (err, varbinds) => {
                done(!err && Array.isArray(varbinds) && varbinds.length > 0
                    && !snmp.isVarbindError(varbinds[0]));
            });
        } catch (e) {
            done(false);
        }
    });
}

/**
 * Bir yazıcıdan tüm SNMP bilgilerini çeker.
 * @param {string} ip - Yazıcı IP adresi
 * @param {string|object} snmpOpts - v2c community string veya v3 seçenek nesnesi
 * @returns {Promise<object>} Yazıcı bilgileri
 */
async function queryPrinter(ip, snmpOpts = COMMUNITY, opts = {}) {
    // Sürüm görüşmesi aşağıda yapılır; session o zaman atanır.
    let session = null;

    // Düşük toner eşiği tek kaynaktan gelir (Ayarlar → low_toner_percent).
    // Eskiden burada 10, arayüzün bildirim üretiminde 15 sabitti; aynı kavram
    // için iki farklı uydurma sayı vardı.
    const lowTonerPercent = Number.isFinite(opts.lowTonerPercent)
        ? opts.lowTonerPercent
        : DEFAULT_LOW_TONER_PERCENT;

    const printerInfo = {
        ip: ip,
        name: '',
        model: '',
        location: '',
        serialNumber: '',
        mac: '',
        status: 'online',
        statusText: 'Çevrim İçi',
        // Rozete ve "Cihaz Uyarıları" bölümüne kaynaklık eden birleşik liste.
        // Kaynağı prtAlertTable, o yoksa hrPrinterDetectedErrorState bitleri.
        errors: [],
        alertKaynak: '',     // 'alertTable' | 'errorBits' | '' (hiçbiri cevap vermedi)
        // Yalnızca prtAlertTrainingLevel = fieldService(5) bildiren bir uyarı
        // varsa true. Tek bitlik serviceRequested bayrağı bunu KURMAZ.
        needsService: false,
        firmware: '',
        // ÖNEMLİ: color ve type "bilinmiyor" (null / '') ile başlar. Eskiden
        // false/'laser' ile başlıyordu; yani hiç sorgulanmamış ya da supply
        // tablosu okunamamış her cihaz arayüzde kendinden emin biçimde
        // "Lazer • Siyah-Beyaz" görünüyordu. Cihazdan okunmayan özellik
        // uydurulmaz — arayüz boş bırakır.
        color: null,
        type: '',
        toner: {},
        paperTrays: [],
        totalPrinted: 0,
        monthlyPrinted: 0,
        lastSeen: 'Şimdi',
        snmpAvailable: true,
        snmpVersion: '',     // cihazla hangi sürümde anlaşıldı ('2c' | '1' | '3')
        // Printer MIB (1.3.6.1.2.1.43.*) / hrPrinterStatus cevap verdi mi?
        // Yalnızca SNMP ile keşfedilen adayları yazıcı-olmayanlardan (switch,
        // sunucu) ayırmak için kullanılır — bkz. server.js tarama filtresi.
        printerMib: false
    };

    try {
        // 1. Sürüm görüşmesi + temel sistem bilgileri
        //
        // Filo karışık: bazı cihazlar (Canon MF/LBP, OKI OkiLAN) YALNIZCA
        // SNMPv1 konuşur ve v2c isteğine hiç cevap vermez — bunlar eskiden
        // "SNMP kapalı" sanılıp modelsiz/tonersiz kalıyordu. Bu yüzden tek bir
        // global sürüm ayarı yetmez, cihaz başına otomatik seçilir.
        //
        // v3 kasıtlı bir güvenlik tercihidir; community tabanlı v1'e DÜŞÜLMEZ.
        const v3 = snmpOpts && typeof snmpOpts === 'object' && snmpOpts.version === '3';
        const denenecekler = v3
            ? [{ etiket: '3', ver: null }]
            : [{ etiket: '2c', ver: null }, { etiket: '1', ver: snmp.Version1 }];

        let sysInfo = null;
        for (const { etiket, ver } of denenecekler) {
            // ver === null → varsayılan (v2c/v3); aksi halde açıkça geçilir
            const aday = createSnmpSession(ip, snmpOpts, ver === null ? undefined : { snmpVersion: ver });
            try {
                sysInfo = await snmpGet(aday, [OID.sysDescr, OID.sysName, OID.sysLocation]);
                session = aday;
                printerInfo.snmpVersion = etiket;
                break;
            } catch (e) {
                try { aday.close(); } catch (x) { /* zaten kapalı */ }
            }
        }

        // sysDescr MIB-II'de zorunludur; hiçbir sürümde cevap gelmediyse
        // ajan erişilebilir değildir. Kalan sorguları denemek her biri ~8 sn
        // olmak üzere boşuna beklemektir (50 cihazlık yenilemeyi dakikalarca
        // uzatıyordu). Toplam bütçe eskisiyle aynı: iki sorgu kadar.
        if (!sysInfo) {
            throw new Error('SNMP yanıt vermiyor');
        }

        printerInfo.model = bufferToString(sysInfo[OID.sysDescr]) || '';
        printerInfo.name = bufferToString(sysInfo[OID.sysName]) || printerInfo.model || `Yazıcı (${ip})`;
        // Konum uydurulmaz: sysLocation boşsa boş kalır, arayüz "—" gösterir.
        printerInfo.location = bufferToString(sysInfo[OID.sysLocation]) || '';

        // Baskı teknolojisi için ayrı bir OID yok; yalnızca sysDescr metninde
        // AÇIKÇA geçiyorsa belirlenir. Eşleşme yoksa '' (bilinmiyor) kalır —
        // eskiden eşleşmeyen her cihaz 'laser' sayılıyordu.
        printerInfo.type = detectPrinterType(printerInfo.model);

        // 2. Seri Numarası
        try {
            const serial = await snmpGet(session, [OID.prtGeneralSerialNumber]);
            printerInfo.serialNumber = bufferToString(serial[OID.prtGeneralSerialNumber]) || '';
            if (printerInfo.serialNumber) printerInfo.printerMib = true;
        } catch (e) { /* ok */ }

        // 3. Yazıcı Durumu + tespit edilen hata durumu
        let bitErrors = [];
        try {
            const status = await snmpGet(session, [OID.hrPrinterStatus, OID.hrPrinterDetectedErrorState]);
            const statusCode = status[OID.hrPrinterStatus];

            // Uyarı bitleri: "other(1)" gibi anlamsız kodların ardındaki
            // gerçek sebep burada (kağıt bitti, kapak açık, sıkışma...).
            bitErrors = parsePrinterErrors(status[OID.hrPrinterDetectedErrorState])
                .sort((a, b) => b.agirlik - a.agirlik)
                .map(e => ({ mesaj: e.mesaj, seviye: e.seviye, mudahale: 'unknown', kod: null, olay: false }));

            if (statusCode !== null && statusCode !== undefined) {
                printerInfo.printerMib = true; // hrPrinterStatus yalnız yazıcılarda bulunur
                const code = typeof statusCode === 'number' ? statusCode : parseInt(statusCode, 10);
                const statusMap = {
                    3: { status: 'online', text: 'Hazır' },
                    4: { status: 'online', text: 'Yazdırılıyor' },
                    5: { status: 'warning', text: 'Isınıyor' },
                    1: { status: 'online', text: 'Çevrim İçi' },  // other(1) — sebebi varsa aşağıda ezilir
                    2: { status: 'online', text: 'Çevrim İçi' },  // unknown(2)
                };
                const mapped = statusMap[code] || { status: 'online', text: 'Çevrim İçi' };
                printerInfo.status = mapped.status;
                printerInfo.statusText = mapped.text;
            }
        } catch (e) { /* ok */ }

        // 3b. prtAlertTable — bit dizisinden ÇOK daha güvenilir uyarı kaynağı.
        // Cevap veriyorsa bitlerin yerine geçer: aynı olayı şiddet, gereken
        // müdahale seviyesi ve cihazın kendi açıklamasıyla verdiği için tek
        // bitlik serviceRequested'ın ürettiği yanlış "Servis Gerekiyor"
        // rozetleri burada elenir.
        try {
            const alertRows = await snmpWalk(session, OID.alertSubtree);
            // Yalnızca index sütununu doldurup şiddet/kod vermeyen cihazlar var;
            // öyle bir tabloyu "yetkili kaynak" sayıp bitleri elemek yanlış olur.
            const kullanilir = alertRows.some(r => {
                const sutun = String(r.oid).split('.').slice(-3)[0];
                return sutun === '2' || sutun === '7';
            });
            if (kullanilir) {
                printerInfo.printerMib = true;
                const alerts = parseAlertTable(alertRows);
                printerInfo.errors = alerts;
                printerInfo.alertKaynak = 'alertTable';
                printerInfo.needsService = alerts.some(a => a.mudahale === 'fieldService' && !a.olay);
            }
        } catch (e) { /* ok — aşağıda bitlere düşülür */ }

        if (printerInfo.alertKaynak !== 'alertTable') {
            printerInfo.errors = bitErrors;
            if (bitErrors.length > 0) printerInfo.alertKaynak = 'errorBits';
        }

        // Rozet: en ağır KALICI uyarı belirler (geçmiş olaylar rozete girmez).
        // Tamamı errors[]'ta kalır ve modalde listelenir.
        const kalici = printerInfo.errors.filter(e => !e.olay);
        if (kalici.length > 0) {
            const enAgir = kalici[0];
            printerInfo.status = enAgir.seviye;
            printerInfo.statusText = kalici.length > 1
                ? `${enAgir.mesaj} +${kalici.length - 1}`
                : enAgir.mesaj;
        }

        // 4. MAC Adresi — ilk arayüzü dene
        try {
            const macResults = await snmpWalk(session, OID.ifPhysAddress);
            for (const r of macResults) {
                const mac = bufferToMac(r.value);
                if (mac && mac !== '00:00:00:00:00:00') {
                    printerInfo.mac = mac;
                    break;
                }
            }
        } catch (e) { /* ok */ }

        // 5. Toner / Mürekkep Seviyeleri
        try {
            const markerResults = await snmpWalk(session, OID.markerSuppliesSubtree);
            if (markerResults.length > 0) printerInfo.printerMib = true;

            // OID'leri grupla — her marker supply için description, max, level
            const supplies = {};
            for (const r of markerResults) {
                const oidStr = r.oid;
                // OID format: 1.3.6.1.2.1.43.11.1.1.{column}.1.{index}
                const parts = oidStr.split('.');
                const column = parts[parts.length - 3]; // column number
                const index = parts[parts.length - 1];   // supply index

                if (!supplies[index]) supplies[index] = {};

                if (column === '6') {
                    // Description
                    supplies[index].description = bufferToString(r.value);
                } else if (column === '8') {
                    // Max capacity
                    supplies[index].maxCapacity = typeof r.value === 'number' ? r.value : parseInt(r.value, 10) || 0;
                } else if (column === '9') {
                    // Current level
                    supplies[index].currentLevel = typeof r.value === 'number' ? r.value : parseInt(r.value, 10) || 0;
                } else if (column === '4') {
                    // Supply type (3=toner, 4=ink, etc.)
                    supplies[index].type = typeof r.value === 'number' ? r.value : parseInt(r.value, 10) || 0;
                }
            }

            const { toner, color } = selectToners(supplies);
            printerInfo.toner = toner;
            if (color !== null) printerInfo.color = color;
        } catch (e) {
            printerInfo.toner = { black: -1 };
        }

        // 6. Kağıt Tepsileri
        try {
            const inputResults = await snmpWalk(session, OID.inputSubtree);
            if (inputResults.length > 0) printerInfo.printerMib = true;

            const trays = {};
            for (const r of inputResults) {
                const oidStr = r.oid;
                const parts = oidStr.split('.');
                const column = parts[parts.length - 3];
                const index = parts[parts.length - 1];

                if (!trays[index]) trays[index] = {};

                if (column === '18') {
                    // Description
                    trays[index].description = bufferToString(r.value);
                } else if (column === '12') {
                    // Media name (A4, A3, Letter, etc.)
                    trays[index].mediaName = bufferToString(r.value);
                } else if (column === '9') {
                    // Max capacity
                    trays[index].maxCapacity = typeof r.value === 'number' ? r.value : parseInt(r.value, 10) || 0;
                } else if (column === '10') {
                    // Current level
                    trays[index].currentLevel = typeof r.value === 'number' ? r.value : parseInt(r.value, 10) || 0;
                }
            }

            const trayKeys = Object.keys(trays);
            let trayNum = 1;
            for (const idx of trayKeys) {
                const tray = trays[idx];
                const capacity = tray.maxCapacity || 0;
                const current = tray.currentLevel || 0;
                const mediaName = tray.mediaName || tray.description || 'Bilinmiyor';

                // Durum hesapla
                let trayStatus = 'ok';
                if (capacity > 0) {
                    const ratio = current / capacity;
                    if (current <= 0) trayStatus = 'empty';
                    else if (ratio < 0.15) trayStatus = 'low';
                }
                // -3 = bilinmiyor ama kağıt var, -2 = bilinmiyor
                if (current === -3) trayStatus = 'ok';
                if (current === -2) trayStatus = 'ok';

                printerInfo.paperTrays.push({
                    name: `Tepsi ${trayNum}`,
                    size: mediaName,
                    capacity: capacity > 0 ? capacity : '?',
                    current: current >= 0 ? current : '?',
                    status: trayStatus
                });
                trayNum++;
            }
        } catch (e) { /* ok */ }

        // 7. Sayfa Sayacı
        try {
            const counter = await snmpGet(session, [OID.prtMarkerLifeCount]);
            const count = counter[OID.prtMarkerLifeCount];
            if (count !== null && count !== undefined) {
                printerInfo.printerMib = true;
                printerInfo.totalPrinted = typeof count === 'number' ? count : parseInt(count, 10) || 0;
            }
        } catch (e) { /* ok */ }

    } catch (e) {
        // Hiçbir sürümde SNMP yanıtı yok — sadece IP ve online durumu göster.
        // NOT: "SNMP kapalı" kesin bir teşhis değildir; community string yanlış
        // olabilir, cihaz v3 zorunlu kılmış ya da 161/UDP engellenmiş olabilir.
        printerInfo.snmpAvailable = false;
        printerInfo.snmpVersion = '';
        printerInfo.name = `Yazıcı (${ip})`;
        // model alanına 'SNMP Yanıt Yok' yazılmaz: o bir teşhis mesajıdır,
        // envanter verisi değil — ve saveKnownPrinters() ile known_printers.model
        // sütununa kalıcı olarak yazılıyordu. Teşhis snmpAvailable ve
        // statusText alanlarında zaten mevcut.
        printerInfo.model = '';
        printerInfo.statusText = 'Çevrim İçi (SNMP Kapalı)';
    } finally {
        // Görüşme başarısızsa adaylar döngü içinde kapatıldı, session null olur
        if (session) {
            try { session.close(); } catch (e) { /* zaten kapalı */ }
        }
    }

    // Toner durumuna göre genel durum güncelle.
    // Bilinen (negatif olmayan) tek bir seviye bile yoksa hiçbir iddiada
    // bulunulmaz. Eskiden veri yokluğunda minToner=100 varsayılıyordu, yani
    // "hiç veri yok" arayüze "sağlıklı" diye yansıyordu.
    const tonerValues = Object.values(printerInfo.toner).filter(v => v >= 0);
    if (tonerValues.length > 0 && printerInfo.status === 'online'
        && Math.min(...tonerValues) <= lowTonerPercent) {
        printerInfo.status = 'warning';
        printerInfo.statusText = 'Düşük Toner';
    }

    return printerInfo;
}

module.exports = {
    queryPrinter, probeSnmp, createSnmpSession,
    parseAlertTable, parsePrinterErrors,
    tonerPercent, detectPrinterType, detectTonerColor, selectToners,
    DEFAULT_LOW_TONER_PERCENT, OID
};
