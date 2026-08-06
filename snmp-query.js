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

const SNMP_TIMEOUT = 4000;
const COMMUNITY = 'public'; // Varsayılan SNMP community string

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
function snmpWalk(session, oid) {
    return new Promise((resolve) => {
        const results = [];
        session.subtree(oid, (varbinds) => {
            for (const vb of varbinds) {
                if (!snmp.isVarbindError(vb)) {
                    results.push({ oid: vb.oid, value: vb.value, type: vb.type });
                }
            }
        }, (error) => {
            // Walk tamamlandığında (hata olsa bile toplananları döndür)
            resolve(results);
        });
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

// prtMarkerSuppliesTypeTC (RFC 3805) — tüketilen boya sınıfları.
// 3=toner, 5=ink, 6=inkCartridge, 21=tonerCartridge
const TONER_SUPPLY_TYPES = new Set([3, 5, 6, 21]);
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
async function queryPrinter(ip, snmpOpts = COMMUNITY) {
    // Sürüm görüşmesi aşağıda yapılır; session o zaman atanır.
    let session = null;

    const printerInfo = {
        ip: ip,
        name: '',
        model: '',
        location: '',
        serialNumber: '',
        mac: '',
        status: 'online',
        statusText: 'Çevrim İçi',
        errors: [],          // hrPrinterDetectedErrorState'ten çözülen uyarılar
        firmware: '',
        color: false,
        type: 'laser',
        toner: {},
        paperTrays: [],
        totalPrinted: 0,
        monthlyPrinted: 0,
        queue: [],
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

        printerInfo.model = bufferToString(sysInfo[OID.sysDescr]) || `Yazıcı (${ip})`;
        printerInfo.name = bufferToString(sysInfo[OID.sysName]) || printerInfo.model;
        printerInfo.location = bufferToString(sysInfo[OID.sysLocation]) || 'Bilinmiyor';

        // Model isminden tip tespiti
        const modelLower = printerInfo.model.toLowerCase();
        if (modelLower.includes('inkjet') || modelLower.includes('deskjet') || modelLower.includes('pixma')) {
            printerInfo.type = 'inkjet';
        }

        // 2. Seri Numarası
        try {
            const serial = await snmpGet(session, [OID.prtGeneralSerialNumber]);
            printerInfo.serialNumber = bufferToString(serial[OID.prtGeneralSerialNumber]) || '';
            if (printerInfo.serialNumber) printerInfo.printerMib = true;
        } catch (e) { /* ok */ }

        // 3. Yazıcı Durumu + tespit edilen hata durumu
        try {
            const status = await snmpGet(session, [OID.hrPrinterStatus, OID.hrPrinterDetectedErrorState]);
            const statusCode = status[OID.hrPrinterStatus];

            // Uyarı bitleri: "other(1)" gibi anlamsız kodların ardındaki
            // gerçek sebep burada (kağıt bitti, kapak açık, sıkışma...).
            printerInfo.errors = parsePrinterErrors(status[OID.hrPrinterDetectedErrorState])
                .sort((a, b) => b.agirlik - a.agirlik)
                .map(e => ({ mesaj: e.mesaj, seviye: e.seviye }));

            if (statusCode !== null && statusCode !== undefined) {
                printerInfo.printerMib = true; // hrPrinterStatus yalnız yazıcılarda bulunur
                const code = typeof statusCode === 'number' ? statusCode : parseInt(statusCode);
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

            // Somut bir uyarı varsa rozeti o belirler — "Diğer" yazmaktan
            // çok daha kullanışlı. En ağır uyarı gösterilir, tamamı errors[]'ta.
            if (printerInfo.errors.length > 0) {
                const enAgir = printerInfo.errors[0];
                printerInfo.status = enAgir.seviye;
                printerInfo.statusText = printerInfo.errors.length > 1
                    ? `${enAgir.mesaj} +${printerInfo.errors.length - 1}`
                    : enAgir.mesaj;
            }
        } catch (e) { /* ok */ }

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
                    supplies[index].maxCapacity = typeof r.value === 'number' ? r.value : parseInt(r.value) || 0;
                } else if (column === '9') {
                    // Current level
                    supplies[index].currentLevel = typeof r.value === 'number' ? r.value : parseInt(r.value) || 0;
                } else if (column === '4') {
                    // Supply type (3=toner, 4=ink, etc.)
                    supplies[index].type = typeof r.value === 'number' ? r.value : parseInt(r.value) || 0;
                }
            }

            // prtMarkerSupplies tablosu SADECE toner içermez: atık kutusu,
            // zımba kartuşu, drum gibi kalemler de aynı tabloda gelir ve bazı
            // yazıcılar (ör. bizhub C257i) zımbayı bile "tip 3 = toner" diye
            // bildirir. Bu yüzden hem tipe hem açıklamaya bakılır; renk
            // eşleşmeyenler ancak başka hiçbir toner bulunamadıysa kabul edilir.
            // RFC 3805 negatif kodları: -1 other, -2 unknown,
            // -3 "bir miktar var ama seviye bilinmiyor".
            // HİÇBİRİ "boş" demek değil. Bunları 0 (veya -3 için 10) saymak
            // yanlış "Düşük Toner" alarmı üretiyordu — Canon MF serisi tüm
            // tonerleri için -2 bildiriyor. -1 döndürülür; arayüz onu "?"
            // olarak gösterir ve düşük toner hesabı negatifleri zaten eler.
            const yuzde = (supply) => {
                const current = supply.currentLevel;
                if (typeof current !== 'number' || current < 0) return -1;
                const max = supply.maxCapacity || 100;
                const percent = max > 0
                    ? Math.round((current / max) * 100)
                    : current; // bazı yazıcılar doğrudan yüzde verir
                return Math.max(0, Math.min(100, percent));
            };

            const renkli = [];      // rengi tespit edilenler
            const renksiz = [];     // açıklamasından renk çıkmayanlar

            for (const idx of Object.keys(supplies)) {
                const supply = supplies[idx];
                const type = supply.type;
                if (WASTE_SUPPLY_TYPES.has(type)) continue;              // atık haznesi
                if (type && !TONER_SUPPLY_TYPES.has(type)) continue;     // drum, fuser, kayış...

                const color = detectTonerColor(supply.description);
                if (color) renkli.push({ color, supply });
                else renksiz.push(supply);
            }

            for (const { color, supply } of renkli) {
                printerInfo.toner[color] = yuzde(supply);
                if (color !== 'black') printerInfo.color = true;
            }

            // Tek renkli yazıcılar bazen "Toner Cartridge" gibi renk içermeyen
            // bir açıklama verir; başka toner bulunamadıysa onu siyah sayarız.
            // (Birden fazlaysa hangisi olduğu belirsiz — zımba/drum olabilir.)
            if (renkli.length === 0 && renksiz.length === 1) {
                printerInfo.toner.black = yuzde(renksiz[0]);
            }

            // Hiç toner bilgisi bulunamadıysa varsayılan
            if (Object.keys(printerInfo.toner).length === 0) {
                printerInfo.toner = { black: -1 }; // -1 = bilinmiyor
            }
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
                    trays[index].maxCapacity = typeof r.value === 'number' ? r.value : parseInt(r.value) || 0;
                } else if (column === '10') {
                    // Current level
                    trays[index].currentLevel = typeof r.value === 'number' ? r.value : parseInt(r.value) || 0;
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
                printerInfo.totalPrinted = typeof count === 'number' ? count : parseInt(count) || 0;
            }
        } catch (e) { /* ok */ }

    } catch (e) {
        // Hiçbir sürümde SNMP yanıtı yok — sadece IP ve online durumu göster.
        // NOT: "SNMP kapalı" kesin bir teşhis değildir; community string yanlış
        // olabilir, cihaz v3 zorunlu kılmış ya da 161/UDP engellenmiş olabilir.
        printerInfo.snmpAvailable = false;
        printerInfo.snmpVersion = '';
        printerInfo.name = `Yazıcı (${ip})`;
        printerInfo.model = 'SNMP Yanıt Yok';
        printerInfo.statusText = 'Çevrim İçi (SNMP Kapalı)';
    } finally {
        // Görüşme başarısızsa adaylar döngü içinde kapatıldı, session null olur
        if (session) {
            try { session.close(); } catch (e) { /* zaten kapalı */ }
        }
    }

    // Toner durumuna göre genel durum güncelle
    const tonerValues = Object.values(printerInfo.toner).filter(v => v >= 0);
    const minToner = tonerValues.length > 0 ? Math.min(...tonerValues) : 100;
    if (minToner <= 10 && printerInfo.status === 'online') {
        printerInfo.status = 'warning';
        printerInfo.statusText = 'Düşük Toner';
    }

    return printerInfo;
}

module.exports = { queryPrinter, probeSnmp, createSnmpSession, OID };
