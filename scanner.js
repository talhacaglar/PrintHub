const net = require('net');
const { probeSnmp } = require('./snmp-query');

/**
 * Ağ Tarayıcı — Belirtilen IP aralığında yazıcı portları açık olan cihazları bulur.
 * Yazıcı portları: 9100 (RAW/JetDirect), 631 (IPP), 515 (LPD)
 * Ek olarak 161/UDP (SNMP) yoklanır — bu portları firewall'la kapalı ama SNMP
 * açık yazıcılar aksi halde tamamen görünmez kalıyordu. SNMP ile bulunan
 * adaylar server.js'de printerMib filtresinden geçer (switch/sunucu elenir).
 */

const PRINTER_PORTS = [9100, 631, 515];
const CONNECT_TIMEOUT = 800; // ms — LAN için yeterli (eski: 1500)
const MAX_CONCURRENT = 80;

/**
 * Tek bir IP:port kombinasyonunun açık olup olmadığını kontrol eder.
 * @param {string} ip
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function checkPort(ip, port) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let resolved = false;

        const done = (result) => {
            if (!resolved) {
                resolved = true;
                socket.destroy();
                resolve(result);
            }
        };

        socket.setTimeout(CONNECT_TIMEOUT);
        socket.on('connect', () => done(true));
        socket.on('timeout', () => done(false));
        socket.on('error', () => done(false));

        socket.connect(port, ip);
    });
}

/**
 * Tek bir IP'nin yazıcı portlarından birine ya da SNMP'ye cevap verip
 * vermediğini kontrol eder.
 * @param {string} ip
 * @param {string|object} [snmpOpts] - verilirse 161/UDP de yoklanır
 * @returns {Promise<{ip: string, ports: number[], snmpOpen: boolean} | null>}
 */
async function scanHost(ip, snmpOpts) {
    // 3 TCP portu + SNMP probu paralel denenir — seri deneme yerine tek
    // timeout süresi kadar bekler, yani SNMP eklemek tarama süresini uzatmaz
    const [portResults, snmpOpen] = await Promise.all([
        Promise.all(PRINTER_PORTS.map(port => checkPort(ip, port).then(open => (open ? port : null)))),
        snmpOpts ? probeSnmp(ip, snmpOpts, CONNECT_TIMEOUT) : Promise.resolve(false)
    ]);

    const openPorts = portResults.filter(p => p !== null);
    if (openPorts.length > 0 || snmpOpen) {
        return { ip, ports: openPorts, snmpOpen };
    }
    return null;
}

/**
 * IP aralığını tarar ve yazıcı portları açık cihazları döndürür.
 * Hedefler akış halinde üretilir; geniş maskelerde bellek şişmez.
 * @param {object} options
 * @param {string[]} options.subnets - /24 önekleri (ör: ["192.168.2"])
 * @param {number} options.start - Başlangıç IP (ör: 1)
 * @param {number} options.end - Bitiş IP (ör: 254)
 * @param {function} options.onProgress - İlerleme callback (scanned, total, found)
 * @param {function} [options.shouldStop] - true dönerse tarama erken biter
 * @param {string|object} [options.snmpOpts] - verilirse her IP'de 161/UDP de yoklanır
 * @returns {Promise<{found: Array<{ip, ports, snmpOpen}>, summary: object}>}
 *   summary: { subnets, started, withHits, empty, aborted } — "128 subnetin
 *   121'i boş" tarzı teşhis için; kapsam sorununu tek bakışta gösterir.
 */
async function scanNetwork({ subnets, start = 1, end = 254, onProgress, shouldStop, snmpOpts }) {
    // Hedefler diziye toplanmaz — geniş maskelerde (örn. /8, /4) milyonlarca
    // string bellekte tutulamaz. Batch'ler akış halinde üretilir.
    const perSubnet = end - start + 1;
    const total = subnets.length * perSubnet;

    let scanned = 0;
    let started = 0;      // girilen subnet sayısı (iptalde "boş" saymamak için)
    let aborted = false;
    const found = [];
    let batch = [];
    // Yalnızca sonuç veren subnetler tutulur — /8 gibi maskelerde tüm
    // subnetleri Map'e koymak bellek şişirir.
    const hitsBySubnet = new Map();

    const runBatch = async () => {
        const results = await Promise.all(batch.map(ip => scanHost(ip, snmpOpts)));
        for (const result of results) {
            if (!result) continue;
            found.push(result);
            const sub = result.ip.slice(0, result.ip.lastIndexOf('.'));
            hitsBySubnet.set(sub, (hitsBySubnet.get(sub) || 0) + 1);
        }
        scanned += batch.length;
        batch = [];
        if (onProgress) onProgress(scanned, total, found.length);
    };

    outer:
    for (const subnet of subnets) {
        started++;
        for (let i = start; i <= end; i++) {
            batch.push(`${subnet}.${i}`);
            if (batch.length >= MAX_CONCURRENT) {
                await runBatch();
                // Kullanıcı taramayı iptal ettiyse elde olanla dön
                if (shouldStop && shouldStop()) { aborted = true; break outer; }
            }
        }
    }
    if (!aborted && batch.length > 0) await runBatch();

    return {
        found,
        summary: {
            subnets: subnets.length,
            started,
            withHits: hitsBySubnet.size,
            empty: Math.max(0, started - hitsBySubnet.size),
            aborted
        }
    };
}

