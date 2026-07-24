const net = require('net');

/**
 * Ağ Tarayıcı — Belirtilen IP aralığında yazıcı portları açık olan cihazları bulur.
 * Yazıcı portları: 9100 (RAW/JetDirect), 631 (IPP), 515 (LPD)
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
 * Tek bir IP'nin herhangi bir yazıcı portuna sahip olup olmadığını kontrol eder.
 * @param {string} ip
 * @returns {Promise<{ip: string, ports: number[]} | null>}
 */
async function scanHost(ip) {
    // 3 port paralel denenir — seri deneme yerine tek timeout süresi kadar bekler
    const results = await Promise.all(
        PRINTER_PORTS.map(port => checkPort(ip, port).then(open => (open ? port : null)))
    );
    const openPorts = results.filter(p => p !== null);
    if (openPorts.length > 0) {
        return { ip, ports: openPorts };
    }
    return null;
}

/**
 * IP aralığını tarar ve yazıcı portları açık cihazları döndürür.
 * @param {object} options
 * @param {string} options.subnet - Subnet (ör: "192.168.2")
 * @param {number} options.start - Başlangıç IP (ör: 1)
 * @param {number} options.end - Bitiş IP (ör: 254)
 * @param {function} options.onProgress - İlerleme callback (scanned, total, found)
 * @returns {Promise<Array<{ip: string, ports: number[]}>>}
 */
async function scanNetwork({ subnets, start = 1, end = 254, onProgress }) {
    const targets = [];
    for (const subnet of subnets) {
        for (let i = start; i <= end; i++) {
            targets.push(`${subnet}.${i}`);
        }
    }

    const total = targets.length;
    let scanned = 0;
    const found = [];

    // Batch processing — MAX_CONCURRENT adet paralel tarama
    for (let i = 0; i < total; i += MAX_CONCURRENT) {
        const batch = targets.slice(i, i + MAX_CONCURRENT);
        const results = await Promise.all(batch.map(ip => scanHost(ip)));

        for (const result of results) {
            if (result) {
                found.push(result);
            }
        }

        scanned = Math.min(i + MAX_CONCURRENT, total);
        if (onProgress) {
            onProgress(scanned, total, found.length);
        }
    }

    return found;
}

/**
 * Genel CIDR aritmetiği ile /24'lük subnet öneklerini üretir.
 * Örn: 192.168.2.18/22 → ['192.168.0','192.168.1','192.168.2','192.168.3']
 *      10.1.5.7/23     → ['10.1.4','10.1.5']
 *      192.168.2.18/25 → ['192.168.2'] (aynı /24 içinde kalır)
 * /16'dan geniş maskeler tarama patlamasını önlemek için /20'ye (16 subnet) sınırlanır.
 */
const MAX_SUBNETS = 16; // en fazla 16 × /24 = 4096 IP taranır

function getSubnetsForCIDR(baseIp, cidr) {
    const parts = String(baseIp).split('.').map(Number);
    if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) {
        return []; // geçersiz IP
    }
    let maskBits = parseInt(cidr);
    if (isNaN(maskBits) || maskBits < 8 || maskBits > 32) maskBits = 24;

    // /25..32 → tek /24 içinde kalır
    if (maskBits >= 24) {
        return [`${parts[0]}.${parts[1]}.${parts[2]}`];
    }

    // Ağ adresini hesapla (32-bit)
    const ipNum = ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
    const mask = maskBits === 0 ? 0 : (0xFFFFFFFF << (32 - maskBits)) >>> 0;
    const network = (ipNum & mask) >>> 0;

    // Kaç adet /24 içeriyor? (aşırı büyük maskeler sınırlanır)
    let count = Math.pow(2, 24 - maskBits);
    if (count > MAX_SUBNETS) count = MAX_SUBNETS;

    const subnets = [];
    for (let i = 0; i < count; i++) {
        const sub = (network + (i << 8)) >>> 0;
        subnets.push(`${(sub >>> 24) & 0xFF}.${(sub >>> 16) & 0xFF}.${(sub >>> 8) & 0xFF}`);
    }
    return subnets;
}

module.exports = { scanNetwork, getSubnetsForCIDR, checkPort, scanHost };
