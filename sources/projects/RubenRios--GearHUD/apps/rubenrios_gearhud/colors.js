'use strict';
/**
 * colors.js - el color del número, sin E/S.
 *
 * En el HUD lo negro no se ve: el cristal solo refleja la luz de cada píxel, así que un gris es un blanco con menos
 * brillo y un color oscuro apenas se nota. Por eso el color personalizado se elige por tono, saturación y brillo.
 */
const PRESETS = {
    white: '#ffffff',
    softgrey: '#aeb2b8',     // gris suave: blanco frío al 70 % de brillo
    grey: '#80858c',
    warm: '#ffe6c4',         // blanco cálido, como la iluminación de los mandos
    amber: '#ffa21f',
    orange: '#ff7a1a',
    mred: '#e4282e',
    ice: '#a6dcff',
    mblue: '#5aa9ff',
    green: '#4cd774',
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const hex2 = (n) => ('0' + clamp(Math.round(n), 0, 255).toString(16)).slice(-2);

/** Tono en grados, saturación y brillo en % -> '#rrggbb'. */
function hsvToHex(h, s, v) {
    h = ((Number(h) % 360) + 360) % 360; s = clamp(Number(s) || 0, 0, 100) / 100; v = clamp(Number(v) || 0, 0, 100) / 100;
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return '#' + hex2((r + m) * 255) + hex2((g + m) * 255) + hex2((b + m) * 255);
}

/** '#rrggbb' -> [r, g, b]; cualquier otra cosa, blanco. */
function rgbOf(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return [255, 255, 255];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** El color de una muestra ('white', 'custom'...); get(key) lee los ajustes del color personalizado. */
function colourOf(choice, get) {
    if (choice === 'custom') return hsvToHex(get('customHue'), get('customSat'), get('customBright'));
    return PRESETS[choice] || PRESETS.white;
}

/** Brillo percibido de 0 a 1 (Rec. 709): lo que se verá de luminoso en el HUD. */
function luminance(hex) {
    const [r, g, b] = rgbOf(hex);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Opacidad de la capa: de noche, el ajuste "Brillo de noche" (20-100 %); de día o sin saberlo, entera. */
function opacityOf(night, nightBright) {
    const p = Number(nightBright);
    return night === true && p >= 20 && p < 100 ? p / 100 : 1;
}

module.exports = { PRESETS, hsvToHex, rgbOf, colourOf, luminance, opacityOf };
