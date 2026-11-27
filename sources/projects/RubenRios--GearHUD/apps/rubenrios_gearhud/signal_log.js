'use strict';
/** signal_log.js - lo que manda el coche, una línea por valor distinto, con tamaño acotado (flash del coche). */
const fs = require('fs');
const path = require('path');
const MAX_BYTES = 2 * 1024 * 1024;

class SignalLog {
    constructor(dir, onError) {
        this.file = path.join(dir, 'senales.log');
        this.onError = onError || (() => {});
        this.seen = {};
        this.buf = [];
        this.bytes = 0;
        try { this.bytes = fs.statSync(this.file).size; } catch (e) { this.bytes = 0; }
    }

    /** Devuelve true si el valor es distinto del anterior de ese nombre. */
    add(name, value, extra, now) {
        const j = JSON.stringify(value);
        if (this.seen[name] === j) return false;
        this.seen[name] = j;
        this.buf.push(new Date(now || Date.now()).toISOString() + '\t' + name + '\t' + j + (extra ? '\t' + JSON.stringify(extra) : ''));
        return true;
    }

    flush() {
        if (!this.buf.length) return;
        const text = this.buf.join('\n') + '\n';
        this.buf = [];
        if (this.bytes + text.length > MAX_BYTES) {
            try { fs.renameSync(this.file, this.file + '.1'); } catch (e) { /* aún no existe */ }
            this.bytes = 0;
        }
        this.bytes += text.length;
        fs.appendFile(this.file, text, (e) => { if (e) this.onError(e); });
    }
}

module.exports = SignalLog;
