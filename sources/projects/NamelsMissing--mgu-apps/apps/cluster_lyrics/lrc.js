'use strict';
/*
 * LRC (synchronised lyrics) parsing and timing. Pure functions, no I/O.
 *
 *   [00:17.12] text            one time tag
 *   [00:17.12][01:40.00] text  the same text at two times
 *   [ar:...] [offset:+250]     metadata; only offset is used
 */
const TAG = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
const META = /^\[([a-zA-Z#]+):([^\]]*)\]\s*$/;
const MAX_LINES = 2000;

function clean(text) {
    // Word-level tags <00:17.50> of enhanced LRC are dropped; whitespace is folded.
    return String(text).replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').replace(/\s+/g, ' ').trim();
}

/** -> [{ t: milliseconds, text }] sorted by time; [] when nothing is timed. */
function parse(source) {
    const out = [];
    let offset = 0;
    String(source || '').split(/\r?\n/).forEach(raw => {
        let line = raw.trim();
        if (!line) return;
        const meta = META.exec(line);
        if (meta && !TAG.test(line)) {
            if (meta[1].toLowerCase() === 'offset') {
                const n = parseInt(meta[2], 10);
                if (Number.isFinite(n) && Math.abs(n) <= 30000) offset = n;
            }
            return;
        }
        const times = [];
        let m;
        while ((m = TAG.exec(line))) {
            const frac = m[3] === undefined ? 0 : Number((m[3] + '00').slice(0, 3));
            times.push(Number(m[1]) * 60000 + Number(m[2]) * 1000 + frac);
            line = line.slice(m[0].length);
        }
        if (!times.length) return;
        const text = clean(line);
        times.forEach(t => { if (out.length < MAX_LINES) out.push({ t, text }); });
    });
    // LRC offset: positive values make the lyrics appear earlier.
    if (offset) out.forEach(l => { l.t = Math.max(0, l.t - offset); });
    out.sort((a, b) => a.t - b.t);
    return out;
}

/** Index of the line that is sung at positionMs, or -1 before the first line. */
function indexAt(lines, positionMs) {
    let lo = 0, hi = lines.length - 1, found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lines[mid].t <= positionMs) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
}

/** The next line with text after index, skipping pauses; null at the end. */
function nextText(lines, index) {
    for (let i = index + 1; i < lines.length; i++) if (lines[i].text) return lines[i];
    return null;
}

/**
 * What to show at positionMs: { index, current, next, gap }.
 * current is '' during an instrumental pause (gap true) and before the first line.
 */
function frame(lines, positionMs) {
    const index = indexAt(lines, positionMs);
    const line = index >= 0 ? lines[index] : null;
    const next = nextText(lines, index);
    return { index, current: line ? line.text : '', next: next ? next.text : '', gap: !line || !line.text };
}

/**
 * Greedy word wrap into at most maxLines lines of at most maxWidth.
 * measure(text) -> width. Returns null when it does not fit.
 */
function wrap(text, maxWidth, maxLines, measure) {
    const words = String(text).split(' ').filter(Boolean);
    const lines = [];
    let current = '';
    for (const word of words) {
        const candidate = current ? current + ' ' + word : word;
        if (measure(candidate) <= maxWidth) { current = candidate; continue; }
        if (!current || measure(word) > maxWidth) return null;
        lines.push(current);
        if (lines.length >= maxLines) return null;
        current = word;
    }
    if (current) lines.push(current);
    return lines;
}

/**
 * Largest of sizes at which text fits; the last size is used with an ellipsis
 * when even that is too small. -> { size, lines }
 */
function fit(text, maxWidth, maxLines, sizes, measureAt) {
    for (const size of sizes) {
        const lines = wrap(text, maxWidth, maxLines, s => measureAt(s, size));
        if (lines) return { size, lines };
    }
    const size = sizes[sizes.length - 1];
    let cut = String(text);
    while (cut.length > 1) {
        cut = cut.slice(0, -1).trim();
        const lines = wrap(cut + '…', maxWidth, maxLines, s => measureAt(s, size));
        if (lines) return { size, lines };
    }
    return { size, lines: [] };
}

module.exports = { parse, indexAt, nextText, frame, wrap, fit, clean };