// Kabul edilen en geniş maske. /4 = 268M IP — tamamlanması günler sürer,
// ama kullanıcı bilinçli olarak seçebilsin diye alt sınır burada.
const MIN_CIDR = 4;

// Tarama patlamasını önleyen üst sınır: en fazla kaç adet /24 taranır.
// 0 = sınırsız. Varsayılan 1048576 (/4 eşdeğeri) — yani seçilen maske
// artık kırpılmaz; sınırı düşürmek isteyen MAX_SCAN_SUBNETS ile daraltır.
const MAX_SUBNETS = parseInt(process.env.MAX_SCAN_SUBNETS || '1048576', 10);

/**
 * Bir dizginin geçerli, noktalı-ondalık IPv4 adresi olup olmadığını söyler.
 * '01.2.3.4' gibi baştan sıfırlı ve '1.2.3.4 ' gibi boşluklu biçimler
 * reddedilir — bunlar bazı çözümleyicilerde farklı adrese denk düşer.
 * @param {string} value
 * @returns {boolean}
 */
function isValidIPv4(value) {
    if (typeof value !== 'string') return false;
    const parts = value.split('.');
    if (parts.length !== 4) return false;
    return parts.every(p => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255);
}

/**
 * Genel CIDR aritmetiği ile /24'lük subnet öneklerini üretir.
 * Örn: 192.168.2.18/22 → ['192.168.0','192.168.1','192.168.2','192.168.3']
 *      10.1.5.7/23     → ['10.1.4','10.1.5']
 *      192.168.2.18/25 → ['192.168.2'] (aynı /24 içinde kalır)
 * Maske /4'e kadar kabul edilir; sonuç MAX_SUBNETS ile sınırlanır
 * (MAX_SCAN_SUBNETS=0 → sınırsız).
 */
function getSubnetsForCIDR(baseIp, cidr) {
    if (!isValidIPv4(String(baseIp).trim())) return []; // geçersiz IP
    const parts = String(baseIp).trim().split('.').map(Number);

    // Bozuk maskeyi sessizce /24'e düşürmeyiz: kullanıcının istemediği bir
    // aralığı taramak, hiç taramamaktan kötüdür. parseScanTargets de (aşağıda)
    // aynı şekilde atlıyor — iki yol artık çelişmiyor.
    const maskBits = parseInt(cidr, 10);
    if (isNaN(maskBits) || maskBits < MIN_CIDR || maskBits > 32) return [];

    // /25..32 → tek /24 içinde kalır
    if (maskBits >= 24) {
        return [`${parts[0]}.${parts[1]}.${parts[2]}`];
    }

    // Ağ adresini hesapla (32-bit, işaretsiz)
    const ipNum = (parts[0] * 16777216) + (parts[1] * 65536) + (parts[2] * 256) + parts[3];
    const mask = (0xFFFFFFFF << (32 - maskBits)) >>> 0;
    const network = (ipNum & mask) >>> 0;

    // Kaç adet /24 içeriyor? (üst sınır uygulanır)
    let count = Math.pow(2, 24 - maskBits);
    if (MAX_SUBNETS > 0 && count > MAX_SUBNETS) count = MAX_SUBNETS;

    const subnets = [];
    for (let i = 0; i < count; i++) {
        // i * 256 — bit kaydırma 2^24'ten sonra taşacağı için çarpma kullanılır
        const sub = network + (i * 256);
        subnets.push(`${Math.floor(sub / 16777216) & 0xFF}.${Math.floor(sub / 65536) & 0xFF}.${Math.floor(sub / 256) & 0xFF}`);
    }
    return subnets;
}

/**
 * Serbest hedef listesini /24 öneklerine açar.
 * Tek taban IP + tek maske yalnızca BİTİŞİK bir blok tarayabildiği için
 * (bkz. getSubnetsForCIDR) dağınık yazıcı VLAN'ları kapsanamıyordu; bu
 * fonksiyon istenen aralıkların birleşimini üretir.
 *
 * Örn: "192.168.2.0/24, 10.1.5.0/24\n172.16.8.0/22"
 *      → ['192.168.2','10.1.5','172.16.8','172.16.9','172.16.10','172.16.11']
 * Maske yazılmazsa /24 varsayılır. Geçersiz parçalar sessizce atlanır;
 * hiçbir geçerli hedef yoksa [] döner (çağıran taramayı başlatmamalı).
 * @param {string} input
 * @returns {string[]} benzersiz /24 önekleri (giriş sırası korunur)
 */
function parseScanTargets(input) {
    const out = [];
    const seen = new Set();

    for (const raw of String(input || '').split(/[,;\n\r]+/)) {
        const target = raw.trim();
        if (!target) continue;

        const slash = target.indexOf('/');
        const ip = slash === -1 ? target : target.slice(0, slash);
        const bits = slash === -1 ? '24' : target.slice(slash + 1).trim();

        // Açık liste olduğu için bozuk maskeyi sessizce /24'e düşürmeyiz —
        // yanlış aralık taramaktansa o satırı atlamak daha güvenli.
        if (!/^\d+$/.test(bits) || +bits < MIN_CIDR || +bits > 32) continue;

        for (const subnet of getSubnetsForCIDR(ip.trim(), bits)) {
            if (!seen.has(subnet)) {
                seen.add(subnet);
                out.push(subnet);
            }
        }
    }
    return out;
}

module.exports = { scanNetwork, getSubnetsForCIDR, parseScanTargets, checkPort, scanHost, isValidIPv4 };
