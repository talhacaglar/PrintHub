const net = require('net');

/**
 * Ağ Tarayıcı — Belirtilen IP aralığında yazıcı portları açık olan cihazları bulur.
 * Yazıcı portları: 9100 (RAW/JetDirect), 631 (IPP), 515 (LPD)
 */

const PRINTER_PORTS = [9100, 631, 515];
const CONNECT_TIMEOUT = 1500; // ms
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
    const openPorts = [];
    for (const port of PRINTER_PORTS) {
        const isOpen = await checkPort(ip, port);
        if (isOpen) {
            openPorts.push(port);
        }
    }
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
 * /22 subnet için subnet listesini oluşturur.
 * Kullanıcının IP'si 192.168.2.18/22 → 192.168.0.0 - 192.168.3.255
 */
function getSubnetsForCIDR(baseIp, cidr) {
    const parts = baseIp.split('.').map(Number);
    const maskBits = parseInt(cidr);

    if (maskBits === 24) {
        return [`${parts[0]}.${parts[1]}.${parts[2]}`];
    } else if (maskBits === 22) {
        // /22 = 4 subnets
        const baseThird = parts[2] & 0xFC; // Align to /22 boundary
        return [
            `${parts[0]}.${parts[1]}.${baseThird}`,
            `${parts[0]}.${parts[1]}.${baseThird + 1}`,
            `${parts[0]}.${parts[1]}.${baseThird + 2}`,
            `${parts[0]}.${parts[1]}.${baseThird + 3}`
        ];
    } else if (maskBits === 16) {
        // /16 = too many, scan only the user's /24
        return [`${parts[0]}.${parts[1]}.${parts[2]}`];
    }

    // Default: scan user's /24
    return [`${parts[0]}.${parts[1]}.${parts[2]}`];
}

module.exports = { scanNetwork, getSubnetsForCIDR, checkPort, scanHost };
