'use strict';
/**
 * outputs.js - una conexión con cluster-render y lo que se dibuja con ella:
 *   - 'hud': letra y marcha en el HUD (destino hud, 800x480);
 *   - 'centre': letra y marcha en el centro del cuadro (destino map, 1088x480, la zona del mapa);
 *   - 'nextToD': solo el número, junto a la D de serie (destino panel, 1920x720, sobre los relojes).
 *
 * Cada salida tiene un juego de capas por color ("papel": base, S, M; rules.js rolesFor), cada uno con solo los
 * caracteres que usa: cambiar de D a S enseña otras capas ya subidas, sin píxeles.
 *
 * Sin `exclusive` y sin `contend`: si el HMI de serie ocupa un hueco, se le cede. En el HUD, cluster-render se aparta
 * solo cuando BMW enseña sus listas (y sus avisos, si el servicio lo tiene configurado) y vuelve después.
 * La conexión se abre cuando algo se va a dibujar y se cierra cuando no queda nada: sin capas no se pide ningún hueco.
 */
const { GlyphSet } = require('./glyphs');

const SIZE = { hud: [800, 480], map: [1088, 480], panel: [1920, 720] };
const TARGET = { hud: 'hud', centre: 'map', nextToD: 'panel' };

/** Rejilla de calibración a 1/4 de resolución: líneas cada 100 px con su coordenada; en el HUD, el borde de la zona visible. */
function gridPixels(Canvas, w, h, visible) {
    const iw = Math.round(w / 4), ih = Math.round(h / 4), cv = new Canvas(iw, ih).clear([0, 0, 0, 0]);
    const line = (v) => (v % 500 === 0 ? '#ff3030' : '#30ff60');
    for (let x = 0; x <= w; x += 100) cv.fillRect(Math.min(iw - 1, x / 4), 0, 1, ih, line(x));
    for (let y = 0; y <= h; y += 100) cv.fillRect(0, Math.min(ih - 1, y / 4), iw, 1, line(y));
    if (visible) {
        const v = visible, c = '#ffe040';
        cv.fillRect(v.x / 4, v.y / 4, v.w / 4, 1, c); cv.fillRect(v.x / 4, (v.y + v.h) / 4, v.w / 4, 1, c);
        cv.fillRect(v.x / 4, v.y / 4, 1, v.h / 4, c); cv.fillRect((v.x + v.w) / 4, v.y / 4, 1, v.h / 4 + 1, c);
    }
    for (let x = 100; x < w; x += 100) for (let y = 0; y < h; y += 200) cv.text(String(x), x / 4 + 2, y / 4 + 10, 9, '#ffffff', { font: 'bold', literal: true });
    for (let y = 100; y < h; y += 100) for (let x = 0; x < w; x += 400) cv.text(String(y), x / 4 + 2, y / 4 - 2, 9, '#ffe040', { font: 'bold', literal: true });
    return { iw, ih, px: Buffer.from(cv.d.buffer, cv.d.byteOffset, cv.d.length) };
}

class Outputs {
    /** o: { ClusterRender, Canvas, id, socketPath, log, hudGlyph, clusterGlyph, centreGlyph, hudVisible } */
    constructor(o) {
        this.o = o;
        this.log = o.log || { info() {}, warn() {} };
        this.cr = null;
        this.sets = {};          // salida -> { papel -> GlyphSet }
        this.keeper = 0;         // junto a la D: mantiene el hueco en los semáforos, sin dibujar nada
        this.keeping = false;
        this.grids = {};         // destino -> ref
        this.state = { connected: false, targets: {}, refused: '' };
    }

    _connect() {
        if (this.cr) return this.cr;
        const cr = this.cr = new this.o.ClusterRender(this.o.id, this.o.socketPath);
        cr.on('ready', () => { this.state.connected = true; this.log.info('cluster-render: ' + cr.backend + ' ' + cr.targets); });
        cr.on('disconnected', () => { this.state.connected = false; this.state.targets = {}; this.log.warn('cluster-render: desconectado'); });
        cr.on('target', (name, state, holder, reason, guideDisabled, disabled) => {
            const before = this.state.targets[name];
            this.state.targets[name] = { state, holder: holder || '', reason: reason || '', disabled: !!disabled };
            if (!before || before.state !== state || before.disabled !== !!disabled) {
                this.log.info('hueco ' + name + ': ' + state + (holder ? ' (' + holder + ')' : '') + (reason ? ': ' + reason : '') + (disabled ? ' [desactivado por el servicio]' : ''));
            }
        });
        cr.on('refused', (op, ref, reason) => { this.state.refused = op + ': ' + reason; this.log.warn('rechazado ' + op + ' ' + ref + ': ' + reason); });
        cr.connect();
        return cr;
    }

