'use strict';
/**
 * glyphs.js - las letras y los números como capas de imagen de cluster-render.
 *
 * Cada carácter (P R N D S M, 1-9) es una capa propia, subida una sola vez y mostrada u ocultada con `visible`:
 * un cambio de marcha no sube píxeles ni gasta el presupuesto de subida del enlace con el cuadro, y cambiar el
 * tamaño o la posición solo mueve las capas. Solo un cambio de color vuelve a subir los píxeles.
 *
 * Píxeles en RGBA con alfa directo: la cobertura de la letra como alfa y el color puro en RGB, sin halo oscuro en
 * el borde. En el HUD lo transparente (y lo negro) no se ve; en el cuadro, con `shadow`, una sombra negra como la de
 * la D de serie separa el número del fondo gris del reloj.
 */
const { rgbOf } = require('./colors');

const LETTERS = ['P', 'R', 'N', 'D', 'S', 'M'];
const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** Desenfoque de caja, ida y vuelta en cada eje. */
function blur(src, w, h, r) {
    if (!(r > 0)) return src;
    const pass = (a, step, lines, len, lineStep) => {
        const out = new Float32Array(a.length);
        for (let l = 0; l < lines; l++) {
            for (let i = 0; i < len; i++) {
                let sum = 0, n = 0;
                for (let k = -r; k <= r; k++) { const j = i + k; if (j >= 0 && j < len) { sum += a[l * lineStep + j * step]; n++; } }
                out[l * lineStep + i * step] = sum / n;
            }
        }
        return out;
    };
    return pass(pass(src, 1, h, w, w), w, w, h, 1);
}

/**
 * Un carácter como imagen. g: { size, cellH, baseline, font, stretch, shadow }. El ancho de la celda es el avance del
 * carácter (más margen para la sombra), así que letras y números se pueden poner uno tras otro sin huecos raros.
 * Devuelve { w, h, adv, px }: adv es el avance en píxeles de la celda (sin el margen).
 */
function glyph(Canvas, ch, colour, g) {
    const font = g.font || 'gear', stretch = g.stretch || 1, pad = g.shadow ? (g.shadow.dx | 0) + (g.shadow.blur | 0) + 2 : 2;
    const probe = new Canvas(8, 8);
    const adv = Math.ceil(probe.textWidth(ch, g.size, { font, literal: true }));
    const w0 = adv + pad * 2, h = g.cellH;
    const cv = new Canvas(w0, h).clear('#000000');
    cv.text(ch, w0 / 2, g.baseline, g.size, '#ffffff', { align: 'center', font, literal: true });
    // estirado horizontal (la D de serie es más ancha que la Ubuntu condensada del kit)
    const w = Math.round(w0 * stretch), n = w * h, cov = new Float32Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const sx = Math.min(w0 - 1, Math.floor(x / stretch));
        cov[y * w + x] = cv.d[(y * w0 + sx) * 4] / 255;
    }
    let sh = null;
    if (g.shadow) {
        const off = new Float32Array(n), dx = g.shadow.dx | 0, dy = g.shadow.dy | 0;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const sx = x - dx, sy = y - dy;
            if (sx >= 0 && sy >= 0 && sx < w && sy < h) off[y * w + x] = cov[sy * w + sx];
        }
        sh = blur(off, w, h, g.shadow.blur | 0);
    }
    const [r, gr, b] = rgbOf(colour), px = Buffer.alloc(n * 4), sa = g.shadow ? g.shadow.alpha : 0;
    for (let i = 0; i < n; i++) {
        const fg = cov[i], s = sh ? sh[i] * sa : 0, a = fg + s * (1 - fg);
        if (a <= 0) continue;
        const k = fg / a;      // lo que no es letra es sombra negra
        px[i * 4] = Math.round(r * k); px[i * 4 + 1] = Math.round(gr * k); px[i * 4 + 2] = Math.round(b * k); px[i * 4 + 3] = Math.round(a * 255);
    }
    return { w, h, adv: Math.round(adv * stretch), pad: Math.round(pad * stretch), px };
}

/**
 * Las capas de un juego de caracteres en un destino ('hud', 'map' o 'panel').
 *   const set = new GlyphSet(cr, Canvas, 'hud', ['D', '3', ...], g, colour, { klass, z, yield })
 *   set.show([{ ch: 'D', x, y, k }, ...])   los demás se ocultan; x, y: esquina de la celda; k: escala
 *   set.colour('#aeb2b8'), set.opacity(0.6), set.hide(), set.drop()
 */
