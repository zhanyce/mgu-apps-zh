'use strict';
/** rules.js - qué texto se dibuja y dónde, según los ajustes; sin E/S salvo leer posicion.json. */
const fs = require('fs');
const { LETTERS, DIGITS } = require('./glyphs');

/** Lo que se escribe en el HUD (y en el centro del cuadro) según los ajustes: 'D3', '3', 'P' o ''. */
function hudText(v, get) {
    if (!v.letter) return '';
    if (v.letter === 'P' || v.letter === 'R' || v.letter === 'N') return get('hudPRN') === 'hide' ? '' : v.letter;
    const d = v.digit >= 1 && v.digit <= 9 ? String(v.digit) : '';
    return get('hudStyle') === 'digit' ? d : v.letter + d;
}

/** Solo números finitos y dentro de su destino. Devuelve null si no vale nada del fichero. */
function readPositionFile(file, base, log) {
    let j;
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') log.warn('posicion.json: ' + e); return null; }
    const out = JSON.parse(JSON.stringify(base));
    const ok = (p) => p && isFinite(p.x) && isFinite(p.y) && p.x >= 0 && p.y >= 0 && p.x < 1920 && p.y < 720 && (p.scale === undefined || (p.scale >= 0.2 && p.scale <= 2));
    ['big', 'small', 'sport'].forEach((l) => {
        const p = j.panel && j.panel[l];
        if (ok(p)) out.panel[l] = { x: Number(p.x), y: Number(p.y), scale: p.scale === undefined ? 1 : Number(p.scale) };
    });
    Object.keys(base.hud).forEach((k) => {
        const a = j.hud && j.hud[k];
        if (Array.isArray(a) && a.length === 2 && a.every((n) => isFinite(n)) && a[0] >= 0 && a[0] <= 800 && a[1] >= 0 && a[1] <= 480) out.hud[k] = [Number(a[0]), Number(a[1])];
    });
    return out;
}

/**
 * Las capas que necesita una salida ('hud', 'centre', 'nextToD'), por papel, con su color:
 *   { base: { colour, chars }, S: { colour, chars }, M: { colour, chars } }.
 * "Distinguir S y M por el color": 'all' (S3 entero en el color de S), 'letter' (solo la S) u 'off' (todo igual).
 * Cada color lleva solo los caracteres que usa, así que cambiar de D a S no sube píxeles. Junto a la D del cuadro
 * solo va el número, al lado de la letra de BMW: un color.
 */
function rolesFor(kind, get, colourOf) {
    const base = colourOf(get(kind === 'hud' ? 'hudColour' : 'clusterColour'), get);
    if (kind === 'nextToD') return { base: { colour: base, chars: DIGITS } };
    const mode = get('modeColours');
    if (mode === 'off') return { base: { colour: base, chars: LETTERS.concat(DIGITS) } };
    const own = mode === 'letter' ? [] : DIGITS;
    return {
        base: { colour: base, chars: ['P', 'R', 'N', 'D'].concat(DIGITS) },
        S: { colour: colourOf(get('sColour'), get), chars: ['S'].concat(own) },
        M: { colour: colourOf(get('mColour'), get), chars: ['M'].concat(own) },
    };
}

/** De qué papel (color) es el carácter ch del texto de una marcha con esa letra. */
function roleOf(letter, ch, mode) {
    if (mode === 'off' || !(letter === 'S' || letter === 'M')) return 'base';
    if (mode === 'letter') return ch === letter ? letter : 'base';
    return letter;
}

module.exports = { hudText, readPositionFile, rolesFor, roleOf };
