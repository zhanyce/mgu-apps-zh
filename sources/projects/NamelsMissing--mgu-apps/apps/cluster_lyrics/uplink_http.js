'use strict';
/*
 * HTTPS for this app through the MGU Store uplink ("mguInternet": true).
 *
 * The head unit's own resolver points at 127.0.0.1 and does not resolve public
 * names, so each host is resolved against the DNS servers of this app's own
 * uplink lease (same approach as MGU Video Hub's uplink.js). Only the three
 * hosts this app needs can be reached, only on port 443, only at public IPv4
 * addresses, and TLS certificates are always verified against the host name.
 */
const dns = require('dns');
const fs = require('fs');
const https = require('https');
const net = require('net');
const path = require('path');

const SYSTEM_LEASE = '/run/mgu-uplink/lease.json';
const HOSTS = ['accounts.spotify.com', 'api.spotify.com', 'lrclib.net'];
const TIMEOUT_MS = 9000;
const MAX_BODY = 512 * 1024;
const DNS_TTL_MS = 5 * 60 * 1000;

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}
function validDns(lease) {
    return lease && Array.isArray(lease.dns) ?
        lease.dns.filter(ip => typeof ip === 'string' && net.isIP(ip) !== 0).slice(0, 4) : [];
}
function publicIpv4(ip) {
    if (net.isIP(ip) !== 4) return false;
    const n = ip.split('.').map(Number), a = n[0], b = n[1], c = n[2];
    // Vehicle, LAN, carrier NAT, link-local, multicast and documentation ranges
    // are refused even if an allowed name gets a forged private DNS answer.
    if (a === 0 || a === 10 || a === 127 || a >= 224 || a < 3) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    if (a === 160 && (b === 46 || b === 48 || b === 50)) return false; // BMW in-vehicle VLAN routes
    return true;
}
function fail(code, message) { const e = new Error(message); e.code = code; return e; }

function defaultResolve4(host, servers, done) {
    const resolver = new dns.Resolver();
    resolver.setServers(servers);
    resolver.resolve4(host, (error, list) => done(error, list && list[0]));
}
/* One request, never through a shared agent: the socket goes to the resolved
 * address while SNI and the certificate check use the real host name. */
function defaultTransport(o, done) {
    let settled = false, size = 0;
    const chunks = [];
    const finish = (error, result) => { if (!settled) { settled = true; done(error, result); } };
    const req = https.request({ host: o.address, port: 443, servername: o.host, agent: false,
        method: o.method, path: o.path, headers: o.headers, rejectUnauthorized: true }, res => {
        res.on('data', part => {
            size += part.length;
            if (size > MAX_BODY) { req.destroy(); return finish(fail('TOO_LARGE', 'Response too large')); }
            chunks.push(part);
        });
        res.on('end', () => finish(null, { status: res.statusCode, headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', e => finish(e));
    });
    req.setTimeout(o.timeoutMs, () => { req.destroy(); finish(fail('TIMEOUT', 'Request timed out')); });
    req.on('error', e => finish(e));
    if (o.body) req.write(o.body);
    req.end();
}

class UplinkHttp {
    constructor(dataDir, log, options) {
        options = options || {};
        this.log = log || console;
        this.appLeasePath = path.join(dataDir, 'uplink.json');
        this.systemLeasePath = options.systemLease || SYSTEM_LEASE;
        this.readLease = options.readLease || readJson;
        this.resolve4 = options.resolve4 || defaultResolve4;
        this.transport = options.transport || defaultTransport;
        this.now = options.now || Date.now;
        this.cache = new Map();   // host -> { address, at }
        this.lastError = '';
        this.lastOkAt = 0;
    }
    ownLease() {
        const lease = this.readLease(this.appLeasePath);
        return lease && typeof lease.ip === 'string' && net.isIP(lease.ip) && validDns(lease).length ? lease : null;
    }
    status() {
        if (this.ownLease()) return 'ROUTED';
        const system = this.readLease(this.systemLeasePath);
        return system && system.ip ? 'Store online - app not routed' : 'Store uplink offline';
    }
    _address(host, lease) {
        const hit = this.cache.get(host);
        if (hit && this.now() - hit.at < DNS_TTL_MS) return Promise.resolve(hit.address);
        return new Promise((resolve, reject) => {
            let done = false;
            const timer = setTimeout(() => { if (!done) { done = true; reject(fail('DNS', 'DNS timeout')); } }, TIMEOUT_MS);
            try {
                this.resolve4(host, validDns(lease), (error, address) => {
                    if (done) return;
                    done = true; clearTimeout(timer);
                    if (error || !publicIpv4(address)) return reject(fail('DNS', 'DNS lookup failed'));
                    this.cache.set(host, { address, at: this.now() });
                    resolve(address);
                });
            } catch (_) { if (!done) { done = true; clearTimeout(timer); reject(fail('DNS', 'DNS lookup failed')); } }
        });
    }
    /** { method, host, path, headers, body, timeoutMs } -> Promise<{ status, headers, body }> */
    request(o) {
        const host = String(o.host || '').toLowerCase();
        if (HOSTS.indexOf(host) < 0) return Promise.reject(fail('HOST_FORBIDDEN', 'Host not allowed'));
        if (typeof o.path !== 'string' || o.path[0] !== '/' || /[\r\n\s]/.test(o.path))
            return Promise.reject(fail('BAD_PATH', 'Invalid path'));
        const lease = this.ownLease();
        if (!lease) return Promise.reject(fail('NO_UPLINK', this.status()));
        const headers = Object.assign({}, o.headers || {}, { Host: host, Connection: 'close' });
        const body = o.body ? Buffer.from(String(o.body), 'utf8') : null;
        if (body) headers['Content-Length'] = body.length;
        return this._address(host, lease).then(address => new Promise((resolve, reject) => {
            this.transport({ address, host, method: o.method || 'GET', path: o.path, headers, body,
                timeoutMs: o.timeoutMs || TIMEOUT_MS }, (error, result) => {
                if (error) {
                    this.cache.delete(host);   // the address may be stale
                    this.lastError = String(error.code || error.message || error);
                    return reject(error);
                }
                this.lastError = ''; this.lastOkAt = this.now();
                resolve(result);
            });
        })).catch(error => { this.lastError = String(error.code || error.message || error); throw error; });
    }
}

module.exports = { UplinkHttp, HOSTS, validDns, publicIpv4, MAX_BODY };
