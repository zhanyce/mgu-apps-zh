'use strict';
/*
 * Synchronised lyrics from LRCLIB (https://lrclib.net), requested at runtime
 * for the track that is playing. Results are kept in a small private cache so
 * a song is asked for once. Nothing is uploaded except the track's title,
 * artist, album and length.
 */
const fs = require('fs');
const path = require('path');
const lrc = require('./lrc.js');

const HOST = 'lrclib.net';
const CACHE_DIR = 'lyrics-cache';
const CACHE_MAX = 300;
const NEGATIVE_MS = 7 * 24 * 3600 * 1000;
const AGENT = 'ClusterLyrics/0.1.0 (https://github.com/NamelsMissing/mgu-apps)';
const ID = /^[A-Za-z0-9]{8,48}$/;

function parseJson(text) { try { return JSON.parse(text); } catch (_) { return null; } }
function query(fields) {
    return Object.keys(fields).filter(k => fields[k] !== '' && fields[k] != null)
        .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(fields[k])).join('&');
}
/** "Song - 2011 Remaster", "Song (feat. X)", "Song - Radio Edit" -> "Song" */
function plainTitle(title) {
    return String(title)
        .replace(/\s+-\s+.*\b(remaster(ed)?|version|edit|mix|live|mono|stereo|single|deluxe|bonus|acoustic|demo)\b.*$/i, '')
        .replace(/\s*[(\[][^)\]]*\b(feat\.?|ft\.?|with|remaster(ed)?|version|edit|live|bonus)\b[^)\]]*[)\]]/ig, '')
        .trim() || String(title);
}
function result(record) {
    if (!record || typeof record !== 'object') return null;
    if (typeof record.syncedLyrics === 'string' && record.syncedLyrics.trim()) {
        const lines = lrc.parse(record.syncedLyrics);
        if (lines.some(l => l.text)) return { status: 'synced', lines, raw: record.syncedLyrics };
    }
    if (record.instrumental === true) return { status: 'instrumental', lines: [] };
    if (typeof record.plainLyrics === 'string' && record.plainLyrics.trim()) return { status: 'plain', lines: [] };
    return null;
}

class Lyrics {
    constructor(dataDir, http, log, options) {
        options = options || {};
        this.http = http;
        this.log = log || console;
        this.now = options.now || Date.now;
        this.dir = path.join(dataDir, CACHE_DIR);
        this.memory = new Map();    // key -> result
        this.pending = new Map();   // key -> Promise
        this.lastError = '';
    }
    _key(track) { return track.id && ID.test(track.id) ? track.id : null; }
    _file(key) { return path.join(this.dir, key + '.json'); }
    _read(key) {
        if (!key) return null;
        const v = parseJson((() => { try { return fs.readFileSync(this._file(key), 'utf8'); } catch (_) { return ''; } })());
        if (!v || v.v !== 1 || typeof v.status !== 'string') return null;
        if (v.status === 'synced') {
            const lines = lrc.parse(v.raw);
            return lines.length ? { status: 'synced', lines, cached: true } : null;
        }
        // "nothing found" and "only unsynchronised text" are asked again after a week: LRCLIB grows.
        if (v.status !== 'instrumental' && this.now() - (Number(v.at) || 0) > NEGATIVE_MS) return null;
        return { status: v.status, lines: [], cached: true };
    }
    _write(key, res) {
        if (!key) return;
        try {
            if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, 0o700);
            const tmp = this._file(key) + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify({ v: 1, at: this.now(), status: res.status, raw: res.raw || '' }),
                { mode: 0o600 });
            fs.renameSync(tmp, this._file(key));
            this._prune();
        } catch (e) { this.log.warn('lyrics cache: ' + (e.code || e.message)); }
    }
    _prune() {
        let names;
        try { names = fs.readdirSync(this.dir).filter(n => /\.json$/.test(n)); } catch (_) { return; }
        if (names.length <= CACHE_MAX) return;
        names.map(n => {
            let t = 0;
            try { t = fs.statSync(path.join(this.dir, n)).mtimeMs || 0; } catch (_) {}
            return { n, t };
        }).sort((a, b) => a.t - b.t).slice(0, names.length - CACHE_MAX)
            .forEach(e => { try { fs.unlinkSync(path.join(this.dir, e.n)); } catch (_) {} });
    }
    clearCache() {
        this.memory.clear();
        let removed = 0;
        try {
            fs.readdirSync(this.dir).filter(n => /\.json$/.test(n))
                .forEach(n => { try { fs.unlinkSync(path.join(this.dir, n)); removed++; } catch (_) {} });
        } catch (_) {}
        return removed;
    }
    _get(pathname) {
        return this.http.request({ method: 'GET', host: HOST, path: pathname,
            headers: { 'User-Agent': AGENT, Accept: 'application/json' } });
    }
    _fetch(track) {
        const seconds = Math.round((track.durationMs || 0) / 1000);
        const exact = '/api/get?' + query({ track_name: track.title, artist_name: track.artist,
            album_name: track.album, duration: seconds || '' });
        return this._get(exact).then(res => {
            if (res.status === 200) {
                const r = result(parseJson(res.body));
                // A synced text ends the search; anything else may still be beaten by another entry.
                if (r && r.status === 'synced') return r;
                return this._search(track, seconds, r);
            }
            if (res.status === 404 || res.status === 400) return this._search(track, seconds, null);
            const e = new Error('LRCLIB HTTP ' + res.status);
            e.code = 'HTTP'; e.status = res.status;
            throw e;
        });
    }
    _search(track, seconds, fallback) {
        const path2 = '/api/search?' + query({ track_name: plainTitle(track.title), artist_name: track.artist });
        return this._get(path2).then(res => {
            if (res.status !== 200) {
                if (res.status === 404) return fallback || { status: 'none', lines: [] };
                const e = new Error('LRCLIB HTTP ' + res.status);
                e.code = 'HTTP'; e.status = res.status;
                throw e;
            }
            const list = parseJson(res.body);
            let best = null, bestDiff = Infinity;
            (Array.isArray(list) ? list : []).slice(0, 40).forEach(record => {
                const r = result(record);
                if (!r || r.status !== 'synced') return;
                // Another recording of the same song has other timings: the length must match.
                const diff = seconds ? Math.abs((Number(record.duration) || 0) - seconds) : 0;
                if (diff <= 3 && diff < bestDiff) { best = r; bestDiff = diff; }
            });
            return best || fallback || { status: 'none', lines: [] };
        });
    }
    /** -> Promise<{ status: 'synced' | 'plain' | 'instrumental' | 'none', lines }> */
    get(track) {
        const key = this._key(track) || (track.title + '\n' + track.artist + '\n' + track.durationMs);
        if (this.memory.has(key)) return Promise.resolve(this.memory.get(key));
        if (this.pending.has(key)) return this.pending.get(key);
        const cached = this._read(this._key(track));
        if (cached) { this.memory.set(key, cached); return Promise.resolve(cached); }
        const job = this._fetch(track).then(res => {
            this.pending.delete(key);
            this.lastError = '';
            this._write(this._key(track), res);
            const kept = { status: res.status, lines: res.lines };
            this.memory.set(key, kept);
            if (this.memory.size > 40) this.memory.delete(this.memory.keys().next().value);
            return kept;
        }, error => {
            this.pending.delete(key);
            this.lastError = String(error && (error.message || error.code) || error);
            throw error;
        });
        this.pending.set(key, job);
        return job;
    }
}

module.exports = { Lyrics, plainTitle, result, query, HOST, CACHE_MAX };