class GlyphSet {
    constructor(cr, Canvas, target, chars, g, colour, opts) {
        this.cr = cr; this.Canvas = Canvas; this.target = target; this.g = g; this.opts = opts || {};
        this.cells = {};            // ch -> { ref, w, h, adv, pad }
        this.shown = {};            // ch -> 'x|y|w|h' de lo que está a la vista
        this.alpha = 1;
        this.col = colour;
        chars.forEach((ch) => {
            const im = glyph(Canvas, ch, colour, g);
            const ref = cr.image(Object.assign({ target, klass: this.opts.klass || 'overlay', z: this.opts.z || 0, x: 0, y: 0, w: im.w, h: im.h,
                iw: im.w, ih: im.h, visible: false, fps: 2, sampling: 'bilinear' }, this.opts.yield === undefined ? {} : { yield: this.opts.yield }));
            if (!ref) return;
            cr.pixels(ref, null, im.px);
            this.cells[ch] = { ref, w: im.w, h: im.h, adv: im.adv, pad: im.pad };
        });
    }

    /** Medidas de un carácter: { w, h, adv, pad } o null. */
    cell(ch) { return this.cells[ch] || null; }

    /** items: [{ ch, x, y, k }]: se muestran esos y se ocultan los demás. Lo que no cambia no se envía. */
    show(items) {
        const want = {};
        (items || []).forEach((it) => {
            const c = this.cells[it.ch];
            if (!c) return;
            want[it.ch] = { x: Math.round(it.x), y: Math.round(it.y), w: Math.max(1, Math.round(c.w * it.k)), h: Math.max(1, Math.round(c.h * it.k)) };
        });
        // primero lo nuevo y luego lo que se va: los cambios van en el mismo tick del servicio
        Object.keys(want).forEach((ch) => {
            const r = want[ch], key = [r.x, r.y, r.w, r.h].join('|');
            if (this.shown[ch] === key) return;
            this.cr.set(this.cells[ch].ref, Object.assign({ visible: true, opacity: this.alpha }, r));
            this.shown[ch] = key;
        });
        Object.keys(this.shown).forEach((ch) => {
            if (want[ch]) return;
            this.cr.set(this.cells[ch].ref, { visible: false });
            delete this.shown[ch];
        });
    }

    hide() { this.show([]); }

    /** Nuevo color: se vuelven a subir los píxeles de cada carácter (las capas y su sitio no cambian). */
    colour(colour) {
        if (colour === this.col) return;
        this.col = colour;
        Object.keys(this.cells).forEach((ch) => this.cr.pixels(this.cells[ch].ref, null, glyph(this.Canvas, ch, colour, this.g).px));
    }

    /** Opacidad de las capas (brillo de noche): sin subir píxeles. */
    opacity(a) {
        if (a === this.alpha) return;
        this.alpha = a;
        Object.keys(this.cells).forEach((ch) => this.cr.set(this.cells[ch].ref, { opacity: a }));
    }

    drop() {
        Object.keys(this.cells).forEach((ch) => this.cr.drop(this.cells[ch].ref));
        this.cells = {}; this.shown = {};
    }
}

/**
 * Dónde va cada carácter de un texto ('D3', '3', 'P'), centrado en (cx, cy) a escala k: [{ ch, x, y, k }].
 * set: un GlyphSet o una función ch -> medidas del carácter (de cualquiera de los juegos de una salida).
 * La separación entre la letra y el número es `gap` (px de la celda, antes de escalar).
 */
function layout(set, text, cx, cy, k, gap) {
    const cellOf = typeof set === 'function' ? set : (ch) => set.cell(ch);
    const chars = String(text || '').split('').filter((ch) => cellOf(ch));
    if (!chars.length) return [];
    const cells = chars.map((ch) => cellOf(ch));
    // ancho visible: los avances más los huecos; cada celda lleva su margen a los lados
    const total = cells.reduce((s, c) => s + c.adv, 0) + (cells.length - 1) * (gap || 0);
    let pen = cx - (total * k) / 2;
    return chars.map((ch, i) => {
        const c = cells[i], it = { ch, x: pen - c.pad * k, y: cy - (c.h * k) / 2, k };
        pen += (c.adv + (gap || 0)) * k;
        return it;
    });
}

module.exports = { GlyphSet, glyph, layout, blur, LETTERS, DIGITS };
