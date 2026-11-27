'use strict';
/*
 * Spotify Web API: what is playing right now on the user's own account.
 *
 * Read-only. The only scopes are user-read-currently-playing and
 * user-read-playback-state; nothing here can control playback.
 * Sign-in happens once on a PC (tools/spotify_login.py, Authorization Code
 * with PKCE, no client secret). Its result file is imported from a USB stick
 * and kept in the app's private data directory.
 */
const fs = require('fs');
const path = require('path');

const IMPORT_NAME = 'cluster-lyrics-spotify.json';
const AUTH_FILE = 'spotify-auth.json';
const USB_ROOTS = ['/media', '/run/media', '/mnt/usb', '/media/usb', '/media/usb0', '/mnt/media_rw'];
const CLIENT_ID = /^[0-9a-f]{32}$/i;
const TOKEN = /^[A-Za-z0-9_\-.~+/=]{20,2048}$/;

function form(fields) {
    return Object.keys(fields).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(fields[k])).join('&');
}
function parseJson(text) { try { return JSON.parse(text); } catch (_) { return null; } }
function validImport(v) {
    return !!v && typeof v === 'object' && typeof v.client_id === 'string' && CLIENT_ID.test(v.client_id) &&
        typeof v.refresh_token === 'string' && TOKEN.test(v.refresh_token);
}
/** Look for the import file at most two folders below each mount root. Symlinks are not followed. */
function findImport(roots, depth) {
    const seen = [];
    const walk = (dir, left) => {
        let names;
        try { names = fs.readdirSync(dir); } catch (_) { return null; }
        if (names.indexOf(IMPORT_NAME) >= 0) {
            const file = path.join(dir, IMPORT_NAME);
            try {
                const st = fs.lstatSync(file);
                if (st.isFile() && st.size <= 8192) return file;
            } catch (_) {}
        }
        if (left <= 0) return null;
        for (const name of names.slice(0, 64)) {
            if (name[0] === '.') continue;
            const sub = path.join(dir, name);
            try {
                if (!fs.lstatSync(sub).isDirectory() || seen.indexOf(sub) >= 0) continue;
            } catch (_) { continue; }
            seen.push(sub);
            const hit = walk(sub, left - 1);
            if (hit) return hit;
        }
        return null;
    };
    for (const root of roots) {
        const hit = walk(root, depth === undefined ? 2 : depth);
        if (hit) return hit;
    }
    return null;
}

class Spotify {
    constructor(dataDir, http, log, options) {
        options = options || {};
        this.http = http;
        this.log = log || console;
        this.now = options.now || Date.now;
        this.usbRoots = options.usbRoots || USB_ROOTS;
        this.authFile = path.join(dataDir, AUTH_FILE);
        this.dataDir = dataDir;
        this.auth = null;          // { client_id, refresh_token }
        this.access = null;        // { token, expiresAt }
        this.state = 'signed_out'; // signed_out | ready | reauth
        this.lastError = '';
        this.refreshing = null;
        this._load();
    }
    _load() {
        const v = parseJson((() => { try { return fs.readFileSync(this.authFile, 'utf8'); } catch (_) { return ''; } })());
        if (validImport(v)) { this.auth = { client_id: v.client_id, refresh_token: v.refresh_token }; this.state = 'ready'; }
    }
    _save() {
        const tmp = this.authFile + '.tmp';
        try {
            fs.writeFileSync(tmp, JSON.stringify(this.auth) + '\n', { mode: 0o600 });
            fs.renameSync(tmp, this.authFile);
            return true;
        } catch (e) {
            this.log.warn('spotify: sign-in could not be stored: ' + (e.code || e.message));
            try { fs.unlinkSync(tmp); } catch (_) {}
            return false;
        }
    }
    signedIn() { return !!this.auth && this.state !== 'reauth'; }

