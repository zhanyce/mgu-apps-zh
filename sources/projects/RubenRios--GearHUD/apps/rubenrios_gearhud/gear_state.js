'use strict';
/**
 * gear_state.js - qué marcha hay, a partir de las señales del coche. Sin E/S, para probarlo en el PC.
 *
 * Reglas que salen del código de idrive7-apps (kit/runtime/car.js, apps/car_vitals, apps/redline):
 *  - Los campos solo llegan al cambiar: a velocidad constante no llega nada durante minutos, así que
 *    "sin eventos" no significa "sin coche". Nunca se oculta nada por antigüedad de la señal.
 *  - Según el coche llega statusGearboxDrive, DataPowerTrain2 o los dos.
 *  - Parado en D el campo de marcha dice N_OR_P (no hay marcha engranada): solo hay letra.
 *  - Un coche cuyo catálogo no tiene VehicleInformation (la instalación la quita) no da marcha ni letra:
 *    la marcha se estima con rpm / velocidad (Guess, como GearGuess de kit/runtime/car.js) y solo se
 *    enseña mientras hay estimación, con la letra D (o S / M si llega el programa del cambio).
 */
const GEARS = { G1: 1, G2: 2, G3: 3, G4: 4, G5: 5, G6: 6, G7: 7, G8: 8, G9: 9, G10: 10, R: -1, N_OR_P: 0 };
const STAGES = { P: 'P', R: 'R', N: 'N', D: 'D', 1: 'P', 2: 'R', 3: 'N', 4: 'D' };
const PROGRAMS = { S_MINUS_PROGRAMM: 'S', M_MINUS_PROGRAMM: 'M', 1: 'S', 2: 'M' };
// VehicleCondition.statusConditionVehicle: 10 = FAHREN (listo, también con el motor parado en un híbrido)
const CONDITIONS = { PARKEN_BN_NIO: 1, PARKEN_BN_IO: 2, STANDFUNKTIONEN_KUNDE_NICHT_IM_FZG: 3, WOHNEN: 5,
    PRUEFEN_ANALYSE_DIAGNOSE: 7, FAHRBEREITSCHAFT_HERSTELLEN: 8, FAHREN: 10, FAHRBEREITSCHAFT_BEENDEN: 12 };
const FAHREN = 10;
const INVALID_MODE = [0, 61, 62, 63];

/** Nombres o números de cable: G1 = 3 ... G10 = 12, R = 1, N_OR_P = 2. */
function gearOf(x) {
    if (typeof x !== 'number') return GEARS[x];
    if (x >= 3 && x <= 12) return x - 2;
    return x === 1 ? -1 : x === 2 ? 0 : undefined;
}

/** DataPowerTrain2: N = 1, R = 2, P = 3, NP = 4, _1 = 5 ... _9 = 13. */
function selectionOf(x) {
    const n = typeof x === 'number' ? x
        : ({ N: 1, R: 2, P: 3, NP: 4 })[x] || (/^_\d$/.test(String(x)) ? 4 + Number(String(x).slice(1)) : undefined);
    if (n === 1) return { stage: 'N', gear: 0 };
    if (n === 2) return { stage: 'R', gear: -1 };
    if (n === 3) return { stage: 'P', gear: 0 };
    if (n === 4) return { stage: undefined, gear: 0 };
    if (n >= 5 && n <= 13) return { stage: 'D', gear: n - 4 };
    return undefined;
}

/** Modo: 'sport' o 'normal' (Hybrid, Electric, Comfort...); undefined si el valor no vale (se conserva el anterior). */
function layoutOf(x) {
    if (typeof x === 'number') {
        if (INVALID_MODE.indexOf(x) >= 0) return undefined;
        return x >= 1 && x <= 3 ? 'sport' : 'normal';
    }
    if (x === undefined || x === null) return undefined;
    return /^SPORT/i.test(String(x)) ? 'sport' : 'normal';
}

/** Estado del coche: número 1-12, o null si llegó un valor que no se conoce (15 = sin valor). */
function conditionOf(x) {
    const n = typeof x === 'number' ? x : CONDITIONS[x];
    return n >= 1 && n <= 12 ? n : null;
}

/**
 * La marcha aprendida de la relación rpm / velocidad: un grupo por marcha, las marchas son los grupos con
 * bastantes muestras, de la relación más alta (1.ª) a la más baja. Solo con el motor tirando (> 1100 rpm) y en
 * marcha (> 8 km/h): con el motor parado (eléctrico) no hay estimación.
 */
class Guess {
    constructor() { this.cl = []; }
    feed(rpm, kmh) {
        if (!(rpm > 1100 && kmh > 8)) return null;
        const k = rpm / kmh;
        let c = this.cl.find((x) => Math.abs(x.k - k) / x.k < 0.05);
        if (!c) { if (this.cl.length > 24) this.cl.sort((a, b) => b.n - a.n).pop(); c = { k, n: 0 }; this.cl.push(c); }
        c.n++; c.k += (k - c.k) / Math.min(c.n, 50);
        const gears = this.cl.filter((x) => x.n > 30).sort((a, b) => b.k - a.k);
        const i = gears.findIndex((x) => Math.abs(x.k - k) / x.k < 0.05);
        return i < 0 || i > 9 ? null : i + 1;
    }
}

