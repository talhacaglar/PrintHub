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
 * Toner renk isminden CSS sınıfını belirler.
 */
function detectTonerColor(description) {
    const desc = description.toLowerCase();
    if (desc.includes('cyan')) return 'cyan';
    if (desc.includes('magenta') || desc.includes('red')) return 'magenta';
    if (desc.includes('yellow')) return 'yellow';
    if (desc.includes('black') || desc.includes('siyah')) return 'black';
    return 'black';
}

/**
 * Bir yazıcıdan tüm SNMP bilgilerini çeker.
 * @param {string} ip - Yazıcı IP adresi
 * @param {string} community - SNMP community string (varsayılan: "public")
 * @returns {Promise<object>} Yazıcı bilgileri
 */
async function queryPrinter(ip, community = COMMUNITY) {
    const session = snmp.createSession(ip, community, {
        timeout: SNMP_TIMEOUT,
        retries: 1,
        version: snmp.Version2c
    });

    const printerInfo = {
        ip: ip,
        name: '',
        model: '',
        location: '',
        serialNumber: '',
        mac: '',
        status: 'online',
        statusText: 'Çevrimiçi',
        firmware: '',
        color: false,
        type: 'laser',
        toner: {},
        paperTrays: [],
        totalPrinted: 0,
        monthlyPrinted: 0,
        queue: [],
        lastSeen: 'Şimdi',
        snmpAvailable: true
    };

    try {
        // 1. Temel sistem bilgileri
        try {
            const sysInfo = await snmpGet(session, [
                OID.sysDescr,
                OID.sysName,
                OID.sysLocation
            ]);

            printerInfo.model = bufferToString(sysInfo[OID.sysDescr]) || `Yazıcı (${ip})`;
            printerInfo.name = bufferToString(sysInfo[OID.sysName]) || printerInfo.model;
            printerInfo.location = bufferToString(sysInfo[OID.sysLocation]) || 'Bilinmiyor';

            // Model isminden tip tespiti
            const modelLower = printerInfo.model.toLowerCase();
            if (modelLower.includes('inkjet') || modelLower.includes('deskjet') || modelLower.includes('pixma')) {
                printerInfo.type = 'inkjet';
            }
        } catch (e) {
            printerInfo.name = `Yazıcı (${ip})`;
            printerInfo.model = 'Bilinmeyen Model';
        }

        // 2. Seri Numarası
        try {
            const serial = await snmpGet(session, [OID.prtGeneralSerialNumber]);
            printerInfo.serialNumber = bufferToString(serial[OID.prtGeneralSerialNumber]) || '';
        } catch (e) { /* ok */ }

        // 3. Yazıcı Durumu
        try {
            const status = await snmpGet(session, [OID.hrPrinterStatus]);
            const statusCode = status[OID.hrPrinterStatus];
            if (statusCode !== null && statusCode !== undefined) {
                const code = typeof statusCode === 'number' ? statusCode : parseInt(statusCode);
                const statusMap = {
                    3: { status: 'online', text: 'Hazır' },
                    4: { status: 'online', text: 'Yazdırılıyor' },
                    5: { status: 'warning', text: 'Isınıyor' },
                    1: { status: 'warning', text: 'Diğer' },
                    2: { status: 'warning', text: 'Bilinmiyor' },
                };
                const mapped = statusMap[code] || { status: 'online', text: 'Çevrimiçi' };
                printerInfo.status = mapped.status;
                printerInfo.statusText = mapped.text;
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

            // Toner bilgilerini yapılandır
            const tonerKeys = Object.keys(supplies);
            for (const idx of tonerKeys) {
                const supply = supplies[idx];
                const desc = supply.description || '';
                const max = supply.maxCapacity || 100;
                const current = supply.currentLevel;

                // -3 = "supply level unknown but some left"
                // -2 = "supply level unknown"
                let percent;
                if (current === -3) {
                    percent = 10; // Az kaldı ama bilinmiyor
                } else if (current === -2 || current < 0) {
                    percent = 0;
                } else if (max > 0) {
                    percent = Math.round((current / max) * 100);
                } else {
                    percent = current; // Bazı yazıcılar doğrudan yüzde verir
                }

                percent = Math.max(0, Math.min(100, percent));

                const color = detectTonerColor(desc);
                printerInfo.toner[color] = percent;

                if (color !== 'black') {
                    printerInfo.color = true;
                }
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
                printerInfo.totalPrinted = typeof count === 'number' ? count : parseInt(count) || 0;
            }
        } catch (e) { /* ok */ }

    } catch (e) {
        // SNMP tamamen başarısız — sadece IP ve online durumu göster
        printerInfo.snmpAvailable = false;
        printerInfo.name = `Yazıcı (${ip})`;
        printerInfo.model = 'SNMP Yanıt Yok';
        printerInfo.statusText = 'Çevrimiçi (SNMP Kapalı)';
    } finally {
        session.close();
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

module.exports = { queryPrinter, OID };