    /** Import the sign-in file from a USB stick (or the app's data folder). -> { ok, message } */
    importFromUsb() {
        const file = findImport([this.dataDir].concat(this.usbRoots));
        if (!file) return { ok: false, message: 'No ' + IMPORT_NAME + ' found on a USB stick' };
        let text;
        try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, message: 'File not readable (' + (e.code || 'error') + ')' }; }
        const v = parseJson(text);
        if (!validImport(v)) return { ok: false, message: 'File found but its content is not valid' };
        this.auth = { client_id: v.client_id, refresh_token: v.refresh_token };
        this.access = null; this.state = 'ready'; this.lastError = '';
        const stored = this._save();
        return { ok: true, message: stored ? 'Sign-in imported. Delete the file from the USB stick.' :
            'Sign-in imported for this session only (data folder not writable)' };
    }
    signOut() {
        this.auth = null; this.access = null; this.state = 'signed_out'; this.lastError = '';
        try { fs.unlinkSync(this.authFile); } catch (_) {}
    }

    _refresh() {
        if (this.refreshing) return this.refreshing;
        const auth = this.auth;
        this.refreshing = this.http.request({ method: 'POST', host: 'accounts.spotify.com', path: '/api/token',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: form({ grant_type: 'refresh_token', refresh_token: auth.refresh_token, client_id: auth.client_id }),
        }).then(res => {
            this.refreshing = null;
            const v = parseJson(res.body) || {};
            if (res.status === 200 && typeof v.access_token === 'string') {
                this.access = { token: v.access_token,
                    expiresAt: this.now() + Math.max(60, Number(v.expires_in) || 3600) * 1000 };
                // PKCE refresh tokens rotate: the new one replaces the old one at once.
                if (typeof v.refresh_token === 'string' && TOKEN.test(v.refresh_token) &&
                    v.refresh_token !== auth.refresh_token && this.auth === auth) {
                    this.auth = { client_id: auth.client_id, refresh_token: v.refresh_token };
                    this._save();
                }
                this.state = 'ready';
                return this.access.token;
            }
            if (res.status === 400 || res.status === 401) {
                // invalid_grant / invalid_client: the stored sign-in is no longer accepted.
                this.state = 'reauth'; this.access = null;
                const e = new Error('Spotify sign-in expired (' + (v.error || res.status) + ')');
                e.code = 'REAUTH';
                throw e;
            }
            const e = new Error('Spotify token service HTTP ' + res.status);
            e.code = 'HTTP'; e.status = res.status;
            throw e;
        }, error => { this.refreshing = null; throw error; });
        return this.refreshing;
    }
    _token() {
        if (!this.auth) { const e = new Error('Not signed in'); e.code = 'SIGNED_OUT'; return Promise.reject(e); }
        if (this.state === 'reauth') { const e = new Error('Spotify sign-in expired'); e.code = 'REAUTH'; return Promise.reject(e); }
        if (this.access && this.access.expiresAt - this.now() > 60000) return Promise.resolve(this.access.token);
        return this._refresh();
    }

    /**
     * -> { kind: 'track', id, title, artist, artists, album, durationMs, progressMs, playing, at }
     *  | { kind: 'none', reason }
     * `at` is the local time the position was valid at (middle of the request).
     * Errors carry .code and, for HTTP 429, .retryAfterMs.
     */
    nowPlaying(retried) {
        let sentAt = 0;
        return this._token().then(token => {
            sentAt = this.now();
            return this.http.request({ method: 'GET', host: 'api.spotify.com',
                path: '/v1/me/player/currently-playing?additional_types=track',
                headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
        }).then(res => {
            const receivedAt = this.now();
            if (res.status === 204 || res.status === 202) return { kind: 'none', reason: 'Nothing is playing' };
            if (res.status === 401 && !retried) { this.access = null; return this.nowPlaying(true); }
            if (res.status === 429) {
                const e = new Error('Spotify rate limit');
                e.code = 'RATE_LIMIT';
                e.retryAfterMs = Math.min(600, Math.max(1, Number(res.headers && res.headers['retry-after']) || 5)) * 1000;
                throw e;
            }
            if (res.status === 403) {
                const e = new Error('Spotify refused the request (Premium / app user list?)');
                e.code = 'FORBIDDEN';
                throw e;
            }
            if (res.status !== 200) { const e = new Error('Spotify HTTP ' + res.status); e.code = 'HTTP'; e.status = res.status; throw e; }
            const v = parseJson(res.body);
            const item = v && v.item;
            if (!v || !item || (v.currently_playing_type && v.currently_playing_type !== 'track') ||
                item.type !== 'track' || typeof item.name !== 'string')
                return { kind: 'none', reason: v && v.currently_playing_type === 'episode' ? 'Podcast' :
                    v && v.currently_playing_type === 'ad' ? 'Advertisement' : 'No track' };
            const artists = (Array.isArray(item.artists) ? item.artists : [])
                .map(a => a && a.name).filter(n => typeof n === 'string' && n);
            const durationMs = Number(item.duration_ms) || 0;
            const progressMs = Math.max(0, Math.min(durationMs || Infinity, Number(v.progress_ms) || 0));
            this.lastError = '';
            return { kind: 'track', id: typeof item.id === 'string' && item.id ? item.id : null,
                title: item.name, artists, artist: artists[0] || '', album: (item.album && item.album.name) || '',
                durationMs, progressMs, playing: v.is_playing === true,
                at: Math.round((sentAt + receivedAt) / 2) };
        }).catch(error => { this.lastError = String(error && (error.message || error.code) || error); throw error; });
    }
}

/** Position of a now-playing answer at a later local time. */
function positionAt(track, nowMs) {
    if (!track || track.kind !== 'track') return 0;
    const p = track.playing ? track.progressMs + (nowMs - track.at) : track.progressMs;
    return Math.max(0, track.durationMs ? Math.min(track.durationMs, p) : p);
}

module.exports = { Spotify, positionAt, findImport, validImport, form, IMPORT_NAME, USB_ROOTS };