    /** Cierra la conexión y olvida las capas: cluster-render suelta los huecos. */
    close() {
        if (this.cr) this.cr.close();
        this.cr = null; this.sets = {}; this.keeper = 0; this.keeping = false; this.grids = {};
        this.state = { connected: false, targets: {}, refused: '' };
    }

    /**
     * Los juegos de capas de una salida: roles = { papel: { colour, chars } } (rules.js rolesFor). Lo que no cambia no
     * se toca; un color nuevo vuelve a subir los píxeles de ese juego; otros caracteres lo rehacen.
     */
    configure(kind, roles) {
        const cr = this._connect(), have = this.sets[kind] || (this.sets[kind] = {});
        const g = kind === 'hud' ? this.o.hudGlyph : kind === 'centre' ? this.o.centreGlyph : this.o.clusterGlyph;
        Object.keys(have).forEach((role) => { if (!roles[role]) { have[role].drop(); delete have[role]; } });
        Object.keys(roles).forEach((role) => {
            const r = roles[role], key = r.chars.join('');
            if (have[role] && have[role].key === key) { have[role].colour(r.colour); return; }
            if (have[role]) have[role].drop();
            have[role] = new GlyphSet(cr, this.o.Canvas, TARGET[kind], r.chars, g, r.colour, { klass: 'overlay', z: 20 });
            have[role].key = key;
        });
        if (kind === 'nextToD' && !this.keeper) {
            this.keeper = cr.image({ target: 'panel', klass: 'ambient', x: 0, y: 0, w: 1, h: 1, iw: 1, ih: 1, visible: false, prewarm: true, fps: 1 });
        }
    }

    /** Las medidas de un carácter en una salida (de cualquiera de sus juegos), o null. */
    cellOf(kind) {
        const have = this.sets[kind] || {};
        return (ch) => {
            for (const role of Object.keys(have)) { const c = have[role].cell(ch); if (c) return c; }
            return null;
        };
    }

    /** Quita una salida que ya no se usa (ajuste cambiado): sus capas se van y su hueco se suelta. */
    off(kind) {
        const have = this.sets[kind];
        if (have) { Object.keys(have).forEach((role) => have[role].drop()); delete this.sets[kind]; }
        if (kind === 'nextToD' && this.keeper) { this.cr.drop(this.keeper); this.keeper = 0; this.keeping = false; }
        if (this.cr && !Object.keys(this.sets).length && !Object.keys(this.grids).length) this.close();
    }

    /**
     * Lo que se ve en una salida ya configurada: items de glyphs.layout() con su papel (role; sin él, 'base'), vacío
     * para nada. keep (solo junto a la D): conservar el hueco del panel sin número, para que no parpadee en cada parada.
     */
    draw(kind, items, opacity, keep) {
        const have = this.sets[kind] || {};
        Object.keys(have).forEach((role) => {
            have[role].opacity(opacity === undefined ? 1 : opacity);
            have[role].show((items || []).filter((i) => (i.role || 'base') === role));
        });
        if (kind === 'nextToD' && this.keeper && !!keep !== this.keeping) { this.keeping = !!keep; this.cr.set(this.keeper, { visible: this.keeping }); }
    }

    /** Rejilla de calibración en un destino ('hud' o 'panel'). */
    grid(target, on) {
        const ref = this.grids[target];
        if (on && !ref) {
            const cr = this._connect(), size = SIZE[target];
            const g = gridPixels(this.o.Canvas, size[0], size[1], target === 'hud' ? this.o.hudVisible : null);
            this.grids[target] = cr.image({ target, klass: 'overlay', z: 10, x: 0, y: 0, w: size[0], h: size[1], iw: g.iw, ih: g.ih, fps: 1 });
            cr.pixels(this.grids[target], null, g.px);
        } else if (!on && ref) {
            this.cr.drop(ref);
            delete this.grids[target];
        }
    }

    /** Texto corto del estado de un destino para la pantalla. */
    describe(kind) {
        if (!this.sets[kind]) return 'apagado';
        if (!this.state.connected) return 'sin cluster-render';
        const t = this.state.targets[TARGET[kind]];
        if (!t) return 'conectado, esperando';
        if (t.disabled) return 'desactivado por cluster-render';
        return t.state + (t.holder ? ' (' + t.holder + ')' : '') + (t.reason ? ': ' + t.reason : '');
    }
}

module.exports = { Outputs, gridPixels, SIZE, TARGET };