class GearState {
    /** holdMs: cuánto se conserva la marcha si desaparece un instante durante un cambio. */
    constructor(opts) {
        this.holdMs = (opts && opts.holdMs) || 600;
        this.box = {};           // statusGearboxDrive: { gear, stage }
        this.sel = {};           // DataPowerTrain2: { gear, stage }
        this.boxSeen = false;    // ya dio alguna marcha > 0
        this.selSeen = false;
        this.program = null;     // 'S', 'M' o null
        this.layout = 'normal';
        this.condition = undefined;   // undefined: el coche no lo ha dicho; null: dijo algo que no se conoce
        this.guess = new Guess();
        this.guessed = null;     // última marcha estimada (o null)
        this.last = null;        // última marcha válida
        this.lostAt = null;      // cuándo dejó de haber marcha
        this.disagreements = 0;
    }

    gearbox(v, now) {
        const g = gearOf(v && v.statusActualGearDrive), s = STAGES[v && v.statusActualStageDrive];
        if (g !== undefined) this.box.gear = g;
        if (s !== undefined) this.box.stage = s;
        if (g > 0) this.boxSeen = true;
        this._note(now);
    }

    selection(v, now) {
        const r = selectionOf(v && v.statusGearSelectionDrive);
        if (!r) return;
        this.sel.gear = r.gear;
        this.sel.stage = r.stage;
        if (r.gear > 0) this.selSeen = true;
        this._note(now);
    }

    programme(v) { this.program = PROGRAMS[v && v.displayProgramGearbox] || null; }

    mode(v) {
        const l = layoutOf(v && v.actualValueModeDrivingExperience);
        if (l) this.layout = l;
    }

    vehicleCondition(v) {
        const c = v && v.statusConditionVehicle;
        this.condition = c === undefined ? undefined : conditionOf(c);
    }

    /** rpm y km/h de las señales de alta frecuencia: alimentan la estimación. */
    motion(rpm, kmh, now) {
        this.guessed = rpm === null || kmh === null ? null : this.guess.feed(rpm, kmh);
        if (this._source().name === 'guess') this._note(now);
    }

    /** ¿Se puede mostrar algo? Coche listo (10) o que no dice su estado; nunca al encender (8) ni al apagar (12, <= 5). */
    ready() { return this.condition === undefined || this.condition === FAHREN; }

    _source() {
        if (this.boxSeen) return { name: 'gearbox', gear: this.box.gear, stage: this.box.stage !== undefined ? this.box.stage : this.sel.stage };
        if (this.selSeen) return { name: 'selection', gear: this.sel.gear, stage: this.sel.stage !== undefined ? this.sel.stage : this.box.stage };
        const stage = this.box.stage !== undefined ? this.box.stage : this.sel.stage;
        const gear = this.box.gear !== undefined ? this.box.gear : this.sel.gear;
        if (stage === undefined && gear === undefined) return { name: 'guess', gear: this.guessed || 0, stage: this.guessed ? 'D' : undefined };
        return { name: null, gear, stage };
    }

    _note(now) {
        const s = this._source();
        if (s.gear > 0) { this.last = s.gear; this.lostAt = null; } else if (this.lostAt === null) this.lostAt = now;
        if (this.box.gear > 0 && this.sel.gear > 0 && this.box.gear !== this.sel.gear) this.disagreements++;
    }

    /**
     * { ready, letter, digit, guessed, source, layout, reason }:
     *   letter 'P' 'R' 'N' 'D' 'S' 'M' o null; digit 1-10 o null (parado en D: letra sin número).
     * Cada pantalla decide qué enseña de esto (main.js: hudText, clusterWant).
     */
    view(now, opts) {
        const allowGuess = !opts || opts.guess !== false;
        let s = this._source();
        if (s.name === 'guess' && !allowGuess) s = { name: null, gear: undefined, stage: undefined };
        const out = { ready: this.ready(), letter: null, digit: null, guessed: s.name === 'guess', source: s.name, layout: this.layout, reason: '' };
        const none = (reason) => { out.reason = reason; this.last = null; this.lostAt = null; return out; };
        if (!out.ready) return none(this.condition === null ? 'estado del coche desconocido' : 'coche no listo (estado ' + this.condition + ')');
        if (s.stage === 'P' || s.stage === 'R' || s.stage === 'N') { out.letter = s.stage; return none(s.stage); }
        if (s.gear < 0) { out.letter = 'R'; return none('R'); }
        if (s.stage === undefined && !(s.gear > 0)) return none(s.name === 'guess' ? 'estimando: hace falta circular' : 'sin datos de marcha');
        out.letter = this.program === 'S' ? 'S' : this.program === 'M' ? 'M' : 'D';
        if (s.gear > 0) { out.digit = s.gear; return out; }
        if (this.last && now - this.lostAt < this.holdMs) { out.digit = this.last; out.reason = 'durante el cambio'; return out; }
        this.last = null;
        out.reason = 'parado en ' + out.letter;
        return out;
    }
}

module.exports = { GearState, Guess, gearOf, selectionOf, layoutOf, conditionOf, FAHREN };
