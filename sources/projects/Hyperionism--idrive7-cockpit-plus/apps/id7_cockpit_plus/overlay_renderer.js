'use strict';
/**
 * overlay_renderer.js - manages ClusterRender layers across:
 *   - hud (800x480 on 0x323):
 *       * hud_road (132, 100, 544x38) : Full-width top-row road name + green highway exit square [14B],
 *         matching stock BMW HUD's full-width top street banner so long road names never clip.
 *       * hud_main (136, 100, 260x100): 3-line configurable upper-left telemetry (y=100..200, strictly above ACC y=202);
 *         automatically shifts into compact Row-2 layout (y=140..198) whenever `hud_road` occupies Row 1,
 *         and overlays cleanly on top of waze-on-cluster's HUD projection.
 *       * hud_nav  (412, 140, 264x232): Right-side vector turn-by-turn & 6-lane guidance
 *         (auto-yielding 0x323 ONLY when BMW HUD switches to an intersection mini-map, or hiding hud_nav over Waze HUD).
 *   - panel (1920x720 on slot 0x203, scene 0x010004f8): 5 outer zones + Right-Wing Media / Trip Widget
 *       1. below_speed  (392, 429, 214x84)  : Aligned under speed digits, clear of center map
 *       2. gear_d       (1463, 650, 74x56)  : White shift position 1..8 strictly right of GEAR_WIN (1380..1460)
 *       3. brake_rail   (1280, 609, 296x31) : 20-segment right-to-left DSC hydraulic brake bar (hidden in Park)
 *       4. corner_left  (8, 643, 116x66)    : Large Oil + Coolant temperatures (always visible)
 *       5. corner_right (1816, 643, 98x66)  : Large HV Battery % SoC (or Batt Temp / IAT / GBX / 12V)
 *       6. right_widget (1244, 214, 312x266): Re-implemented Right-Wing Widget (Full-color Album Art + Song +
 *          Progress Bar & Trip/Powertrain view, cycled with the left-stalk BC button).
 *   - map (1088x480 on 0x100, contend: 0): optional Map-Slot-Only mode over waze-on-cluster when user prefers
 *       KOMBI4's stock right-side BC widget.
 *
 * Strict Node 8.16.2 (ES2017): no optional chaining, no ??, no dependencies.
 */

const fs = require('fs');
const path = require('path');
const { ClusterRender, DEFAULT_PATH } = require('./cluster_render_client');
const { Canvas } = require('./kit/canvas');
const fontsMod = require('./kit/fonts');
const { t: tr, getLanguage } = require('./kit/i18n');
const { installStockBmwFonts, getFontSource } = require('./bmw_font');
const {
    formatTemp, formatSpeed, formatEvEff, formatFuelEff, formatPress, formatPowerKw,
} = require('./units');
const {
    NW: HUD_NAV_W, NH: HUD_NAV_H, ROAD_W: HUD_ROAD_W, ROAD_H: HUD_ROAD_H,
    drawHudNav, drawHudRoadBanner, drawExitBadge, measureExitBadge, hudNavKey, hudRoadKey,
} = require('./hud_nav_renderer');
const { drawArrow } = require('./redline_hud_nav');
const { metres } = require('./redline_nav');
const { buildStockBackdrop } = require('./image_decode');
const { COVER_SIDE, paginateTitle, resolveRightWidgetPage } = require('./media_tracker');
const { computeIceBatteryCharge } = require('./signals');
const { LayoutStore, resolveWidgetRect } = require('./layout_config');

const DEFAULT_CONF_DIR = '/var/opt/cluster-render';
const DEFAULT_CR_STATUS = '/run/cluster-render/status.txt';
const DEFAULT_WAZE_STATUS = '/run/waze-on-cluster/status.json';
const ICE_CHARGE_MAX_KW = 15.0;
const BOLT_ROWS = [
    [4, 3], [3, 4], [3, 3], [2, 4], [1, 4],
    [0, 8], [0, 8],
    [3, 4], [3, 3], [2, 4], [2, 3], [1, 3], [1, 2],
];

function boltWidth(heightPx) {
    const h = typeof heightPx === 'number' && heightPx > 0 ? heightPx : 13;
    return h <= 14 ? 8 : Math.max(8, Math.round(h * 0.60));
}

function drawLightningBolt(cv, x0, y0, col, heightPx) {
    const h = typeof heightPx === 'number' && heightPx > 0 ? heightPx : 13;
    if (h <= 14) {
        cv.fillRect(x0 + 3, y0 - 1, 5, 1, COL.outline);
        for (let r = 0; r < BOLT_ROWS.length; r++) {
            const dx = BOLT_ROWS[r][0];
            const w = BOLT_ROWS[r][1];
            cv.fillRect(x0 + dx - 1, y0 + r, w + 2, 1, COL.outline);
        }
        cv.fillRect(x0, y0 + BOLT_ROWS.length, 4, 1, COL.outline);
        for (let r = 0; r < BOLT_ROWS.length; r++) {
            cv.fillRect(x0 + BOLT_ROWS[r][0], y0 + r, BOLT_ROWS[r][1], 1, col);
        }
        return 8;
    }
    const w = boltWidth(h);
    const drawPair = (ox, oy, c) => {
        const x = x0 + ox;
        const y = y0 + oy;
        cv.triangle([
            [x + w * 0.66, y],
            [x, y + h * 0.55],
            [x + w * 0.54, y + h * 0.55],
        ], c);
        cv.triangle([
            [x + w, y + h * 0.45],
            [x + w * 0.34, y + h],
            [x + w * 0.46, y + h * 0.45],
        ], c);
    };
    const r = h >= 24 ? 1.5 : 1;
    drawPair(-r, 0, COL.outline);
    drawPair(r, 0, COL.outline);
    drawPair(0, -r, COL.outline);
    drawPair(0, r, COL.outline);
    drawPair(-1, -1, COL.outline);
    drawPair(1, 1, COL.outline);
    drawPair(0, 0, col);
    return w;
}

// Shifted +16px down so there is generous breathing room under the main digital speed digits while clearing the traffic light sign (>=536)
const BELOW_SPEED_BASE = { x: 392, y: 445, w: 214, h: 84 };
// Strictly x >= 1461 so we NEVER overlap KOMBI4's GEAR_WIN (1380..1460), which both clips digits
// and latches BMW's safety BLACK_BOX over the Right Wing (1406..1597, 342..419).
const GEAR_D_BASE = { x: 1461, y: 650, w: 26, h: 56 };
// Compact stacked OEM 'CABIN' micro-header + HVAC-colored interior temp between gear_d (1461..1487) and stock ambient (+57°F at 1540+)
const CABIN_TEMP_BASE = { x: 1488, y: 654, w: 51, h: 50 };
const BRAKE_RAIL_BASE = { x: 1280, y: 609, w: 296, h: 31 };
const CORNER_LEFT_BASE = { x: 8, y: 643, w: 116, h: 66 };
// Bottom-right corner readout below battery icon (12V SoC % by default now that PHEV HV SoC overlays the HV battery gauge)
const CORNER_RIGHT_BASE = { x: 1816, y: 646, w: 98, h: 66 };
// PHEV-only HV Battery SoC % overlay centered inside the upper dark pocket of the bottom-right HV battery sub-gauge (well above the 50 mark)
const HV_SOC_GAUGE_BASE = { x: 1796, y: 452, w: 92, h: 56 };
// Right-Wing Gauge & Widget pocket (1244..1780, 88..608): full-wing calibrated gauge-face artwork backdrop
// (including pointed top-left eyebrow handle & full outer-right bezel curve down to y=601) with cover top-left at world (1376, 164)
const RIGHT_WIDGET_BASE = { x: 1244, y: 88, w: 536, h: 520 };
// Frameless speedometer digits centered on G20 dial readout
const SPEED_BASE = { x: 372, y: 328, w: 220, h: 90 };
// Top-center 5AU camera pocket iOS turn card (stock OEM KOMBI4 already renders bottom lane bar)
const TURN_CARD_BASE = { x: 760, y: 18, w: 400, h: 96 };
// Bottom-center iOS arrival ETA capsule (lifted +20px to clear parked 'Total ... km' odometer row)
const ETA_PILL_BASE = { x: 760, y: 628, w: 400, h: 46 };

// Strictly y=100..200 (<= 202 Assisted Driving / ACC set-speed & green car keep-out)
const HUD_BASE = { x: 136, y: 100, w: 268, h: 100 };
// Dedicated Lead-Car Headway badge right above BMW's green ACC car (x=284..404 < 405 nav, y=139..180 > 138 road & well above Row 3 brake)
const HUD_HEADWAY_BASE = { x: 284, y: 139, w: 120, h: 41 };
// Full-width top-row street & highway exit badge banner (x=132..676 <= 680, y=100..138)
const HUD_ROAD_BASE = { x: 132, y: 100, w: HUD_ROAD_W, h: HUD_ROAD_H };
// Right-side HUD turn-by-turn arrow & lane guidance below road banner (x=412..676 <= 680, y=140..372 <= 380)
const HUD_NAV_BASE = { x: 412, y: 140, w: HUD_NAV_W, h: HUD_NAV_H };

// Slot 0x100 (1088x480 at world 416,120): borderless side-bottom readouts leaving center route x=368..680 100% clear
const MAP_SPEED_RECT = { x: 16, y: 325, w: 204, h: 84 };
const MAP_LEFT_RECT = { x: 186, y: 380, w: 182, h: 68 };
const MAP_RIGHT_RECT = { x: 680, y: 374, w: 228, h: 74 };

const CLUSTER_LAYER_NAMES = ['below_speed', 'gear_d', 'brake_rail', 'corner_left', 'corner_right'];
const PANEL_ALL_LAYERS = [
    'below_speed', 'gear_d', 'cabin_temp', 'brake_rail', 'corner_left', 'corner_right',
    'hv_soc_gauge', 'right_widget', 'speed', 'guidance_turn_card', 'eta_pill',
];
const MAP_LAYER_NAMES = ['map_speed', 'map_left', 'map_right'];

const COL = {
    clear: [0, 0, 0, 0],
    outline: [2, 6, 12, 242],
    shadow: [4, 8, 14, 224],
    white: '#f2f5fa',
    cyan: '#38c7ff',
    mediaCyan: '#45d6ff',
    icyBlue: '#5bc8ff',
    softBlue: '#9ec5eb',
    tagBlue: '#7fb8f0',
    tagGray: '#b4bcc6',
    mediaSub: '#cbd2dc',
    mediaTime: '#d4dbe4',
    amber: '#ffb347',
    orange: '#f97316',
    red: '#ef4444',
    dim: '#9ec5eb',
    label: '#7fb8f0',
    railDim: [48, 66, 90, 125],
    mapRailDim: [38, 62, 92, 185],
    progTrack: [36, 56, 78, 175],
    tileBg: [16, 28, 46, 235],
    tileRim: [68, 112, 160, 180],
    divider: [80, 125, 175, 105],
};

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function cabinHvacPalette(hvacMode) {
    if (hvacMode === 'cooling') {
        return { val: '#5bc8ff', unit: '#7fb8e6' };
    }
    if (hvacMode === 'heating') {
        return { val: '#ff9f43', unit: '#d9924e' };
    }
    return { val: '#f2f5fa', unit: '#9aa6b6' };
}

function formatDuration(sec) {
    if (typeof sec !== 'number' || !isFinite(sec) || sec < 0) return '--:--';
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const rs = r < 10 ? '0' + r : String(r);
    if (h > 0) return h + ':' + (m < 10 ? '0' + m : String(m)) + ':' + rs;
    return m + ':' + rs;
}

/**
 * Inspect /var/opt/cluster-render/cluster-render.conf + cluster-render.local.conf.
 */
function inspectClusterSlotConfig(confDir) {
    const dir = confDir || process.env.CLUSTER_RENDER_CONF_DIR || DEFAULT_CONF_DIR;
    const files = ['cluster-render.conf', 'cluster-render.local.conf'];
    let panelSlot = null;
    let sceneId = null;
    let foundLocal = false;

    for (let i = 0; i < files.length; i++) {
        const p = path.join(dir, files[i]);
        let txt = '';
        try { txt = fs.readFileSync(p, 'utf8'); } catch (e) { continue; }
        if (i === 1) foundLocal = true;
        const lines = txt.split(/\r?\n/);
        for (let k = 0; k < lines.length; k++) {
            const line = lines[k].replace(/#.*/, '').trim();
            if (!line) continue;
            const m = line.match(/^([a-zA-Z0-9_]+)\s*=\s*(\S+)/);
            if (!m) continue;
            if (m[1] === 'panel_slot') panelSlot = m[2].toLowerCase();
            else if (m[1] === 'panel_scene_id') sceneId = m[2].toLowerCase();
        }
    }

    const resolvedSlot = panelSlot || '0x203';
    const resolvedScene = sceneId || '0x010004f8';
    const conflictSlot = resolvedSlot === '0x202' || resolvedSlot === '0x201';
    const conflictScene = resolvedScene === '0x010004f0';
    const safe = resolvedSlot === '0x203' && !conflictSlot && !conflictScene;
    return {
        safe,
        conflictSlot,
        conflictScene,
        foundLocal,
        panelSlot: panelSlot || '0x203 (default)',
        sceneId: resolvedScene,
    };
}

/**
 * Compute single bounding dirty rectangle between two equal-sized RGBA buffers.
 * Returns null if identical.
 */
function changes(was, now, w, h) {
    if (!was || was.length !== now.length) return { x: 0, y: 0, w, h };
    const row = w * 4;
    let top = 0;
    while (top < h && Buffer.compare(now.subarray(top * row, (top + 1) * row), was.subarray(top * row, (top + 1) * row)) === 0) top++;
    if (top === h) return null;
    let bot = h - 1;
    while (bot > top && Buffer.compare(now.subarray(bot * row, (bot + 1) * row), was.subarray(bot * row, (bot + 1) * row)) === 0) bot--;
    let left = w, right = -1;
    for (let y = top; y <= bot; y++) {
        const rStart = y * row;
        for (let x = 0; x < left; x++) {
            const o = rStart + x * 4;
            if (now[o] !== was[o] || now[o + 1] !== was[o + 1] || now[o + 2] !== was[o + 2] || now[o + 3] !== was[o + 3]) {
                left = x;
                break;
            }
        }
        for (let x = w - 1; x > right && x >= left; x--) {
            const o = rStart + x * 4;
            if (now[o] !== was[o] || now[o + 1] !== was[o + 1] || now[o + 2] !== was[o + 2] || now[o + 3] !== was[o + 3]) {
                right = x;
                break;
            }
        }
        if (left === 0 && right === w - 1) break;
    }
    if (right < left) return null;
    return { x: left, y: top, w: right - left + 1, h: bot - top + 1 };
}

function packRect(buf, iw, r) {
    const out = Buffer.allocUnsafe(r.w * r.h * 4);
    for (let y = 0; y < r.h; y++) {
        const srcOff = ((r.y + y) * iw + r.x) * 4;
        buf.copy(out, y * r.w * 4, srcOff, srcOff + r.w * 4);
    }
    return out;
}

function drawTextOutline(cv, str, x, y, size, color, opts) {
    const o = Object.assign({ literal: true }, opts || {});
    const r = size >= 26 ? 2 : 1;
    cv.text(str, x - r, y, size, COL.outline, o);
    cv.text(str, x + r, y, size, COL.outline, o);
    cv.text(str, x, y - r, size, COL.outline, o);
    cv.text(str, x, y + r, size, COL.outline, o);
    cv.text(str, x - 1, y - 1, size, COL.outline, o);
    cv.text(str, x + 1, y - 1, size, COL.outline, o);
    cv.text(str, x - 1, y + 1, size, COL.outline, o);
    cv.text(str, x + 1, y + 1, size, COL.outline, o);
    return cv.text(str, x, y, size, color, o);
}

/**
 * Razor-sharp OEM text over darkened media vignette: clean 1px drop shadow instead of heavy ±2px
 * 8-way outline so fine BMW glyphs and complex CJK Kanji/Hanzi stay crisp and un-choked.
 */
function drawTextClean(cv, str, x, y, size, color, opts) {
    const o = Object.assign({ literal: true }, opts || {});
    cv.text(str, x + 1, y + 2, size, [2, 5, 10, 185], o);
    cv.text(str, x, y + 1, size, [2, 5, 10, 135], o);
    return cv.text(str, x, y, size, color, o);
}

function fitTextLine(cv, str, maxW, sizes, fontName) {
    const clean = String(str || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) return { text: '', size: sizes[0] };
    const fOpt = { font: fontName || 'bold' };
    for (let i = 0; i < sizes.length; i++) {
        const sz = sizes[i];
        if (cv.textWidth(clean, sz, fOpt) <= maxW) {
            return { text: clean, size: sz };
        }
    }
    const minSz = sizes[sizes.length - 1];
    const cps = Array.from(clean);
    while (cps.length > 3 && cv.textWidth(cps.join('').trim() + '...', minSz, fOpt) > maxW) {
        cps.pop();
    }
    return { text: cps.join('').trim() + '...', size: minSz };
}

function paintRadialGlow(cv, cx, cy, radius, rgb, peakAlpha) {
    const r0 = rgb && typeof rgb[0] === 'number' ? rgb[0] : 56;
    const g0 = rgb && typeof rgb[1] === 'number' ? rgb[1] : 178;
    const b0 = rgb && typeof rgb[2] === 'number' ? rgb[2] : 246;
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(cv.w - 1, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(cv.h - 1, Math.ceil(cy + radius));
    const invR = 1 / Math.max(1, radius);
    const d = cv.d;
    for (let y = y0; y <= y1; y++) {
        const dy = (y - cy) * invR;
        const dy2 = dy * dy;
        if (dy2 >= 1) continue;
        const rowOff = y * cv.w;
        for (let x = x0; x <= x1; x++) {
            const dx = (x - cx) * invR;
            const d2 = dx * dx + dy2;
            if (d2 >= 1) continue;
            const fall = 1 - d2;
            const a = Math.round(peakAlpha * fall * fall);
            if (a <= 0) continue;
            const o = (rowOff + x) * 4;
            d[o] = r0;
            d[o + 1] = g0;
            d[o + 2] = b0;
            d[o + 3] = a;
        }
    }
}

/**
 * Natural neutral smoked-glass background plate: soft multi-step drop shadow,
 * neutral charcoal translucent fill, subtle upper glass sheen, and 1px hairline
 * white catchlight (no colored/blue border).
 */
function paintNaturalGlassPlate(cv, radius, opts) {
    const o = opts || {};
    const alpha = typeof o.alpha === 'number' ? o.alpha : 172;
    const inset = 3;
    const w = cv.w - inset * 2;
    const h = cv.h - inset * 2;
    if (w <= 4 || h <= 4) return;
    const r = Math.min(Math.max(4, radius || 16), Math.floor(Math.min(w, h) / 2));

    cv.roundRect(0, 0, cv.w, cv.h, r + 3, [0, 0, 0, 24]);
    cv.roundRect(1, 1, cv.w - 2, cv.h - 2, r + 2, [0, 0, 0, 48]);
    cv.roundRect(2, 2, cv.w - 4, cv.h - 4, r + 1, [0, 0, 0, 76]);
    cv.roundRect(inset, inset, w, h, r, [10, 12, 16, alpha]);

    const sheenRows = Math.max(1, Math.round(h * 0.38));
    const minBodyA = Math.max(40, alpha - 20);
    const d = cv.d;
    for (let row = 0; row < sheenRows; row++) {
        const py = inset + row;
        if (py < 0 || py >= cv.h) continue;
        const t = row / sheenRows;
        const lift = Math.round(14 * (1 - t) * (1 - t));
        if (lift <= 0) break;
        const rowOff = py * cv.w;
        for (let px = inset; px < inset + w; px++) {
            const p = (rowOff + px) * 4;
            if (d[p + 3] >= minBodyA) {
                d[p] = Math.min(255, d[p] + lift);
                d[p + 1] = Math.min(255, d[p + 1] + lift);
                d[p + 2] = Math.min(255, d[p + 2] + lift);
            }
        }
    }

    cv.strokeRoundRect(inset, inset, w, h, r, 1, [255, 255, 255, 34]);
}

function fillSlantBar(cv, x0, y, w, h, fillW, col) {
    if (fillW <= 0) return;
    const rgba = Array.isArray(col) ? col : [69, 214, 255, 255];
    const [r, g, b, a] = [rgba[0], rgba[1], rgba[2], rgba[3] !== undefined ? rgba[3] : 255];
    const maxW = Math.min(w, Math.max(1, fillW));
    const d = cv.d;
    for (let row = 0; row < h; row++) {
        const py = y + row;
        if (py < 0 || py >= cv.h) continue;
        // BMW '/' forward-slash slant on right end: top row (row=0) extends furthest right; lower rows step left
        const slant = Math.min(Math.max(0, row), w - 1);
        const rowEnd = Math.min(x0 + w, Math.max(x0 + 1, x0 + maxW - row));
        for (let px = x0; px < rowEnd; px++) {
            if (px < 0 || px >= cv.w) continue;
            const o = (py * cv.w + px) * 4;
            d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = a;
        }
        // Subtle 1px dark outline at slant edge
        if (slant >= 0 && rowEnd >= x0 && rowEnd < cv.w) {
            const o = (py * cv.w + rowEnd) * 4;
            if (d[o + 3] < 220) {
                d[o] = 2; d[o + 1] = 6; d[o + 2] = 12; d[o + 3] = 220;
            }
        }
    }
}

function blitCoverArt(cv, ox, oy, cover, radius) {
    const side = cover.w;
    const src = cover.d;
    const dst = cv.d;
    const rad = radius || 10;
    for (let y = 0; y < side; y++) {
        const dy = y < rad ? (rad - 0.5 - y) : (y >= side - rad ? (y - (side - rad - 0.5)) : 0);
        const py = oy + y;
        if (py < 0 || py >= cv.h) continue;
        for (let x = 0; x < side; x++) {
            const dx = x < rad ? (rad - 0.5 - x) : (x >= side - rad ? (x - (side - rad - 0.5)) : 0);
            let cov = 1;
            if (dx > 0 && dy > 0) {
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist >= rad + 0.5) continue;
                if (dist > rad - 0.5) cov = rad + 0.5 - dist;
            }
            const px = ox + x;
            if (px < 0 || px >= cv.w) continue;
            const so = (y * side + x) * 4;
            const sa = Math.round(src[so + 3] * cov);
            if (sa <= 0) continue;
            const doff = (py * cv.w + px) * 4;
            if (sa >= 254) {
                dst[doff] = src[so];
                dst[doff + 1] = src[so + 1];
                dst[doff + 2] = src[so + 2];
                dst[doff + 3] = 255;
            } else {
                const inv = 255 - sa;
                const da = dst[doff + 3];
                const outA = sa + Math.round((da * inv) / 255);
                if (outA > 0) {
                    dst[doff] = Math.round((src[so] * sa + ((dst[doff] * da * inv) / 255)) / outA);
                    dst[doff + 1] = Math.round((src[so + 1] * sa + ((dst[doff + 1] * da * inv) / 255)) / outA);
                    dst[doff + 2] = Math.round((src[so + 2] * sa + ((dst[doff + 2] * da * inv) / 255)) / outA);
                    dst[doff + 3] = outA;
                }
            }
        }
    }
    cv.strokeRoundRect(ox, oy, side, side, rad, 1, [255, 255, 255, 52]);
}

function resolveCornerRightMode(settingVal, profile, t, hvSocGaugeOn) {
    const mode = settingVal || 'auto';
    if (mode === 'off') return 'off';
    if (mode !== 'auto') return mode;
    const isPhev = Boolean((profile && profile.vehicleType === 'phev') ||
        typeof (t && t.soc) === 'number' ||
        typeof (t && t.battTempC) === 'number');
    // Now that PHEV HV Battery % overlays the HV battery gauge by default, bottom-right auto-selects 12V % (or 12V V)
    if (t && typeof t.soc12 === 'number' && isFinite(t.soc12)) return 'soc12';
    if (t && typeof t.v12 === 'number' && isFinite(t.v12)) return 'v12';
    if (isPhev) {
        if (hvSocGaugeOn === false) return 'soc';
        if (t && typeof t.battTempC === 'number' && isFinite(t.battTempC)) return 'batt';
        return 'soc12';
    }
    return 'iat';
}

function formatCornerRightMetric(t, units, mode) {
    let tag = '12V';
    let valText = '--';
    let col = COL.dim;

    if (mode === 'soc12') {
        tag = '12V';
        if (typeof t.soc12 === 'number' && isFinite(t.soc12)) {
            const pct12 = clamp(Math.round(t.soc12), 0, 100);
            valText = pct12 + '%';
            col = pct12 < 40 ? COL.red : (pct12 < 55 ? COL.amber : COL.white);
        } else {
            valText = '--%';
        }
    } else if (mode === 'soc') {
        tag = 'SOC';
        if (typeof t.soc === 'number' && isFinite(t.soc)) {
            const pct = clamp(Math.round(t.soc), 0, 100);
            valText = pct + '%';
            col = pct <= 10 ? COL.red : (pct <= 20 ? COL.amber : COL.white);
        } else {
            valText = '--%';
        }
    } else if (mode === 'batt') {
        tag = 'BAT';
        valText = formatTemp(t.battTempC, units).text;
        if (typeof t.battTempC === 'number') {
            col = t.battTempC < 18 ? COL.icyBlue
                : t.battTempC > 32 ? (t.battTempC >= 40 ? COL.red : COL.amber)
                : COL.white;
        }
    } else if (mode === 'gbx') {
        tag = 'GBX';
        valText = formatTemp(t.gearboxOilC, units).text;
        col = (typeof t.gearboxOilC === 'number' && t.gearboxOilC >= 105) ? COL.amber : COL.white;
    } else if (mode === 'v12') {
        tag = '12V';
        valText = (typeof t.v12 === 'number' && isFinite(t.v12)) ? (t.v12.toFixed(1) + 'V') : '--';
        col = (typeof t.v12 === 'number' && t.v12 < 12.1) ? COL.amber : COL.white;
    } else {
        tag = 'IAT';
        valText = formatTemp(t.iatC, units).text;
        col = COL.white;
    }
    return { tag, valText, col };
}

function formatLeadHeadwayParts(lead, units, mode) {
    if (!lead || !lead.active || typeof lead.gapM !== 'number' || !isFinite(lead.gapM)) return null;
    const isMi = units && units.distUnit === 'mi';
    const isMph = units && units.speedUnit === 'mph';
    let distStr;
    if (isMi) {
        const ft = Math.round(lead.gapM * 3.28084);
        distStr = ft >= 528 ? ((lead.gapM * 0.000621371).toFixed(1) + ' mi') : (ft + ' ft');
    } else {
        distStr = lead.gapM < 10 ? (lead.gapM.toFixed(1) + ' m') : (Math.round(lead.gapM) + ' m');
    }

    const hasHw = typeof lead.headwaySec === 'number' && isFinite(lead.headwaySec);
    const primaryStr = hasHw ? (lead.headwaySec.toFixed(1) + 's') : distStr;
    const primaryCol = hasHw
        ? (lead.headwaySec < 1.0 ? COL.red : (lead.headwaySec < 1.5 ? COL.amber : COL.cyan))
        : (lead.gapM < 3.0 ? COL.amber : COL.cyan);
    const secDistStr = hasHw ? distStr : '';

    let deltaStr = '';
    let deltaCol = COL.softBlue;
    if (mode === 'full' && typeof lead.relSpeedKmh === 'number' && isFinite(lead.relSpeedKmh)) {
        const rv = Math.round(isMph ? lead.relSpeedKmh * 0.621371 : lead.relSpeedKmh);
        const dead = isMph ? 2 : 3;
        if (Math.abs(rv) >= dead) {
            deltaStr = (rv > 0 ? '+' : '') + rv + (isMph ? ' mph' : ' km/h');
            deltaCol = rv <= (isMph ? -10 : -16) ? COL.red : (rv < 0 ? COL.amber : COL.softBlue);
        }
    }
    return { primaryStr, primaryCol, secDistStr, deltaStr, deltaCol, distStr };
}

class OverlayRenderer {
    constructor(opts) {
        const o = opts || {};
        this.log = o.log || { info: () => {}, warn: () => {}, error: () => {} };
        installStockBmwFonts(fontsMod, { cacheDir: o.dataDir, fontDir: o.fontDir, log: this.log });
        this.socketPath = o.socketPath || process.env.COCKPIT_PLUS_SOCKET || process.env.CLUSTER_METRICS_SOCKET || process.env.HUD_CLUSTER_SOCKET || DEFAULT_PATH;
        this.confDir = o.confDir || process.env.CLUSTER_RENDER_CONF_DIR || DEFAULT_CONF_DIR;
        this.crStatusPath = o.crStatusPath || process.env.CLUSTER_RENDER_STATUS_PATH || DEFAULT_CR_STATUS;
        this.wazeStatusPath = o.wazeStatusPath || process.env.WAZE_STATUS_PATH || DEFAULT_WAZE_STATUS;
        this.ClusterRenderCtor = o.ClusterRender || ClusterRender;
        this.layoutStore = new LayoutStore(o.layoutPath);
        this.isBench = Boolean(o.allowPanel || process.env.COCKPIT_PLUS_BENCH === '1' || process.env.CLUSTER_METRICS_BENCH === '1');
        this.cr = null;
        this.connected = false;
        this.ready = false;
        this.targets = '';
        this.layers = {}; // name -> { ref, target, rect, cv, prevBuf, visible }
        this.refused = [];
        this.wazeShowing = false;
        this.lastWazeCheck = 0;
        this.lastCrStatusCheck = 0;
        this.slotStatus = inspectClusterSlotConfig(this.confDir);
        this.bytesSent = 0;
        this.lastHudNavKey = '';
        this.lastHudRoadKey = '';
        this.lastRightWidgetKey = '';
        this.lastTurnCardKey = '';
        this.lastEtaPillKey = '';
        this.lastSpeedKey = '';
        this._turnCardHold = null;
        this._wasCharging = false;
        this._bcBase = 0;
        this._activeAlertKey = '';
        this._alertBcBase = 0;
        this._alertDismissed = false;
        this._iceChgState = {};
        this.hostConfigKey = '';
        this.userMapMode = 'fullview_dials';
        this.hostModeActive = 'native';
        this.crHostLayers = false;
        this.crHostMask = false;
        this.crRenderState = false;
        this.hostingState = '';
        this.hostingReason = '';
        this.mapHostedInto = '';
        this.mapTargetState = '';
        this.mapTargetReason = '';
        this.mapSlotLocked = false;
        this._standbyRescueActive = false;
        this.standbyRescue = false;
        this.wazeStatus = null;
        this.bezelMaskMode = 'off';
        this.lastSummary = {};
    }

    isMapHostedLive() {
        return (this.hostModeActive === 'fullview_dials' || this.hostModeActive === 'center_masked' || this.hostModeActive === 'standby_center') &&
            (this.hostingState === 'live' || this.mapHostedInto === 'panel');
    }

    _parseMapTargetSize() {
        const m = /(?:^|,)\s*map\s*:\s*(\d+)x(\d+)/i.exec(String(this.targets || ''));
        if (m) {
            const w = parseInt(m[1], 10);
            const h = parseInt(m[2], 10);
            if (w >= 64 && h >= 32) return { w, h };
        }
        return { w: 1088, h: 480 };
    }

    _fullviewHostRect() {
        // Stretch hosted map across y=0..668 (video shaders strictly discard side bottom & GEAR_WIN 1380..1460, y>=656).
        const ms = this._parseMapTargetSize();
        const dstH = 668;
        const srcH = Math.max(32, Math.min(ms.h, Math.floor((ms.h * dstH) / 720) & ~1));
        return {
            target: 'map',
            x: 144,
            y: 0,
            w: 1632,
            h: dstH,
            src_x: 0,
            src_y: 0,
            src_w: ms.w,
            src_h: srcH,
            shown: 1,
        };
    }

    _syncMapHost(mode, featherMode, standbyCenter, panelAllowed, customFeatherPx) {
        const cleanMode = (mode === 'native' || mode === 'off')
            ? 'native'
            : ((mode === 'center_panel' || mode === 'center') ? 'center_panel' : 'fullview_dials');
        this.userMapMode = cleanMode;
        const canShaderHost = Boolean(panelAllowed) && (!this.ready || this.crHostMask);
        let effectiveMode = 'native';
        let maskModeNum = 0;
        if (canShaderHost) {
            if (cleanMode === 'fullview_dials') {
                effectiveMode = 'fullview_dials';
                maskModeNum = this.crHostMask ? 1 : 0;
            } else if (cleanMode === 'center_panel') {
                effectiveMode = standbyCenter ? 'standby_center' : 'center_masked';
                maskModeNum = this.crHostMask ? (standbyCenter ? 3 : 2) : 0;
            }
        }
        this.hostModeActive = effectiveMode;

        const wantsHost = effectiveMode !== 'native';
        const featherPx = featherMode === 'tight' ? 68
            : (featherMode === 'wide' ? 130
                : (featherMode === 'custom' ? clamp(Math.round(Number(customFeatherPx) || 96), 28, 160) : 96));
        this.mapFeatherPx = featherPx;
        this.bezelMaskMode = maskModeNum === 1 ? 'dials' : (maskModeNum === 2 ? 'center' : (maskModeNum === 3 ? 'standby' : 'off'));
        if (!this.cr) return;

        const key = effectiveMode + '|' + maskModeNum + '|' + featherPx + '|' + (this.crHostMask ? '1' : '0');
        if (key === this.hostConfigKey) return;
        this.hostConfigKey = key;

        if (wantsHost) {
            if (typeof this.cr.host === 'function') {
                const hostOpts = maskModeNum > 0
                    ? Object.assign(this._fullviewHostRect(), { mask_mode: maskModeNum, mask_feather: featherPx })
                    : this._fullviewHostRect();
                this.cr.host('panel', hostOpts);
            }
        } else if (typeof this.cr.unhost === 'function') {
            this.cr.unhost('map');
        }
    }

    canUsePanel() {
        return this.isBench || this.slotStatus.safe;
    }

    pixelBytesTotal() {
        let sum = 0;
        const keys = Object.keys(this.layers);
        for (let i = 0; i < keys.length; i++) {
            const r = this.layers[keys[i]].rect;
            sum += r.w * r.h * 8; // Compositor counts image layers 2x RGBA
        }
        return sum;
    }

    layerCount() {
        return Object.keys(this.layers).length;
    }

    _readWazeStatus(nowMs) {
        if (nowMs - this.lastWazeCheck < 500) return this.wazeShowing;
        this.lastWazeCheck = nowMs;
        try {
            const st = JSON.parse(fs.readFileSync(this.wazeStatusPath, 'utf8'));
            this.wazeStatus = st && typeof st === 'object' ? {
                state: String(st.state || ''),
                target: String(st.target || ''),
                reason: st.reason ? String(st.reason) : '',
                error: st.error ? String(st.error) : '',
            } : null;
            this.wazeShowing = Boolean(st && st.state === 'showing' && (st.target === 'map' || st.target === 'panel'));
        } catch (e) {
            this.wazeStatus = null;
            this.wazeShowing = false;
        }
        return this.wazeShowing;
    }

    _readClusterRenderStatus(nowMs) {
        if (nowMs - this.lastCrStatusCheck < 1000) return this.mapSlotLocked;
        this.lastCrStatusCheck = nowMs;
        try {
            const txt = fs.readFileSync(this.crStatusPath, 'utf8');
            const lines = txt.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (!/\btarget\s+map\b/i.test(line) && !/\bslot\s+0x100\b/i.test(line)) continue;
                if (/locked/i.test(line)) {
                    this.mapSlotLocked = true;
                } else if (/\bshown\b/i.test(line) || /\bstatus\s+2\b/i.test(line)) {
                    this.mapSlotLocked = false;
                }
            }
        } catch (e) { /* keep cr.on('target') state when status.txt is absent */ }
        return this.mapSlotLocked;
    }

    _ensureLayer(name, opts) {
        const existing = this.layers[name];
        if (existing) {
            if (existing.rect.x !== opts.x || existing.rect.y !== opts.y) {
                existing.rect.x = opts.x;
                existing.rect.y = opts.y;
                if (this.cr) this.cr.set(existing.ref, { x: opts.x, y: opts.y });
            }
            return existing;
        }
        if (!this.cr) return null;
        const ref = this.cr.image({
            target: opts.target,
            klass: opts.klass || 'overlay',
            z: opts.z || 10,
            x: opts.x,
            y: opts.y,
            w: opts.w,
            h: opts.h,
            iw: opts.w,
            ih: opts.h,
            visible: opts.visible !== false,
            contend: opts.contend !== undefined ? opts.contend : true,
        });
        if (!ref) return null;
        const entry = {
            ref,
            target: opts.target,
            rect: { x: opts.x, y: opts.y, w: opts.w, h: opts.h },
            cv: new Canvas(opts.w, opts.h),
            prevBuf: null,
            visible: opts.visible !== false,
        };
        this.layers[name] = entry;
        return entry;
    }

    _setVisible(name, vis) {
        const l = this.layers[name];
        if (!l) return;
        if (l.visible !== vis) {
            l.visible = vis;
            if (this.cr) this.cr.set(l.ref, { visible: vis });
        }
    }

    _upload(name, forceWhole) {
        const l = this.layers[name];
        if (!l || !this.cr) return;
        const nowBuf = Buffer.from(l.cv.d.buffer, l.cv.d.byteOffset, l.cv.d.length);
        if (forceWhole || !l.prevBuf) {
            this.cr.pixels(l.ref, null, nowBuf);
            l.prevBuf = Buffer.from(nowBuf);
            this.bytesSent += nowBuf.length;
            return;
        }
        const rect = changes(l.prevBuf, nowBuf, l.rect.w, l.rect.h);
        if (!rect) return;
        const areaFrac = (rect.w * rect.h) / (l.rect.w * l.rect.h);
        if (areaFrac > 0.72) {
            this.cr.pixels(l.ref, null, nowBuf);
            this.bytesSent += nowBuf.length;
        } else {
            const packed = packRect(nowBuf, l.rect.w, rect);
            this.cr.pixels(l.ref, [rect], packed);
            this.bytesSent += packed.length;
        }
        nowBuf.copy(l.prevBuf);
    }

    connect() {
        if (this.cr) return;
        const cr = new this.ClusterRenderCtor('id7_cockpit_plus', this.socketPath);
        this.cr = cr;
        cr.on('ready', () => {
            this.ready = true;
            this.connected = true;
            this.targets = cr.targets || '';
            this.crHostLayers = Boolean(cr.hostLayers);
            this.crHostMask = Boolean(cr.hostMask);
            this.crRenderState = Boolean(cr.renderState);
            this.hostConfigKey = '';
            const keys = Object.keys(this.layers);
            for (let i = 0; i < keys.length; i++) {
                this.layers[keys[i]].prevBuf = null;
            }
            this.log.info('cluster-render ready (panelSlot=' + this.slotStatus.panelSlot + ', canPanel=' + this.canUsePanel() + ', hostLayers=' + this.crHostLayers + ', hostMask=' + this.crHostMask + ')');
        });
        cr.on('hosting', (target, ev) => {
            if (target !== 'map') return;
            this.hostingState = (ev && ev.state) ? String(ev.state) : '';
            this.hostingReason = (ev && ev.reason) ? String(ev.reason) : '';
            this.hostConfigKey = '';
        });
        cr.on('host', (target, ev) => {
            if (target !== 'map') return;
            this.mapHostedInto = (ev && ev.into) ? String(ev.into) : '';
            this.hostConfigKey = '';
        });
        cr.on('target', (target, state, holder, reason) => {
            if (target !== 'map') return;
            this.mapTargetState = String(state || '');
            this.mapTargetReason = String(reason || '');
            if (this.mapTargetState === 'waiting' && /locked/i.test(this.mapTargetReason)) {
                this.mapSlotLocked = true;
            } else if (this.mapTargetState === 'shown' || this.mapTargetState === 'parked') {
                this.mapSlotLocked = false;
            }
        });
        cr.on('disconnected', () => {
            this.ready = false;
            this.connected = false;
            this.crHostLayers = false;
            this.crHostMask = false;
            this.crRenderState = false;
            this.hostingState = '';
            this.hostingReason = '';
            this.mapHostedInto = '';
            this.mapTargetState = '';
            this.mapTargetReason = '';
            this.mapSlotLocked = false;
            this._standbyRescueActive = false;
            this.standbyRescue = false;
            this.bezelMaskMode = 'off';
        });
        cr.on('refused', (op, ref, reason) => {
            const msg = op + ' ref=' + ref + ': ' + reason;
            if (this.refused.length < 16) this.refused.push(msg);
            this.log.warn('cluster-render refused ' + msg);
        });
        cr.connect();
    }

    /**
     * Draw all enabled zones offscreen into Canvases and upload changed regions to cluster-render.
     * Safe to invoke headlessly in unit tests (when connect() hasn't been called).
     */
    render(model, settingsObj, nowMs) {
        const now = typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now();
        const s = settingsObj || {};
        this.slotStatus = inspectClusterSlotConfig(this.confDir);
        const enabled = s.enabled !== false;
        const targetPref = s.displayTarget || 'both';
        const wantHud = enabled && (targetPref === 'both' || targetPref === 'hud');
        const wantCluster = enabled && (targetPref === 'both' || targetPref === 'cluster');
        const wazeOn = this._readWazeStatus(now);

        const units = model.units;
        const profile = model.profile;
        const t = model.telemetry || {};
        const eff = model.efficiency || {};

        // Consistent Cluster Map Display Modes:
        //   - 'fullview_dials' (default): FullView Map on 0x203 (mask_mode=1) + all outer vitals, nav cards & right BC widget.
        //   - 'center_panel': Center Small Map kept consistently on 0x203 in both driving (mask_mode=2 with 0 km/h pocket)
        //     and engine-off (mask_mode=3 symmetric contour without 0 km/h pocket), keeping right BC widget & overlays active.
        //   - 'native': Pure Stock Mode on 0x100 — completely releases panel 0x203 in both driving and engine-off
        //     so KOMBI4 displays genuine stock 0x100 map + stock 0x200 right BC card while HUD (0x323) stays active.
        const rawSlotMode = s.clusterSlotMode || 'panel_only';
        const clusterSlotMode = rawSlotMode === 'map_only' ? 'map_only' : 'panel_only';
        const isOuterOnlyMode = clusterSlotMode === 'map_only';
        const canPanel = this.canUsePanel();
        const basePanelAvailable = Boolean(wantCluster && canPanel);

        // HUD navigation & route state (needed before standby map check):
        const hudNavMode = s.hudNavMode || 'own_nav_minimap';
        const hn = t.hudNav || null;
        const wocHudOn = Boolean(hn && hn.wocHudShowing);
        const miniMapOn = Boolean(hn && hn.miniMapActive);
        const fallbackNavOn = Boolean(hn && hn.noTurnFallback);
        const routeOn = Boolean((hn && hn.routeActive) || t.navRouteActive);
        const lanesOn = Boolean((hn && hn.hasLanes) || t.navHasLanes);

        this._readClusterRenderStatus(now);
        const rawMapMode = (s.mapHostMode === 'native' || s.mapHostMode === 'off')
            ? 'native'
            : ((s.mapHostMode === 'center_panel' || s.mapHostMode === 'center') ? 'center_panel' : 'fullview_dials');
        const isPureNativeMode = rawMapMode === 'native';
        const isCenterPanelMode = rawMapMode === 'center_panel';
        const isNativeMapMode = isPureNativeMode || isCenterPanelMode;
        const wazeSlotLocked = Boolean(this.wazeStatus && /locked/i.test((this.wazeStatus.error || '') + ' ' + (this.wazeStatus.reason || '')));
        const drivingActive = Boolean(
            (typeof t.rpm === 'number' && t.rpm > 100) ||
            t.stage === 'D' ||
            t.stage === 'R' ||
            (typeof t.speedKmh === 'number' && t.speedKmh > 1.5)
        );
        const engineOffStandby = Boolean(
            !t.demo &&
            !t.stage &&
            (t.rpm === 0 || t.rpm === null || t.rpm === undefined) &&
            (t.speedKmh === null || t.speedKmh === undefined || t.speedKmh < 0.5)
        );
        if (!basePanelAvailable || isOuterOnlyMode || !isCenterPanelMode) {
            this._standbyRescueActive = false;
        } else if (drivingActive || (!this.mapSlotLocked && !wazeSlotLocked && !engineOffStandby)) {
            this._standbyRescueActive = false;
            if (drivingActive) this.mapSlotLocked = false;
        } else if (this.mapSlotLocked || wazeSlotLocked || engineOffStandby) {
            this._standbyRescueActive = true;
        }
        this.standbyRescue = this._standbyRescueActive;
        const nativePanelReleased = Boolean(basePanelAvailable && !isOuterOnlyMode && isPureNativeMode);
        let panelAllowed = false;
        let showMapOverlay = false;
        if (wantCluster) {
            panelAllowed = canPanel && !nativePanelReleased;
            showMapOverlay = !canPanel && s.fallbackMapBar !== false && wazeOn;
        }
        const wantHostMode = (panelAllowed && !isOuterOnlyMode) ? rawMapMode : 'native';
        this._syncMapHost(wantHostMode, s.mapBezelFeather || 'standard', this._standbyRescueActive, panelAllowed && !isOuterOnlyMode, s.mapBezelFeatherCustomPx);

        let hudYieldedToNav = false;
        let hudYieldReason = '';
        if (hudNavMode === 'yield_route') {
            hudYieldedToNav = routeOn || wocHudOn;
            hudYieldReason = wocHudOn ? 'waze_hud' : (routeOn ? 'route' : '');
        } else if (!wocHudOn && hudNavMode === 'own_nav_minimap') {
            hudYieldedToNav = miniMapOn || fallbackNavOn;
            hudYieldReason = miniMapOn ? (hn.miniMapReason || 'minimap') : (fallbackNavOn ? 'bmw_nav_fallback' : '');
        } else if (!wocHudOn && hudNavMode === 'yield_lanes') {
            hudYieldedToNav = lanesOn || miniMapOn || fallbackNavOn;
            hudYieldReason = miniMapOn ? (hn.miniMapReason || 'minimap') : (lanesOn ? 'lanes' : (fallbackNavOn ? 'bmw_nav_fallback' : ''));
        }
        const showHud = wantHud && !hudYieldedToNav;
        const showOwnHudNav = showHud && !wocHudOn && hudNavMode !== 'yield_route' && hudNavMode !== 'keep' &&
            Boolean(hn && hn.show);
        // Full-width top-row street, highway shield & exit badge banner when active maneuver has any road/shield/exit
        const showHudRoad = Boolean(showOwnHudNav && hn && hn.show && (
            (hn.show.road && hn.show.road.length > 0) ||
            (hn.show.exitBadge && hn.show.exitBadge.length > 0) ||
            (Array.isArray(hn.show.shields) && hn.show.shields.length > 0)
        ));
        const wocHudOverlay = Boolean(showHud && wocHudOn);

        const hx = clamp(Number(s.hudNudgeX) || 0, -40, 40);
        const hy = clamp(Number(s.hudNudgeY) || 0, -40, 40);
        const cx = clamp(Number(s.clusterNudgeX) || 0, -12, 12);
        const cy = clamp(Number(s.clusterNudgeY) || 0, -12, 12);
        const layoutState = this.layoutStore.get(now);

        const gearDisplay = s.gearDisplay === 'left_of_speed' ? 'below_speed' : (s.gearDisplay || 'next_to_d');
        const belowSpeedLine1 = s.belowSpeedLine1 || 'efficiency';
        const belowSpeedLine2 = s.belowSpeedLine2 || 'power';
        const showBsLine1 = belowSpeedLine1 !== 'off';
        const showBsLine2 = belowSpeedLine2 !== 'off';
        const brakeMode = s.brakeIndicator || 'bar_num';
        const cornerLeftMode = s.cornerLeftDisplay || 'oil_cool';
        const hvSocGaugeEnabled = s.hvSocGauge !== false;
        const cabinTempEnabled = s.cabinTempDisplay !== false;
        const speedMode = s.clusterSpeedOverlay;
        const speedSettingOn = isNativeMapMode
            ? false
            : ((speedMode === false || speedMode === 'off')
                ? false
                : ((speedMode === true || speedMode === 'on') ? true : (this.hostModeActive === 'fullview_dials')));
        const clusterSpeedEnabled = speedSettingOn && layoutState.widgets.speed.enabled !== false;
        const clusterTurnCardEnabled = s.clusterTurnCard !== false && layoutState.widgets.guidance_turn_card.enabled !== false;
        const clusterEtaEnabled = s.clusterEtaPill !== false && layoutState.widgets.eta_pill.enabled !== false;
        const speedPlate = s.speedPlate === 'glass' ? 'glass' : 'none';
        const turnCardPlate = s.turnCardPlate === 'none' ? 'none' : 'glass';
        const etaPillPlate = s.etaPillPlate === 'none' ? 'none' : 'glass';
        const cornerRightMode = resolveCornerRightMode(s.cornerRightDisplay, profile, t, hvSocGaugeEnabled);
        const rightWidgetMode = s.rightWidgetMode || (((s.widgetMedia !== false ? 'M' : '') + (s.widgetTrip !== false ? 'T' : '') + (s.widgetTpms ? 'P' : '')) || 'off');
        const hudHeadwayMode = s.hudHeadway || 'full';
        const hudLine1 = s.hudLine1 || 'efficiency_gear';
        const hudLine2 = s.hudLine2 || 'power';
        const hudLine3 = s.hudLine3 || 'brake';

        const chg = t.charging || null;
        const isCharging = Boolean(chg && chg.active);

        // Smart Anomaly Alert auto-switch & left-stalk BC dismissal:
        //   - New alert (or new preview trigger) auto-switches Right-Wing Widget to `'tpms'` (Tire & Alerts)
        //     and displays a readable plain-English alert message on HUD Line 3.
        //   - Pressing BC dismisses the HUD alert AND immediately switches the Right-Wing Widget to the next enabled page.
        const media = t.media || null;
        const curBcStep = (media && typeof media.bcStep === 'number') ? media.bcStep
            : (media && typeof media.bcClicks === 'number' ? media.bcClicks : 0);
        if (isCharging && !this._wasCharging) {
            this._bcBase = curBcStep;
        } else if (!isCharging && this._wasCharging) {
            this._bcBase = 0;
        }
        this._wasCharging = isCharging;

        const rawAlert = model.previewAlert || (s.smartAlerts !== false ? (profile && profile.alert) : null);
        const alertKey = rawAlert
            ? (rawAlert.seq !== undefined ? ('P:' + rawAlert.seq) : ((rawAlert.id || 'a') + ':' + (rawAlert.severity || 'amber') + ':' + (rawAlert.corner || '')))
            : '';
        if (!alertKey) {
            this._activeAlertKey = '';
            this._alertDismissed = false;
        } else if (alertKey !== this._activeAlertKey) {
            this._activeAlertKey = alertKey;
            this._alertBcBase = curBcStep;
            this._alertDismissed = false;
        } else if (!this._alertDismissed && curBcStep !== this._alertBcBase) {
            this._alertDismissed = true;
            this._bcBase = curBcStep;
        }
        const activeAlert = (rawAlert && !this._alertDismissed) ? rawAlert : null;
        const rightWidgetPage = (!panelAllowed || isOuterOnlyMode || isPureNativeMode) ? 'off'
            : (activeAlert ? 'tpms' : resolveRightWidgetPage(s, media, isCharging, this._bcBase));

        let hero;
        let heroCol;
        let heroUnitCol = COL.softBlue;
        let subText = '';
        let subCol = COL.softBlue;
        let subBolt = false;

        if (isCharging) {
            const hasChgKw = typeof chg.chargeKw === 'number' && isFinite(chg.chargeKw);
            hero = {
                value: hasChgKw ? ('+' + chg.chargeKw.toFixed(1)) : '--',
                unit: 'kW',
                bolt: hasChgKw,
            };
            heroCol = COL.cyan;
            subText = chg.maxAmps ? (tr('CHARGING') + ' ' + Math.round(chg.maxAmps) + 'A') : tr('CHARGING');
            subCol = COL.softBlue;
        } else {
            hero = profile.isEv
                ? formatEvEff(eff.evKmPerKwh, units)
                : formatFuelEff(eff.fuelLPer100km, eff.isDfco, units);
            heroCol = profile.mode === 'ev_regen' ? COL.cyan : COL.white;
            heroUnitCol = profile.isEv ? COL.softBlue : COL.white;

            if (profile.isEv) {
                const pFmt = formatPowerKw(t.hvKw);
                subText = pFmt.text;
                subBolt = Boolean(pFmt.charging);
                subCol = (t.hvKw !== null && t.hvKw > 55) ? COL.amber : COL.cyan;
            } else {
                const rpmLive = (typeof t.rpm === 'number' && isFinite(t.rpm) && t.rpm > 0)
                    ? Math.round(t.rpm)
                    : null;
                const rpmStr = rpmLive !== null ? String(rpmLive) : '--';
                if (profile.isCold && profile.coldCeilingRpm) {
                    const ceilRpm = Math.round(profile.coldCeilingRpm);
                    subText = rpmStr + ' / ' + ceilRpm + ' RPM';
                    subCol = (rpmLive !== null && rpmLive >= ceilRpm) ? COL.amber : COL.white;
                } else if (typeof t.boostBar === 'number' && isFinite(t.boostBar)) {
                    const bFmt = formatPress(t.boostBar, true, units);
                    subText = rpmStr + ' RPM  ' + bFmt.value + ' ' + String(bFmt.unit || 'psi').toUpperCase();
                    subCol = COL.white;
                } else {
                    subText = rpmStr + ' RPM';
                    subCol = COL.white;
                }
            }
        }

        const inNormalD = t.stage === 'D' && t.program !== 'S' && t.program !== 'M' &&
            typeof t.gear === 'number' && t.gear >= 1 && t.gear <= 8;
        const dGearText = inNormalD ? ('D' + Math.round(t.gear)) : '';
        const isParked = t.stage === 'P' || (
            !t.stage &&
            (t.speedKmh === null || t.speedKmh === undefined || t.speedKmh < 0.5) &&
            !(typeof t.gear === 'number' && t.gear !== 0)
        );
        const fg = typeof t.frictionG === 'number' && isFinite(t.frictionG) ? Math.max(0, t.frictionG) : 0;
        const brakeHold = !isParked && Boolean(t.brakeHold) && fg <= 0.02;
        const brakeLit = (!isParked && fg > 0.02) ? clamp(Math.round((fg / 0.55) * 20), 1, 20) : (brakeHold ? 1 : 0);
        const showBrakeRail = brakeMode !== 'off' && !isParked;

        const iceChargeBarEnabled = s.iceChargeBar !== false;
        const isPhevForIceChg = Boolean(profile && profile.vehicleType === 'phev');
        const iceChgEval = (iceChargeBarEnabled && isPhevForIceChg && !isCharging && !isParked && brakeLit === 0)
            ? computeIceBatteryCharge({
                rpm: t.rpm,
                engineOn: Boolean(profile && profile.engineOn),
                speedKmh: t.speedKmh,
                hvKw: t.hvKw,
                pedalPct: t.pedalPct,
                torqueNm: t.torqueNm,
                recupPct: t.recupPct,
                gLong: t.gLong,
                driverBraking: t.driverBraking,
                absActive: t.absActive,
                frictionG: fg,
                brakeBar: t.brakeBar,
                isDfco: Boolean(eff.isDfco),
                pureRegen: Boolean(t.pureRegen),
                plugConnected: Boolean(chg && chg.plugConnected),
                chargingActive: isCharging,
            }, this._iceChgState, now)
            : computeIceBatteryCharge({ chargingActive: true }, this._iceChgState, now);
        const iceChargeActive = Boolean(iceChgEval && iceChgEval.active && brakeLit === 0);
        const iceChargeKw = iceChargeActive ? iceChgEval.chargeKw : 0;
        const iceChargeLit = iceChargeActive ? clamp(Math.round((iceChargeKw / ICE_CHARGE_MAX_KW) * 20), 1, 20) : 0;

        const showHvSocGauge = Boolean(
            panelAllowed &&
            hvSocGaugeEnabled &&
            profile && profile.vehicleType === 'phev' &&
            typeof t.soc === 'number' && isFinite(t.soc)
        );
        const showCabinTemp = Boolean(
            panelAllowed &&
            cabinTempEnabled &&
            typeof t.cabinTempC === 'number' && isFinite(t.cabinTempC)
        );
        const showHudHeadway = Boolean(
            showHud &&
            hudHeadwayMode !== 'off' &&
            t.leadVehicle && t.leadVehicle.active
        );

        const bsGearStr = gearDisplay === 'below_speed' ? dGearText : '';
        const showBelowSpeed = showBsLine1 || showBsLine2 || Boolean(bsGearStr);

        const turnCardCfg = (layoutState.widgets && layoutState.widgets.guidance_turn_card) || {};
        const trigRaw = s.turnCardTriggerM !== undefined ? s.turnCardTriggerM
            : (turnCardCfg.autoTriggerDistanceMeters !== undefined ? turnCardCfg.autoTriggerDistanceMeters : 350);
        const turnAlwaysOn = s.clusterTurnCard === 'always' || trigRaw === 'always' || Number(trigRaw) >= 99999;
        const turnTriggerM = turnAlwaysOn ? 999999 : clamp(Number(trigRaw) || 350, 50, 5000);
        const turnHoldMs = Math.round(clamp(Number(turnCardCfg.dismissDelaySeconds) || 2.5, 0, 15) * 1000);
        const turnDistMeters = (hn && typeof hn.turnDistMeters === 'number' && isFinite(hn.turnDistMeters)) ? hn.turnDistMeters : null;
        // NavTracker.snapshot() stores the maneuver object in `hn.show` (`hn.guide` is the provider string like 'CAR_PLAY').
        const rawGuideObj = (routeOn && hn && hn.show && typeof hn.show === 'object') ? hn.show : null;
        let activeGuide = rawGuideObj;
        if (rawGuideObj && turnDistMeters !== null && turnDistMeters >= 0) {
            const existingM = metres(rawGuideObj);
            if (!rawGuideObj.dist || (existingM !== null && Math.abs(existingM - turnDistMeters) >= 20 && turnDistMeters < 1000)) {
                let dTxt;
                let uTxt;
                if (units && units.distUnit === 'mi') {
                    const ft = Math.round(turnDistMeters * 3.28084);
                    if (ft >= 528) {
                        const mi = turnDistMeters / 1609.344;
                        dTxt = mi >= 10 ? mi.toFixed(0) : mi.toFixed(1);
                        uTxt = 'mi';
                    } else {
                        dTxt = String(Math.max(10, Math.round(ft / 10) * 10));
                        uTxt = 'ft';
                    }
                } else if (turnDistMeters >= 1000) {
                    const km = turnDistMeters / 1000;
                    dTxt = km >= 10 ? km.toFixed(0) : km.toFixed(1);
                    uTxt = 'km';
                } else {
                    dTxt = String(Math.max(10, Math.round(turnDistMeters / 10) * 10));
                    uTxt = 'm';
                }
                activeGuide = Object.assign({}, rawGuideObj, { dist: dTxt, unit: uTxt });
            }
        }
        let turnCardGuide = null;
        if (!routeOn || !clusterTurnCardEnabled || !panelAllowed) {
            this._turnCardHold = null;
        } else if (activeGuide && (turnAlwaysOn || (turnDistMeters !== null && turnDistMeters <= turnTriggerM))) {
            this._turnCardHold = { untilMs: now + turnHoldMs, guide: activeGuide };
            turnCardGuide = activeGuide;
        } else if (this._turnCardHold && now < this._turnCardHold.untilMs) {
            turnCardGuide = activeGuide || this._turnCardHold.guide;
        } else {
            this._turnCardHold = null;
        }

        const showClusterSpeed = Boolean(panelAllowed && clusterSpeedEnabled);
        const showClusterTurnCard = Boolean(panelAllowed && clusterTurnCardEnabled && turnCardGuide);
        const clusterEtaObj = (routeOn && hn && hn.eta && (hn.eta.text || typeof hn.eta.remainMeters === 'number')) ? hn.eta : null;
        const showClusterEtaPill = Boolean(panelAllowed && clusterEtaEnabled && clusterEtaObj);

        this.lastSummary = {
            hero, heroCol, heroUnitCol, subText, subCol, subBolt, inNormalD, dGearText,
            isParked, isCharging, showBrakeRail, brakeHold,
            belowSpeedLine1, belowSpeedLine2, showBelowSpeed,
            iceChargeActive, iceChargeKw, iceChargeLit,
            panelAllowed, showHud, showOwnHudNav, showHudRoad, showHudHeadway, hudHeadwayMode,
            showHvSocGauge, showCabinTemp,
            showClusterSpeed, showClusterTurnCard, showClusterEtaPill, turnDistMeters,
            hostModeActive: this.hostModeActive,
            userMapMode: this.userMapMode,
            isNativeMapMode,
            isPureNativeMode,
            isCenterPanelMode,
            isOuterOnlyMode,
            nativePanelReleased,
            standbyRescue: this.standbyRescue,
            crHostLayers: this.crHostLayers,
            crHostMask: this.crHostMask,
            crRenderState: this.crRenderState,
            bezelMaskMode: this.bezelMaskMode,
            mapFeatherPx: this.mapFeatherPx || 96,
            hostingState: this.hostingState,
            hostingReason: this.hostingReason,
            mapHostedInto: this.mapHostedInto,
            wazeStatus: this.wazeStatus,
            wocHudOverlay, hudYieldedToNav, hudYieldReason,
            showFallbackMap: showMapOverlay, showMapOverlay, clusterSlotMode,
            rightWidgetMode, rightWidgetPage,
            activeAlert, alertDismissed: this._alertDismissed, fontSource: getFontSource(),
            brakeMode, brakeLit, frictionG: fg, brakeBar: t.brakeBar,
            cornerLeftMode, cornerRightMode,
            hudLine1, hudLine2, hudLine3,
        };

        // 1. CLUSTER PANEL LAYERS (slot 0x203)
        if (panelAllowed) {
            // 1a. Zone 1: Below Speed Indicator (392..606, 445..529; clear gap under speed & above traffic light sign)
            if (showBelowSpeed) {
                const bsRect = resolveWidgetRect(layoutState, 'below_speed', BELOW_SPEED_BASE, cx, cy, {
                    minX: 387, maxX: 412, minY: 433, maxY: 452,
                });
                const lBs = this._ensureOrLocal('below_speed', Object.assign({ target: 'panel', visible: true, z: 12 }, bsRect));
                this._paintBelowSpeed(lBs.cv, hero, heroCol, heroUnitCol, subText, subCol, subBolt, bsGearStr, gearDisplay === 'below_speed', 108, showBsLine1, showBsLine2);
                this._setVisible('below_speed', true);
                this._upload('below_speed');
            } else {
                this._setVisible('below_speed', false);
            }

            // 1a2. Frameless Digital Speed Overlay (372..592, 328..418 by default; wide free X/Y range)
            if (showClusterSpeed) {
                const spNx = clamp(Number(s.speedOverlayNudgeX) || 0, -300, 960);
                const spNy = clamp(Number(s.speedOverlayNudgeY) || 0, -300, 220);
                const spRect = resolveWidgetRect(layoutState, 'speed', SPEED_BASE, cx + spNx, cy + spNy, {
                    minX: 160, maxX: 1520, minY: 40, maxY: 540,
                });
                const lSpd = this._ensureOrLocal('speed', Object.assign({ target: 'panel', visible: true, z: 12 }, spRect));
                const spdFmt = formatSpeed(t.speedKmh, units);
                const spCfg = layoutState.widgets.speed || SPEED_BASE;
                const spKey = [spdFmt.value, spdFmt.unit, spCfg.fontSize || 72, spCfg.showUnit !== false ? 1 : 0, speedPlate, spRect.w, spRect.h].join('|');
                if (spKey !== lSpd._renderedKey || (this.cr && !lSpd.prevBuf)) {
                    this._paintClusterSpeed(lSpd.cv, spdFmt, spCfg.showUnit !== false, spCfg.fontSize || 72, speedPlate === 'glass');
                    lSpd._renderedKey = spKey;
                }
                this._setVisible('speed', true);
                this._upload('speed');
            } else {
                this._setVisible('speed', false);
            }

            // 1a3. Top-Center 5AU Pocket iOS Turn Card (760..1160, 18..114 by default; wide free X/Y range above GEAR_WIN)
            if (showClusterTurnCard) {
                const tcNx = clamp(Number(s.turnCardNudgeX) || 0, -520, 520);
                const tcNy = clamp(Number(s.turnCardNudgeY) || 0, -18, 500);
                const tcRect = resolveWidgetRect(layoutState, 'guidance_turn_card', TURN_CARD_BASE, cx + tcNx, cy + tcNy, {
                    minX: 240, maxX: 1720 - TURN_CARD_BASE.w, minY: 0, maxY: 520,
                });
                const lTc = this._ensureOrLocal('guidance_turn_card', Object.assign({ target: 'panel', visible: true, z: 15 }, tcRect));
                const tk = hudNavKey(turnCardGuide) + '|' + turnCardPlate + '|' + tcRect.w + 'x' + tcRect.h;
                if (tk !== lTc._renderedKey || (this.cr && !lTc.prevBuf)) {
                    this._paintClusterTurnCard(lTc.cv, turnCardGuide, units, turnCardPlate === 'glass');
                    lTc._renderedKey = tk;
                }
                this._setVisible('guidance_turn_card', true);
                this._upload('guidance_turn_card');
            } else {
                this._setVisible('guidance_turn_card', false);
            }

            // 1a5. Bottom-Center iOS Arrival ETA Capsule (760..1160, 628..674 by default; wide free X/Y with GEAR_WIN guard)
            if (showClusterEtaPill) {
                const epNx = clamp(Number(s.etaPillNudgeX) || 0, -520, 520);
                const epNy = clamp(Number(s.etaPillNudgeY) || 0, -560, 60);
                const epRect = resolveWidgetRect(layoutState, 'eta_pill', ETA_PILL_BASE, cx + epNx, cy + epNy, {
                    minX: 240, maxX: 1720 - ETA_PILL_BASE.w, minY: 60, maxY: 716 - ETA_PILL_BASE.h,
                });
                // Never allow ETA capsule to enter KOMBI4 GEAR_WIN (x=1380..1460, y=648..720)
                if (epRect.y + epRect.h > 646 && epRect.x + epRect.w > 1378) {
                    epRect.x = Math.max(240, 1378 - epRect.w);
                }
                const lEp = this._ensureOrLocal('eta_pill', Object.assign({ target: 'panel', visible: true, z: 14 }, epRect));
                const remMinKey = typeof clusterEtaObj.remainSec === 'number' ? Math.round(clusterEtaObj.remainSec / 60) : -1;
                const remKmKey = typeof clusterEtaObj.remainMeters === 'number' ? Math.round(clusterEtaObj.remainMeters / 100) : -1;
                const epKey = [clusterEtaObj.text || '', remMinKey, remKmKey, units.distUnit, etaPillPlate, epRect.w, epRect.h].join('|');
                if (epKey !== lEp._renderedKey || (this.cr && !lEp.prevBuf)) {
                    this._paintClusterEtaPill(lEp.cv, clusterEtaObj, units, etaPillPlate === 'glass');
                    lEp._renderedKey = epKey;
                }
                this._setVisible('eta_pill', true);
                this._upload('eta_pill');
            } else {
                this._setVisible('eta_pill', false);
            }

            // 1b. Zone 2: Shift Position Strictly Clear of KOMBI4 GEAR_WIN (1461..1487, 650..706; NEVER <= 1460)
            const showGearDigit = gearDisplay === 'next_to_d' && inNormalD;
            if (showGearDigit) {
                const gdRect = resolveWidgetRect(layoutState, 'gear_d', GEAR_D_BASE, cx, cy, {
                    minX: 1461, maxX: 1464, minY: 648, maxY: 654,
                });
                gdRect.x = Math.max(1461, gdRect.x);
                const lGd = this._ensureOrLocal('gear_d', Object.assign({ target: 'panel', visible: true, z: 14 }, gdRect));
                this._paintGearNextToD(lGd.cv, String(Math.round(t.gear)));
                this._setVisible('gear_d', true);
                this._upload('gear_d');
            } else {
                this._setVisible('gear_d', false);
            }

            // 1b2. Stacked 'CABIN' Interior Temperature (HVAC-mode colored):
            //   - ICE cars: x=1712..1763 (empty black pocket right of stock ambient +14.5°C [1510..1674] & left of 12V [1816+])
            //   - Metric PHEV cars: x=1170..1221 (left of COMFORT [1230+], clear of ETA pill [760..1160], +14.5°C & EV_RANGE [1680..1814])
            //   - US PHEV cars: x=1488..1539 (between gear_d [1461..1487] and shorter stock +57°F [1540+])
            if (showCabinTemp) {
                const isPhevCar = Boolean(profile && profile.vehicleType === 'phev');
                const isMetricTemp = Boolean(units && units.tempUnit === 'C');
                const defaultCabinX = !isPhevCar ? 1712 : (isMetricTemp ? 1170 : 1488);
                const cabinCustom = Boolean(layoutState && layoutState.customKeys && layoutState.customKeys.cabin_temp);
                const cabinBase = Object.assign({}, CABIN_TEMP_BASE, { x: defaultCabinX });
                const minCabinX = defaultCabinX === 1488 ? 1487 : defaultCabinX - 12;
                const maxCabinX = defaultCabinX === 1488 ? 1489 : defaultCabinX + 12;
                const ctRect = cabinCustom
                    ? resolveWidgetRect(layoutState, 'cabin_temp', cabinBase, cx, cy, null)
                    : {
                        x: clamp(defaultCabinX + cx, minCabinX, maxCabinX),
                        y: clamp(CABIN_TEMP_BASE.y + cy, 650, 658),
                        w: CABIN_TEMP_BASE.w,
                        h: CABIN_TEMP_BASE.h,
                    };
                const lCt = this._ensureOrLocal('cabin_temp', Object.assign({ target: 'panel', visible: true, z: 14 }, ctRect));
                this._paintCabinTemp(lCt.cv, t.cabinTempC, units, t.cabinHvacMode);
                this._setVisible('cabin_temp', true);
                this._upload('cabin_temp');
            } else {
                this._setVisible('cabin_temp', false);
            }

            // 1c. Zone 3: Slim Friction Brake Force Rail (1280..1576, 609..640; hidden in Park; alerts now live in right_widget!)
            const brRect = resolveWidgetRect(layoutState, 'brake_rail', BRAKE_RAIL_BASE, cx, cy, {
                minX: 1276, maxX: 1288, minY: 599, maxY: 617,
            });
            const lBr = this._ensureOrLocal('brake_rail', Object.assign({ target: 'panel', visible: showBrakeRail, z: 13 }, brRect));
            if (showBrakeRail) {
                this._paintBrakeRail(
                    lBr.cv, fg, brakeLit, Boolean(t.absActive),
                    brakeMode === 'bar_num' && (brakeLit === 0 || !brakeHold),
                    t.brakeBar, iceChargeKw, iceChargeLit
                );
                this._setVisible('brake_rail', true);
                this._upload('brake_rail');
            } else {
                this._setVisible('brake_rail', false);
            }

            // 1d. Zone 4: Bottom-Left Oil + Coolant Temperatures (8..124, 643..709)
            const clRect = resolveWidgetRect(layoutState, 'corner_left', CORNER_LEFT_BASE, cx, cy, {
                minX: 6, maxX: 9, minY: 643, maxY: 648,
            });
            const lCl = this._ensureOrLocal('corner_left', Object.assign({ target: 'panel', visible: cornerLeftMode !== 'off', z: 12 }, clRect));
            if (cornerLeftMode !== 'off') {
                this._paintCornerLeft(lCl.cv, t, units, cornerLeftMode, Number(s.coldOilC) || 75);
                this._setVisible('corner_left', true);
                this._upload('corner_left');
            } else {
                this._setVisible('corner_left', false);
            }

            // 1e. Zone 5: Bottom-Right 12V Battery % / Vital (1816..1914, 646..712; separated from battery icon)
            const crRect = resolveWidgetRect(layoutState, 'corner_right', CORNER_RIGHT_BASE, cx, cy, {
                minX: 1815, maxX: 1820, minY: 644, maxY: 651,
            });
            const lCr = this._ensureOrLocal('corner_right', Object.assign({ target: 'panel', visible: cornerRightMode !== 'off', z: 12 }, crRect));
            if (cornerRightMode !== 'off') {
                this._paintCornerRight(lCr.cv, t, units, cornerRightMode);
                this._setVisible('corner_right', true);
                this._upload('corner_right');
            } else {
                this._setVisible('corner_right', false);
            }

            // 1e2. PHEV HV Battery SoC % Overlay Inside HV Battery Sub-Gauge (1796..1888, 452..508; well above 50 mark)
            if (showHvSocGauge) {
                const hgRect = resolveWidgetRect(layoutState, 'hv_soc_gauge', HV_SOC_GAUGE_BASE, cx, cy, {
                    minX: 1788, maxX: 1804, minY: 446, maxY: 458,
                });
                const lHg = this._ensureOrLocal('hv_soc_gauge', Object.assign({ target: 'panel', visible: true, z: 15 }, hgRect));
                this._paintHvSocGauge(lHg.cv, t.soc);
                this._setVisible('hv_soc_gauge', true);
                this._upload('hv_soc_gauge');
            } else {
                this._setVisible('hv_soc_gauge', false);
            }

            // 1f. Zone 6: Right-Wing Charging / Media / Trip / TPMS Widget (LOCKED at calibrated chyiz v0.9.3 geometry)
            if (rightWidgetPage !== 'off') {
                const rwRect = {
                    x: clamp(RIGHT_WIDGET_BASE.x + cx, 1232, 1256),
                    y: clamp(RIGHT_WIDGET_BASE.y + cy, 86, 96),
                    w: RIGHT_WIDGET_BASE.w,
                    h: RIGHT_WIDGET_BASE.h,
                };
                const lRw = this._ensureOrLocal('right_widget', Object.assign({ target: 'panel', visible: true, z: 11 }, rwRect));
                if (rightWidgetPage === 'charging') {
                    const hvVKey = (typeof t.hvVolts === 'number' && isFinite(t.hvVolts)) ? Math.round(t.hvVolts) : -1;
                    const battTKey = (typeof t.battTempC === 'number' && isFinite(t.battTempC)) ? Math.round(t.battTempC) : -99;
                    const rwKey = 'C|' + [
                        chg ? chg.finishTimeText : '--:--',
                        chg ? chg.remainText : '',
                        chg && chg.plugLocked ? 1 : 0,
                        chg && chg.preconActive ? 1 : 0,
                        hvVKey,
                        battTKey,
                        units.tempUnit,
                    ].join('|');
                    if (rwKey !== this.lastRightWidgetKey || !lRw.prevBuf) {
                        this._paintRightCharging(lRw.cv, chg, t, units);
                        this.lastRightWidgetKey = rwKey;
                    }
                } else if (rightWidgetPage === 'media') {
                    const remKey = media && typeof media.remainSec === 'number' ? Math.ceil(media.remainSec) : -1;
                    const totKey = media && typeof media.totalSec === 'number' ? Math.floor(media.totalSec) : -1;
                    const tElapsed = media ? Math.max(0, now - (media.trackSinceMs || 0)) : 0;
                    const titleInfo = (media && media.active && media.title)
                        ? paginateTitle(lRw.cv, media.title, 392, [42, 38, 35, 32], 32, tElapsed)
                        : null;
                    const rwKey = 'M|' + rwRect.x + ',' + rwRect.y + '|' + (media
                        ? [media.active ? 1 : 0, media.playing ? 1 : 0, media.title, media.artist, media.coverRev,
                            titleInfo ? titleInfo.page : 0, remKey, totKey].join('|')
                        : 'none');
                    if (rwKey !== this.lastRightWidgetKey || !lRw.prevBuf) {
                        this._paintRightMedia(lRw.cv, media, titleInfo, rwRect.x, rwRect.y);
                        this.lastRightWidgetKey = rwKey;
                    }
                } else if (rightWidgetPage === 'tpms') {
                    const tp = (rawAlert && rawAlert.previewTpms) || t.tpms || {};
                    const cKey = ['FL', 'FR', 'RL', 'RR'].map((c) => {
                        const it = tp[c];
                        if (!it) return '-';
                        const pb = typeof it.pressureBar === 'number' ? Math.round(it.pressureBar * 20) : -1;
                        const tc = typeof it.tempC === 'number' ? Math.round(it.tempC) : -99;
                        return pb + ':' + tc;
                    }).join(',');
                    const rwKey = 'P|' + [
                        units.pressUnit, units.tempUnit, cKey,
                        rawAlert ? [rawAlert.id, rawAlert.severity, rawAlert.title || rawAlert.label, rawAlert.heroVal || '', rawAlert.detail || ''].join(':') : 'ok',
                        Math.round(t.oilTempC || -99), Math.round(t.coolantTempC || -99),
                        typeof t.v12 === 'number' ? t.v12.toFixed(1) : '--',
                        typeof t.soc12 === 'number' ? Math.round(t.soc12) : -1,
                    ].join('|');
                    if (rwKey !== this.lastRightWidgetKey || !lRw.prevBuf) {
                        this._paintRightTpmsAlerts(lRw.cv, t, rawAlert, units);
                        this.lastRightWidgetKey = rwKey;
                    }
                } else {
                    const rwKey = 'T|' + [
                        units.system, units.tempUnit, units.distUnit,
                        Math.round(t.erangeKm || -1), Math.round(t.frangeKm || -1),
                        Math.round((t.tripDistKm || -1) * 10), t.tripMinutes || -1,
                        Math.round(t.gearboxOilC || -99), Math.round(t.battTempC || -99),
                        Math.round(t.iatC || -99), typeof t.v12 === 'number' ? t.v12.toFixed(1) : '--',
                        typeof t.soc12 === 'number' ? Math.round(t.soc12) : -1,
                        hero.value, hero.unit,
                    ].join('|');
                    if (rwKey !== this.lastRightWidgetKey || !lRw.prevBuf) {
                        this._paintRightTrip(lRw.cv, t, hero, profile, units);
                        this.lastRightWidgetKey = rwKey;
                    }
                }
                this._setVisible('right_widget', true);
                this._upload('right_widget');
            } else {
                this._setVisible('right_widget', false);
            }
        } else {
            PANEL_ALL_LAYERS.forEach((n) => this._setVisible(n, false));
        }

        // 2a. HUD FULL-WIDTH TOP-ROW ROAD + HIGHWAY EXIT BADGE BANNER (544x38 at x=132..676, y=100..138)
        const hudTopY = clamp(HUD_BASE.y + hy, 100, 102);
        if (showHudRoad) {
            const roadX = clamp(HUD_ROAD_BASE.x + hx, 120, 680 - HUD_ROAD_W);
            const lHudRoad = this._ensureOrLocal('hud_road', {
                target: 'hud', klass: 'overlay', x: roadX, y: hudTopY, w: HUD_ROAD_W, h: HUD_ROAD_H, visible: true, z: 14,
            });
            const rk = hudRoadKey(hn.show);
            if (rk !== this.lastHudRoadKey || !lHudRoad.prevBuf) {
                drawHudRoadBanner(lHudRoad.cv, hn.show);
                this.lastHudRoadKey = rk;
            }
            this._setVisible('hud_road', true);
            this._upload('hud_road');
        } else {
            this._setVisible('hud_road', false);
        }

        // 2b. HUD TELEMETRY LAYER (268x100 at y=100..200 <= 202 ACC; uniform non-jumping layout below hud_road & strictly left of hud_headway)
        const hudX = clamp(HUD_BASE.x + hx, 120, 140);
        const lHud = this._ensureOrLocal('hud_main', {
            target: 'hud', klass: 'overlay', x: hudX, y: hudTopY, w: HUD_BASE.w, h: HUD_BASE.h, visible: showHud, z: 12,
        });
        if (showHud) {
            this._paintHud(
                lHud.cv,
                [hudLine1, hudLine2, hudLine3],
                hero, heroCol, heroUnitCol, subText, subCol, subBolt,
                gearDisplay !== 'off' ? dGearText : '',
                t, profile, units, fg, brakeLit, brakeHold, activeAlert,
                showHudRoad, showHudHeadway, iceChargeKw
            );
            this._setVisible('hud_main', true);
            this._upload('hud_main');
        } else {
            this._setVisible('hud_main', false);
        }

        // 2b2. HUD LEAD-CAR HEADWAY BADGE (120x41 at x=284..404 < 405 nav, y=139..180 > 138 road & < 202 ACC)
        if (showHudHeadway) {
            const hwX = clamp(HUD_HEADWAY_BASE.x + hx, 268, 404 - HUD_HEADWAY_BASE.w);
            const hwMinY = hudTopY + HUD_ROAD_H + 1;
            const hwY = clamp(HUD_HEADWAY_BASE.y + hy, hwMinY, 201 - HUD_HEADWAY_BASE.h);
            const lHudHw = this._ensureOrLocal('hud_headway', {
                target: 'hud', klass: 'overlay', x: hwX, y: hwY, w: HUD_HEADWAY_BASE.w, h: HUD_HEADWAY_BASE.h, visible: true, z: 13,
            });
            this._paintHudHeadway(lHudHw.cv, t.leadVehicle, units, hudHeadwayMode);
            this._setVisible('hud_headway', true);
            this._upload('hud_headway');
        } else {
            this._setVisible('hud_headway', false);
        }

        // 2c. HUD NAVIGATION LAYER (264x232 right-side slot x=412..676, y=140..372 below road banner; yields for mini-map)
        if (showOwnHudNav) {
            const navX = clamp(HUD_NAV_BASE.x + hx, 406, 680 - HUD_NAV_W);
            const baseNavY = showHudRoad ? HUD_NAV_BASE.y : 116;
            const navY = clamp(baseNavY + hy, showHudRoad ? (hudTopY + HUD_ROAD_H + 1) : 100, 380 - HUD_NAV_H);
            const lHudNav = this._ensureOrLocal('hud_nav', {
                target: 'hud', klass: 'overlay', x: navX, y: navY, w: HUD_NAV_W, h: HUD_NAV_H, visible: true, z: 13,
            });
            const nk = hudNavKey(hn.show) + '|hr=' + (showHudRoad ? 1 : 0);
            if (nk !== this.lastHudNavKey || !lHudNav.prevBuf) {
                drawHudNav(lHudNav.cv, hn.show, { hideRoad: showHudRoad });
                this.lastHudNavKey = nk;
            }
            this._setVisible('hud_nav', true);
            this._upload('hud_nav');
        } else {
            this._setVisible('hud_nav', false);
        }

        // 3. MAP SLOT SIDE-BOTTOM OVERLAYS (0x100, contend: false — optional Map-Slot-Only mode)
        if (showMapOverlay) {
            if (showBelowSpeed) {
                const msRect = {
                    x: clamp(MAP_SPEED_RECT.x + cx, 8, 32),
                    y: clamp(MAP_SPEED_RECT.y + cy, 313, 335),
                    w: MAP_SPEED_RECT.w,
                    h: MAP_SPEED_RECT.h,
                };
                const lMapSpd = this._ensureOrLocal('map_speed', {
                    target: 'map', klass: 'overlay', contend: false,
                    x: msRect.x, y: msRect.y, w: msRect.w, h: msRect.h,
                    visible: true, z: 20,
                });
                this._paintBelowSpeed(lMapSpd.cv, hero, heroCol, heroUnitCol, subText, subCol, subBolt, bsGearStr, gearDisplay === 'below_speed', 84, showBsLine1, showBsLine2);
                this._setVisible('map_speed', true);
                this._upload('map_speed');
            } else {
                this._setVisible('map_speed', false);
            }

            const mlRect = {
                x: clamp(MAP_LEFT_RECT.x + cx, 176, 204),
                y: clamp(MAP_LEFT_RECT.y + cy, 368, 392),
                w: MAP_LEFT_RECT.w,
                h: MAP_LEFT_RECT.h,
            };
            const lMapLeft = this._ensureOrLocal('map_left', {
                target: 'map', klass: 'overlay', contend: false,
                x: mlRect.x, y: mlRect.y, w: mlRect.w, h: mlRect.h,
                visible: cornerLeftMode !== 'off', z: 20,
            });
            if (cornerLeftMode !== 'off') {
                this._paintMapLeft(lMapLeft.cv, t, units, cornerLeftMode, Number(s.coldOilC) || 75);
                this._setVisible('map_left', true);
                this._upload('map_left');
            } else {
                this._setVisible('map_left', false);
            }

            const mrRect = {
                x: clamp(MAP_RIGHT_RECT.x + cx, 664, 696),
                y: clamp(MAP_RIGHT_RECT.y + cy, 362, 386),
                w: MAP_RIGHT_RECT.w,
                h: MAP_RIGHT_RECT.h,
            };
            const alertMap = activeAlert;
            const gearOnMapRight = gearDisplay === 'next_to_d' ? dGearText : '';
            const showMapRight = Boolean(showBrakeRail || cornerRightMode !== 'off' || gearOnMapRight || alertMap);
            const lMapRight = this._ensureOrLocal('map_right', {
                target: 'map', klass: 'overlay', contend: false,
                x: mrRect.x, y: mrRect.y, w: mrRect.w, h: mrRect.h,
                visible: showMapRight, z: 20,
            });
            if (showMapRight) {
                this._paintMapRight(
                    lMapRight.cv, gearOnMapRight, t, units, cornerRightMode,
                    showBrakeRail, brakeMode === 'bar_num' && (brakeLit === 0 || !brakeHold),
                    fg, brakeLit, Boolean(t.absActive), alertMap, iceChargeKw
                );
                this._setVisible('map_right', true);
                this._upload('map_right');
            } else {
                this._setVisible('map_right', false);
            }
        } else {
            MAP_LAYER_NAMES.forEach((n) => this._setVisible(n, false));
        }
    }

    _ensureOrLocal(name, opts) {
        if (this.cr) return this._ensureLayer(name, opts);
        if (!this.layers[name]) {
            this.layers[name] = {
                ref: Object.keys(this.layers).length + 1,
                target: opts.target,
                rect: { x: opts.x, y: opts.y, w: opts.w, h: opts.h },
                cv: new Canvas(opts.w, opts.h),
                prevBuf: null,
                visible: opts.visible !== false,
            };
        } else {
            this.layers[name].rect.x = opts.x;
            this.layers[name].rect.y = opts.y;
        }
        return this.layers[name];
    }

    _paintBelowSpeed(cv, hero, heroCol, heroUnitCol, subText, subCol, subBolt, gearStr, reserveGearSlot, heroRightX, showLine1, showLine2) {
        cv.clear(COL.clear);
        const drawL1 = showLine1 !== false;
        const drawL2 = showLine2 !== false;
        const baseRx = typeof heroRightX === 'number' ? heroRightX : 108;
        const heroValStr = String(hero.value || '');
        const heroValW = cv.textWidth(heroValStr, 44, { font: 'num' });
        const heroBoltH = 28;
        const heroBoltW = hero.bolt ? (boltWidth(heroBoltH) + 5) : 0;
        const rx = drawL1 ? Math.max(baseRx, 6 + heroBoltW + Math.ceil(heroValW)) : baseRx;
        if (drawL1) {
            if (hero.bolt) {
                const bx = Math.max(4, Math.round(rx - heroValW - heroBoltW));
                drawLightningBolt(cv, bx, 13, heroCol, heroBoltH);
            }
            drawTextOutline(cv, heroValStr, rx, 43, 44, heroCol, { font: 'num', align: 'right' });
            const unitSize = String(hero.unit || '').length > 6 ? 17 : 21;
            drawTextOutline(cv, hero.unit, rx + 7, 39, unitSize, heroUnitCol || COL.softBlue, { font: 'bold', align: 'left' });
        }

        const line2Y = drawL1 ? 75 : 44;
        if (drawL2) {
            const subBoltH = 17;
            const subBoltPad = subBolt ? (boltWidth(subBoltH) + 4) : 0;
            if (reserveGearSlot) {
                const sFit = fitTextLine(cv, subText, Math.max(40, rx + 16 - subBoltPad), [21, 19, 17, 15], 'bold');
                const sw = drawTextOutline(cv, sFit.text, rx + 22, line2Y, sFit.size, subCol, { font: 'bold', align: 'right' });
                if (subBolt) {
                    const bx = Math.max(2, Math.round(rx + 22 - sw - subBoltPad));
                    drawLightningBolt(cv, bx, line2Y - subBoltH + 1, subCol, subBoltH);
                }
                if (gearStr) {
                    drawTextOutline(cv, gearStr, rx + 32, line2Y, 22, COL.white, { font: 'bold', align: 'left' });
                }
            } else {
                const sFit = fitTextLine(cv, subText, Math.max(40, cv.w - 12 - subBoltPad), [22, 20, 18, 16], 'bold');
                if (subBolt) {
                    const tw = cv.textWidth(sFit.text, sFit.size, { font: 'bold' });
                    const totalW = subBoltPad + tw;
                    const x0 = Math.max(4, Math.round((cv.w - totalW) / 2));
                    drawLightningBolt(cv, x0, line2Y - subBoltH + 1, subCol, subBoltH);
                    drawTextOutline(cv, sFit.text, x0 + subBoltPad, line2Y, sFit.size, subCol, { font: 'bold', align: 'left' });
                } else {
                    drawTextOutline(cv, sFit.text, Math.round(cv.w / 2), line2Y, sFit.size, subCol, { font: 'bold', align: 'center' });
                }
            }
        } else if (gearStr) {
            drawTextOutline(cv, gearStr, Math.round(cv.w / 2), line2Y, 24, COL.white, { font: 'bold', align: 'center' });
        }
    }

    _paintGearNextToD(cv, digitStr) {
        cv.clear(COL.clear);
        if (!digitStr) return;
        drawTextOutline(cv, digitStr, 0, 46, 38, COL.white, { font: 'bold', align: 'left' });
        // Trim left glyph side-bearing so the first visible ink pixel sits flush at x=0
        // (panel x=1461, literally 1px outside KOMBI4 GEAR_WIN 1380..1460) for tightest safe spacing to 'D'.
        const d = cv.d;
        const w = cv.w;
        const h = cv.h;
        let minX = w;
        for (let y = 0; y < h; y++) {
            const row = y * w * 4;
            for (let x = 0; x < minX; x++) {
                if (d[row + x * 4 + 3] > 0) {
                    minX = x;
                    break;
                }
            }
        }
        if (minX > 0 && minX < w) {
            for (let y = 0; y < h; y++) {
                const row = y * w * 4;
                for (let x = 0; x < w; x++) {
                    const dst = row + x * 4;
                    if (x + minX < w) {
                        const src = row + (x + minX) * 4;
                        d[dst] = d[src];
                        d[dst + 1] = d[src + 1];
                        d[dst + 2] = d[src + 2];
                        d[dst + 3] = d[src + 3];
                    } else {
                        d[dst] = 0;
                        d[dst + 1] = 0;
                        d[dst + 2] = 0;
                        d[dst + 3] = 0;
                    }
                }
            }
        }
    }

    /**
     * Option A: Unboxed OEM two-row stacked interior cabin temperature (`51x50` at 1488..1539),
     * matching `12V` and `SOC` micro-header hierarchy, with HVAC thermal color coding:
     *   - `'cooling'` (AC cooling) -> Blue (`#5bc8ff`)
     *   - `'heating'` (Heating/Defrost) -> Orange (`#ff9f43`)
     *   - `'fan'` / `'off'` / `null` -> White (`#f2f5fa`)
     */
    _paintCabinTemp(cv, cabinTempC, units, hvacMode) {
        cv.clear(COL.clear);
        const tf = formatTemp(cabinTempC, units);
        const numPart = String(tf.value);
        const unitPart = tf.unit;
        const pal = cabinHvacPalette(hvacMode);
        const cx = Math.round(cv.w / 2);

        drawTextOutline(cv, tr('CABIN'), cx, 17, 11, '#9ab0c9', { font: 'bold', align: 'center' });

        let numSz = 20;
        let unitSz = 14;
        let nw = cv.textWidth(numPart, numSz, { font: 'bold' });
        let uw = cv.textWidth(unitPart, unitSz, { font: 'bold' });
        if (nw + uw + 1 > cv.w - 3) {
            numSz = 18;
            unitSz = 13;
            nw = cv.textWidth(numPart, numSz, { font: 'bold' });
            uw = cv.textWidth(unitPart, unitSz, { font: 'bold' });
        }
        const total = nw + uw + 1;
        const x0 = Math.max(1, Math.round(cx - total / 2));
        drawTextOutline(cv, numPart, x0, 42, numSz, pal.val, { font: 'bold', align: 'left' });
        drawTextOutline(cv, unitPart, x0 + nw + 1, 42, unitSz, pal.unit, { font: 'bold', align: 'left' });
    }

    /**
     * PHEV-only HV Battery State of Charge (%) centered in the upper dark pocket of the bottom-right HV battery gauge,
     * with the 'SOC' micro-label tucked tightly above the digits and ample clearance above the '50' mark.
     */
    _paintHvSocGauge(cv, soc) {
        cv.clear(COL.clear);
        const pct = clamp(Math.round(soc), 0, 100);
        const col = pct <= 10 ? COL.red : (pct <= 20 ? COL.amber : COL.white);
        drawTextOutline(cv, 'SOC', 46, 20, 13, COL.tagBlue, { font: 'bold', align: 'center' });
        drawTextOutline(cv, pct + '%', 46, 47, 29, col, { font: 'num', align: 'center' });
    }

    _paintBrakeRail(cv, fg, litCount, absActive, showNum, brakeBar, iceChargeKw, iceChargeLit) {
        cv.clear(COL.clear);
        const SEG_N = 20;
        const barX0 = 2;
        const barX1 = 294;
        const segW = (barX1 - barX0) / SEG_N;
        const chgLit = (litCount === 0 && typeof iceChargeLit === 'number' && iceChargeLit > 0) ? iceChargeLit : 0;

        for (let i = 0; i < SEG_N; i++) {
            const sx1 = Math.round(barX1 - i * segW) - 1;
            const sx0 = Math.round(barX1 - (i + 1) * segW) + 2;
            let col = COL.railDim;
            if (litCount > 0 && i < litCount) {
                col = i >= 13 ? COL.red : (i >= 6 ? COL.orange : COL.amber);
            } else if (chgLit > 0 && (SEG_N - 1 - i) < chgLit) {
                col = COL.cyan;
            }
            cv.fillRect(sx0, 21, Math.max(2, sx1 - sx0), 7, col);
        }

        if (litCount > 0 && showNum) {
            const hasBar = typeof brakeBar === 'number' && isFinite(brakeBar) && brakeBar >= 1.5;
            const valStr = hasBar ? (Math.round(brakeBar) + ' bar') : (fg.toFixed(2) + 'g');
            const lbl = (absActive ? 'ABS ' : '') + valStr;
            const col = (fg >= 0.36 || absActive) ? COL.red : COL.amber;
            drawTextOutline(cv, lbl, 3, 15, 15, col, { font: 'bold', align: 'left' });
        } else if (chgLit > 0 && showNum && typeof iceChargeKw === 'number' && isFinite(iceChargeKw)) {
            drawLightningBolt(cv, 3, 2, COL.cyan);
            drawTextOutline(cv, 'CHG +' + iceChargeKw.toFixed(1) + ' kW', 14, 15, 15, COL.cyan, { font: 'bold', align: 'left' });
        }
    }

    _paintCornerLeft(cv, t, units, mode, coldOilC) {
        cv.clear(COL.clear);
        const maxW = Math.max(40, cv.w - 6);
        const oil = formatTemp(t.oilTempC, units);
        const isColdOil = typeof t.oilTempC === 'number' && t.oilTempC < coldOilC;
        const isHotOil = typeof t.oilTempC === 'number' && t.oilTempC >= 118;
        const colOil = isColdOil ? COL.icyBlue : (isHotOil ? COL.amber : COL.white);
        const oilFit = fitTextLine(cv, tr('OIL') + ' ' + oil.text, maxW, [22, 20, 18, 16], 'bold');
        drawTextOutline(cv, oilFit.text, 3, 24, oilFit.size, colOil, { font: 'bold', align: 'left' });

        if (mode === 'oil_gbx') {
            const gbx = formatTemp(t.gearboxOilC, units);
            const colGbx = (typeof t.gearboxOilC === 'number' && t.gearboxOilC >= 105) ? COL.amber : COL.softBlue;
            const gbxFit = fitTextLine(cv, tr('GBX') + ' ' + gbx.text, maxW, [21, 19, 17, 15], 'bold');
            drawTextOutline(cv, gbxFit.text, 3, 53, gbxFit.size, colGbx, { font: 'bold', align: 'left' });
        } else {
            const cool = formatTemp(t.coolantTempC, units);
            const colCool = (typeof t.coolantTempC === 'number' && t.coolantTempC >= 108) ? COL.red : COL.softBlue;
            const coolFit = fitTextLine(cv, tr('CL') + ' ' + cool.text, maxW, [22, 20, 18, 16], 'bold');
            drawTextOutline(cv, coolFit.text, 3, 53, coolFit.size, colCool, { font: 'bold', align: 'left' });
        }
    }

    _paintCornerRight(cv, t, units, mode) {
        cv.clear(COL.clear);
        const m = formatCornerRightMetric(t, units, mode);
        drawTextOutline(cv, m.tag, cv.w - 4, 21, 16, COL.tagGray, { font: 'bold', align: 'right' });
        drawTextOutline(cv, m.valText, cv.w - 4, 55, 28, m.col, { font: 'num', align: 'right' });
    }

    /**
     * Re-implemented OEM-scale Right-Wing Media Playback Widget (536x520 at 1244,88):
     *   - Gauge-edge translucent album-art backdrop filling the right-wing face cleanly (y=91..599, out to x=1772)
     *   - Enlarged 176x176 album artwork centered vertically at world (1376, 186) -> (1552, 362) for balanced margins
     *   - Track title (42 -> 38 -> 35 -> 32px bold) + artist (31 -> 28 -> 25px) below artwork
     *   - Compact right-aligned remaining/PAUSED time (22px) above a '/' forward-slash cyan progress bar (356x12)
     */
    _paintRightMedia(cv, media, titleInfoPre, ox, oy) {
        cv.clear(COL.clear);
        const coverSide = COVER_SIDE; // 176
        const coverX = 132; // world x = 1244 + 132 = 1376
        const coverY = 98;  // world y = 88 + 98 = 186 -> 362 (balanced top/bottom margins inside wing)
        const fgCx = coverX + Math.round(coverSide / 2); // 220 (world x = 1464)

        const hasMedia = Boolean(media && media.active && media.title);
        const cover = hasMedia ? media.cover : null;

        if (cover && cover.d && cover.w === coverSide && cover.h === coverSide) {
            const bgBuf = buildStockBackdrop(cover, cv.w, cv.h, {
                ox: typeof ox === 'number' ? ox : 1244,
                oy: typeof oy === 'number' ? oy : 88,
                vx: fgCx,
                vy: 274,
            });
            if (bgBuf && bgBuf.length === cv.d.length) {
                bgBuf.copy(cv.d);
            }
            blitCoverArt(cv, coverX, coverY, cover, 4);
        } else {
            paintRadialGlow(cv, fgCx, coverY + Math.round(coverSide / 2), 138, [56, 178, 246], hasMedia ? 38 : 24);
            cv.roundRect(coverX, coverY, coverSide, coverSide, 4, COL.tileBg);
            cv.strokeRoundRect(coverX, coverY, coverSide, coverSide, 4, 2, COL.tileRim);
            cv.roundRect(fgCx - 29, coverY + 98, 26, 22, 11, COL.icyBlue);
            cv.roundRect(fgCx + 7, coverY + 90, 26, 22, 11, COL.icyBlue);
            cv.fillRect(fgCx - 8, coverY + 52, 5, 56, COL.icyBlue);
            cv.fillRect(fgCx + 28, coverY + 46, 5, 54, COL.icyBlue);
            cv.fillRect(fgCx - 8, coverY + 46, 41, 8, COL.icyBlue);
        }

        if (!hasMedia) {
            drawTextClean(cv, tr('No Media Playing'), fgCx, 338, 30, COL.mediaSub, { font: 'bold', align: 'center' });
            drawTextClean(cv, tr('Press BC for Trip Info'), fgCx, 376, 21, COL.tagGray, { font: 'label', align: 'center' });
            return;
        }

        const tInfo = titleInfoPre || paginateTitle(cv, media.title, 392, [42, 38, 35, 32], 32, 0);
        if (tInfo && tInfo.text) {
            drawTextClean(cv, tInfo.text, fgCx, 338, tInfo.size, COL.white, { font: 'bold', align: 'center' });
        }

        const subRaw = media.artist || media.source || '';
        if (subRaw) {
            const aFit = fitTextLine(cv, subRaw, 388, [31, 28, 25], 'label');
            drawTextClean(cv, aFit.text, fgCx, 382, aFit.size, '#dde3ec', { font: 'label', align: 'center' });
        }

        const barW = 356;
        const barX0 = fgCx - Math.round(barW / 2); // 42 -> world x = 1286..1642
        const barX1 = barX0 + barW;
        const barY = 440; // world y = 528..540 (balanced top/bottom clearance above stock '20 mi' at y=556 & 'Power %' at y=586)
        const barH = 12;

        if (typeof media.totalSec === 'number' && media.totalSec > 0 && typeof media.elapsedSec === 'number') {
            const frac = clamp(media.frac || 0, 0, 1);
            const fillW = Math.max(barH + 2, Math.round(barW * frac));
            const rem = typeof media.remainSec === 'number' ? Math.max(0, media.remainSec) : Math.max(0, media.totalSec - media.elapsedSec);
            const remLabel = media.playing === false ? (tr('PAUSED') + '  -' + formatDuration(rem)) : ('-' + formatDuration(rem));
            drawTextClean(cv, remLabel, barX1, 426, 22, media.playing === false ? COL.amber : '#e4eaf2', { font: 'label', align: 'right' });

            fillSlantBar(cv, barX0, barY, barW, barH, barW, COL.progTrack);
            fillSlantBar(cv, barX0, barY, barW, barH, fillW, media.playing === false ? [255, 179, 71, 255] : [69, 214, 255, 255]);
        } else {
            const liveTag = media.playing === false ? tr('PAUSED') : (media.source || tr('LIVE AUDIO'));
            drawTextClean(cv, liveTag, barX1, 428, 20, media.playing === false ? COL.amber : COL.mediaTime, { font: 'label', align: 'right' });
        }
    }

    /**
     * Right-Wing Trip & Powertrain Summary Widget (centered identically at world x=1438, BC-cycled):
     */
    _paintRightTrip(cv, t, hero, profile, units) {
        cv.clear(COL.clear);
        const midX = 194;
        const leftX = 48;
        const rightX = 340;
        const isMi = units.distUnit === 'mi';
        const dUnit = isMi ? ' mi' : ' km';
        const dScale = isMi ? 0.621371 : 1;

        drawTextOutline(cv, tr('TRIP & POWERTRAIN'), midX, 122, 17, COL.tagGray, { font: 'bold', align: 'center' });
        cv.fillRect(leftX, 134, rightX - leftX, 2, COL.divider);

        if (profile && profile.vehicleType === 'phev') {
            const evStr = (typeof t.erangeKm === 'number' && isFinite(t.erangeKm))
                ? (Math.round(t.erangeKm * dScale) + dUnit) : ('--' + dUnit);
            drawTextOutline(cv, tr('EV RANGE'), leftX, 168, 15, COL.tagBlue, { font: 'bold', align: 'left' });
            drawTextOutline(cv, evStr, leftX, 202, 28, COL.cyan, { font: 'num', align: 'left' });
        } else {
            drawTextOutline(cv, tr('EFFICIENCY'), leftX, 168, 15, COL.tagBlue, { font: 'bold', align: 'left' });
            drawTextOutline(cv, hero.value + ' ' + hero.unit, leftX, 202, 24, COL.white, { font: 'bold', align: 'left' });
        }

        const fuelStr = (typeof t.frangeKm === 'number' && isFinite(t.frangeKm))
            ? (Math.round(t.frangeKm * dScale) + dUnit) : ('--' + dUnit);
        drawTextOutline(cv, tr('FUEL RANGE'), rightX, 168, 15, COL.tagBlue, { font: 'bold', align: 'right' });
        drawTextOutline(cv, fuelStr, rightX, 202, 28, COL.white, { font: 'num', align: 'right' });

        let tripStr = '--';
        if (typeof t.tripDistKm === 'number' && isFinite(t.tripDistKm)) {
            tripStr = (t.tripDistKm * dScale).toFixed(1) + dUnit;
        } else if (typeof t.tripMinutes === 'number' && t.tripMinutes >= 0) {
            tripStr = Math.floor(t.tripMinutes / 60) + 'h ' + (t.tripMinutes % 60) + 'm';
        }
        drawTextOutline(cv, tr('TRIP DIST'), leftX, 254, 15, COL.tagBlue, { font: 'bold', align: 'left' });
        drawTextOutline(cv, tripStr, leftX, 288, 28, COL.white, { font: 'num', align: 'left' });

        const gbxStr = formatTemp(t.gearboxOilC, units).text;
        const gbxCol = (typeof t.gearboxOilC === 'number' && t.gearboxOilC >= 105) ? COL.amber : COL.white;
        drawTextOutline(cv, tr('GEARBOX'), rightX, 254, 15, COL.tagBlue, { font: 'bold', align: 'right' });
        drawTextOutline(cv, gbxStr, rightX, 288, 28, gbxCol, { font: 'num', align: 'right' });

        if (profile && profile.vehicleType === 'phev') {
            const btStr = formatTemp(t.battTempC, units).text;
            drawTextOutline(cv, tr('HV BATT'), leftX, 340, 15, COL.tagBlue, { font: 'bold', align: 'left' });
            drawTextOutline(cv, btStr, leftX, 374, 28, COL.white, { font: 'num', align: 'left' });
        } else {
            const iatStr = formatTemp(t.iatC, units).text;
            drawTextOutline(cv, tr('INTAKE'), leftX, 340, 15, COL.tagBlue, { font: 'bold', align: 'left' });
            drawTextOutline(cv, iatStr, leftX, 374, 28, COL.white, { font: 'num', align: 'left' });
        }

        const hasV12 = typeof t.v12 === 'number' && isFinite(t.v12);
        const hasSoc12 = typeof t.soc12 === 'number' && isFinite(t.soc12);
        let v12Str = '--';
        if (hasV12 && hasSoc12) {
            v12Str = t.v12.toFixed(1) + 'V ' + Math.round(t.soc12) + '%';
        } else if (hasSoc12) {
            v12Str = Math.round(t.soc12) + '%';
        } else if (hasV12) {
            v12Str = t.v12.toFixed(1) + 'V';
        }
        const v12Low = (hasV12 && t.v12 < 12.1) || (hasSoc12 && t.soc12 < 55);
        const v12Col = (hasSoc12 && t.soc12 < 40) ? COL.red : (v12Low ? COL.amber : COL.white);
        drawTextOutline(cv, tr('12V AUX'), rightX, 340, 15, COL.tagBlue, { font: 'bold', align: 'right' });
        drawTextOutline(cv, v12Str, rightX, 374, (hasV12 && hasSoc12) ? 23 : 28, v12Col, { font: (hasV12 && hasSoc12) ? 'bold' : 'num', align: 'right' });
    }

    /**
     * Right-Wing Tire Pressure, Temperature & Smart Anomaly Alerts Widget (`'tpms'`):
     *   - Normal view: 4-wheel top-down chassis diagram + FL / FR / RL / RR tire pressure & temperature only.
     *   - Alert view (auto-switched on anomaly or preview): prominent Amber/Red alert pill + highlighted
     *     4-wheel TPMS diagram (for tire alerts) OR large hero metric + explanation + advice (for Gearbox / 12V),
     *     plus `'Press BC to dismiss'`.
     */
    _paintRightTpmsAlerts(cv, t, alertObj, units) {
        cv.clear(COL.clear);
        const midX = 198;
        const leftX = 42;
        const rightX = 354;
        const bannerX0 = 48;
        const bannerW = 300;
        const isBar = units && units.pressUnit === 'bar';
        const pUnit = isBar ? ' bar' : ' psi';

        const fmtCornerPress = (bar) => {
            if (typeof bar !== 'number' || !isFinite(bar) || bar <= 0.1 || bar > 7) return '--' + pUnit;
            return isBar ? (bar.toFixed(1) + ' bar') : (Math.round(bar * 14.5038) + ' psi');
        };
        const fmtCornerTemp = (tc) => {
            if (typeof tc !== 'number' || !isFinite(tc) || tc < -45 || tc > 160) {
                return (units && units.tempUnit === 'F') ? '--\u00B0F' : '--\u00B0C';
            }
            return formatTemp(tc, units).text;
        };

        const cornerSeverity = (cornerKey, item) => {
            if (alertObj && (alertObj.id === 'tpms' || alertObj.id === 'tpms_temp') && alertObj.corner === cornerKey) {
                return alertObj.severity === 'red' ? 'red' : 'amber';
            }
            if (!item) return 'none';
            const p = item.pressureBar;
            const tgt = item.targetBar;
            const tc = item.tempC;
            if (typeof p === 'number' && isFinite(p) && p > 0.2 && p <= 6.5) {
                const hasTgt = typeof tgt === 'number' && isFinite(tgt) && tgt > 0.5 && tgt <= 6.5;
                const def = hasTgt ? (tgt - p) : (p < 1.72 ? 1.72 - p : 0);
                if (def >= 0.50 || p < 1.50) return 'red';
                if (def >= 0.28) return 'amber';
            }
            if (typeof tc === 'number' && isFinite(tc) && tc >= 85) {
                return tc >= 98 ? 'red' : 'amber';
            }
            return (typeof p === 'number' && isFinite(p) && p > 0.2) ? 'ok' : 'none';
        };

        const drawTpmsFourWheelBlock = (topCarY, frontRowY, rearRowY, tpMap) => {
            const carW = 58;
            const carH = 148;
            const carX = midX - Math.round(carW / 2);

            // Chassis silhouette + glasshouse + axles
            cv.roundRect(carX, topCarY, carW, carH, 18, [16, 28, 46, 225]);
            cv.strokeRoundRect(carX, topCarY, carW, carH, 18, 2, [92, 142, 198, 205]);
            cv.roundRect(carX + 9, topCarY + 36, carW - 18, 72, 9, [9, 16, 28, 225]);
            cv.strokeRoundRect(carX + 9, topCarY + 36, carW - 18, 72, 9, 1.5, [76, 122, 174, 160]);
            cv.fillRect(carX - 8, topCarY + 27, 8, 3, [92, 142, 198, 180]);
            cv.fillRect(carX + carW, topCarY + 27, 8, 3, [92, 142, 198, 180]);
            cv.fillRect(carX - 8, topCarY + 115, 8, 3, [92, 142, 198, 180]);
            cv.fillRect(carX + carW, topCarY + 115, 8, 3, [92, 142, 198, 180]);

            const wheelSpecs = [
                { key: 'FL', wx: carX - 13, wy: topCarY + 14, tx: leftX, ty: frontRowY, align: 'left' },
                { key: 'FR', wx: carX + carW + 2, wy: topCarY + 14, tx: rightX, ty: frontRowY, align: 'right' },
                { key: 'RL', wx: carX - 13, wy: topCarY + 102, tx: leftX, ty: rearRowY, align: 'left' },
                { key: 'RR', wx: carX + carW + 2, wy: topCarY + 102, tx: rightX, ty: rearRowY, align: 'right' },
            ];

            let anyLive = false;
            for (let i = 0; i < wheelSpecs.length; i++) {
                const ws = wheelSpecs[i];
                const it = tpMap[ws.key] || null;
                const sev = cornerSeverity(ws.key, it);
                if (sev !== 'none') anyLive = true;

                const wCol = sev === 'red' ? [239, 68, 68, 255]
                    : (sev === 'amber' ? [255, 179, 71, 255]
                        : (sev === 'ok' ? [56, 199, 255, 240] : [86, 104, 128, 185]));
                if (sev === 'red' || sev === 'amber') {
                    cv.roundRect(ws.wx - 3, ws.wy - 3, 17, 34, 5, sev === 'red' ? [239, 68, 68, 95] : [255, 179, 71, 95]);
                }
                cv.roundRect(ws.wx, ws.wy, 11, 28, 3, wCol);

                const pCol = sev === 'red' ? COL.red : (sev === 'amber' ? COL.amber : COL.white);
                const tCol = (sev === 'red' && alertObj && alertObj.id === 'tpms_temp') ? COL.red
                    : ((sev === 'amber' && alertObj && alertObj.id === 'tpms_temp') ? COL.amber : COL.softBlue);
                const lblCol = (sev === 'red' || sev === 'amber') ? pCol : COL.tagBlue;

                drawTextOutline(cv, ws.key, ws.tx, ws.ty, 14, lblCol, { font: 'bold', align: ws.align });
                drawTextOutline(cv, fmtCornerPress(it && it.pressureBar), ws.tx, ws.ty + 31, 30, pCol, { font: 'num', align: ws.align });
                drawTextOutline(cv, fmtCornerTemp(it && it.tempC), ws.tx, ws.ty + 56, 20, tCol, { font: 'bold', align: ws.align });
            }
            return anyLive;
        };

        // 1. NORMAL 4-WHEEL TPMS VIEW (no active alert)
        if (!alertObj) {
            paintRadialGlow(cv, midX, 244, 156, [56, 178, 246], 24);
            drawTextOutline(cv, tr('TIRE PRESSURE & TEMP'), midX, 114, 18, COL.tagGray, { font: 'bold', align: 'center' });
            cv.fillRect(bannerX0 + 8, 128, bannerW - 16, 2, COL.divider);

            const tpMap = (t && t.tpms) || {};
            const anyLive = drawTpmsFourWheelBlock(166, 168, 276, tpMap);
            if (!anyLive) {
                drawTextOutline(cv, tr('Updates once rolling'), midX, 396, 17, COL.tagGray, { font: 'label', align: 'center' });
            }
            return;
        }

        // 2. DETAILED ANOMALY ALERT VIEW (auto-switched on alert or preview)
        const isRed = alertObj.severity === 'red';
        const aCol = isRed ? COL.red : COL.amber;
        const glowRgb = isRed ? [239, 68, 68] : [255, 179, 71];
        const bannerFill = isRed ? [88, 16, 22, 232] : [78, 48, 10, 232];
        const bannerRim = isRed ? [239, 68, 68, 245] : [255, 179, 71, 245];

        paintRadialGlow(cv, midX, 242, 176, glowRgb, 44);
        cv.roundRect(bannerX0, 92, bannerW, 40, 8, bannerFill);
        cv.strokeRoundRect(bannerX0, 92, bannerW, 40, 8, 2, bannerRim);

        const rawTitle = String(alertObj.title || alertObj.hudText || alertObj.label || 'VEHICLE ALERT');
        const bannerTitle = '!  ' + tr(rawTitle).toUpperCase();
        const bFit = fitTextLine(cv, bannerTitle, bannerW - 20, [20, 18, 16], 'bold');
        drawTextOutline(cv, bFit.text, midX, 120, bFit.size, isRed ? '#ffd6d6' : '#fff0c7', { font: 'bold', align: 'center' });

        if (alertObj.id === 'tpms' || alertObj.id === 'tpms_temp') {
            const tpMap = alertObj.previewTpms || (t && t.tpms) || {};
            drawTpmsFourWheelBlock(154, 156, 260, tpMap);
            if (alertObj.detail) {
                const dFit = fitTextLine(cv, tr(alertObj.detail), 336, [21, 19, 17], 'bold');
                drawTextOutline(cv, dFit.text, midX, 366, dFit.size, aCol, { font: 'bold', align: 'center' });
            }
            drawTextOutline(cv, tr('Press BC to dismiss'), midX, 398, 17, COL.tagGray, { font: 'label', align: 'center' });
            return;
        }

        // Non-TPMS Detailed Alert (Gearbox Oil Hot/Critical, 12V Battery Low/Critical)
        const heroTxt = alertObj.heroVal || tr(alertObj.label) || '--';
        drawTextOutline(cv, heroTxt, midX, 226, 72, aCol, { font: 'num', align: 'center' });

        if (alertObj.detail) {
            const dFit = fitTextLine(cv, tr(alertObj.detail), 336, [22, 20, 18], 'bold');
            drawTextOutline(cv, dFit.text, midX, 272, dFit.size, COL.white, { font: 'bold', align: 'center' });
        }
        if (alertObj.advice) {
            const advFit = fitTextLine(cv, tr(alertObj.advice), 336, [20, 18, 16], 'label');
            drawTextOutline(cv, advFit.text, midX, 304, advFit.size, COL.softBlue, { font: 'label', align: 'center' });
        }

        cv.fillRect(leftX + 12, 324, rightX - leftX - 24, 1, COL.divider);

        if (alertObj.id === 'gbox') {
            drawTextOutline(cv, tr('ENGINE OIL'), leftX + 8, 348, 14, COL.tagBlue, { font: 'bold', align: 'left' });
            drawTextOutline(cv, formatTemp(t && t.oilTempC, units).text, leftX + 8, 378, 25, COL.white, { font: 'num', align: 'left' });
            drawTextOutline(cv, tr('COOLANT'), rightX - 8, 348, 14, COL.tagBlue, { font: 'bold', align: 'right' });
            drawTextOutline(cv, formatTemp(t && t.coolantTempC, units).text, rightX - 8, 378, 25, COL.white, { font: 'num', align: 'right' });
        } else {
            const vTxt = (t && typeof t.v12 === 'number' && isFinite(t.v12)) ? (t.v12.toFixed(1) + ' V')
                : (alertObj.id === 'v12' && alertObj.heroVal ? alertObj.heroVal : '-- V');
            const sTxt = (t && typeof t.soc12 === 'number' && isFinite(t.soc12)) ? (Math.round(t.soc12) + '%')
                : (alertObj.id === 'soc12' && alertObj.heroVal ? alertObj.heroVal : '--%');
            drawTextOutline(cv, tr('12V VOLTS'), leftX + 8, 348, 14, COL.tagBlue, { font: 'bold', align: 'left' });
            drawTextOutline(cv, vTxt, leftX + 8, 378, 25, COL.white, { font: 'num', align: 'left' });
            drawTextOutline(cv, tr('12V CHARGE'), rightX - 8, 348, 14, COL.tagBlue, { font: 'bold', align: 'right' });
            drawTextOutline(cv, sTxt, rightX - 8, 378, 25, COL.white, { font: 'num', align: 'right' });
        }

        drawTextOutline(cv, tr('Press BC to dismiss'), midX, 408, 17, COL.tagGray, { font: 'label', align: 'center' });
    }

    /**
     * Right-Wing Plug-In Charging Widget (auto-opens on charge, BC-cyclable to Media/Trip):
     *   - Drops all redundant items (progress bar, kW/A speed, current SoC/range, charging target, partial session kWh)
     *   - Ultra-legible enlarged EST. FINISH clock (`92px` / `104px`) + remaining duration (`32px` / `36px`)
     *   - Keeps only live non-redundant HV sensors (`HV PACK` V + `BATT TEMP`) below a subtle divider (`ry <= 402`,
     *     world `y <= 490`, leaving 60px clearance above BMW's stock `19 mi  21 mi` range text at `world y = 550`).
     */
    _paintRightCharging(cv, chg, t, units) {
        cv.clear(COL.clear);
        const c = chg || {};
        const midX = 206;
        const leftX = 52;
        const rightX = 360;

        paintRadialGlow(cv, midX, 232, 172, [56, 178, 246], 38);
        const hdr = c.preconActive
            ? tr('CHARGING  -  PRECOND')
            : (c.plugLocked ? tr('CHARGING  -  LOCKED') : tr('CHARGING'));
        drawTextOutline(cv, hdr, midX, 108, 20, COL.cyan, { font: 'bold', align: 'center' });
        cv.fillRect(62, 122, 288, 2, COL.divider);

        const cards = [];
        if (t && typeof t.hvVolts === 'number' && isFinite(t.hvVolts)) {
            cards.push({
                label: tr('HV PACK'),
                val: Math.round(t.hvVolts) + ' V',
                col: COL.white,
            });
        }
        if (t && typeof t.battTempC === 'number' && isFinite(t.battTempC)) {
            const btCol = t.battTempC < 10 ? COL.icyBlue : (t.battTempC >= 42 ? COL.amber : COL.white);
            cards.push({
                label: tr('BATT TEMP'),
                val: formatTemp(t.battTempC, units).text,
                col: btCol,
            });
        }

        const finStr = c.finishTimeText || '--:--';
        const remLabel = c.remainText
            ? (getLanguage() === 'zh-CN' ? ('\u5269\u4f59 ' + c.remainText) : (c.remainText + ' ' + tr('remaining')))
            : tr('Plugged in');

        if (!cards.length) {
            drawTextOutline(cv, tr('EST. FINISH'), midX, 178, 20, COL.tagGray, { font: 'bold', align: 'center' });
            drawTextOutline(cv, finStr, midX, 280, 104, COL.white, { font: 'num', align: 'center' });
            drawTextOutline(cv, remLabel, midX, 334, 36, COL.icyBlue, { font: 'bold', align: 'center' });
            return;
        }

        drawTextOutline(cv, tr('EST. FINISH'), midX, 156, 18, COL.tagGray, { font: 'bold', align: 'center' });
        drawTextOutline(cv, finStr, midX, 248, 92, COL.white, { font: 'num', align: 'center' });
        drawTextOutline(cv, remLabel, midX, 294, 32, COL.icyBlue, { font: 'bold', align: 'center' });

        cv.fillRect(leftX + 12, 318, rightX - leftX - 24, 1, COL.divider);

        if (cards.length === 1) {
            drawTextOutline(cv, cards[0].label, midX, 356, 17, COL.tagBlue, { font: 'bold', align: 'center' });
            drawTextOutline(cv, cards[0].val, midX, 398, 36, cards[0].col, { font: 'num', align: 'center' });
        } else {
            drawTextOutline(cv, cards[0].label, leftX, 356, 17, COL.tagBlue, { font: 'bold', align: 'left' });
            drawTextOutline(cv, cards[0].val, leftX, 398, 34, cards[0].col, { font: 'num', align: 'left' });
            drawTextOutline(cv, cards[1].label, rightX, 356, 17, COL.tagBlue, { font: 'bold', align: 'right' });
            drawTextOutline(cv, cards[1].val, rightX, 398, 34, cards[1].col, { font: 'num', align: 'right' });
        }
    }

    /**
     * Dedicated HUD Lead-Car Headway badge (`120x41`) right above BMW's green ACC car:
     *   - Row 1: crisp rear-car outline + perspective headway bars + headway timer (`1.8s`, or distance below 12 km/h)
     *   - Row 2: physical following distance (`118 ft` / `36 m`) + optional closing/opening delta (`-6 mph`)
     */
    _paintHudHeadway(cv, lead, units, mode) {
        cv.clear(COL.clear);
        const p = formatLeadHeadwayParts(lead, units, mode);
        if (!p) return;

        const rx = cv.w - 3;
        const mainW = drawTextOutline(cv, p.primaryStr, rx, 20, 22, p.primaryCol, { font: 'num', align: 'right' });

        // Crisp rear-car outline (hollow rear window + tires) + 2 tapered perspective headway bars
        const icX = Math.max(2, Math.round(rx - mainW - 24));
        const carRoof = [[icX + 4, 2], [icX + 14, 2], [icX + 17, 7], [icX + 1, 7], [icX + 4, 2]];
        cv.polyline(carRoof, 3.0, COL.outline);
        cv.fillRect(icX, 6, 18, 6, COL.outline);
        cv.polyline(carRoof, 1.5, p.primaryCol);
        cv.fillRect(icX + 1, 7, 16, 4, p.primaryCol);
        // Rear window dark cutout + two tire ticks
        cv.convex([[icX + 5, 3.5], [icX + 13, 3.5], [icX + 14.5, 6.5], [icX + 3.5, 6.5]], COL.outline);
        cv.fillRect(icX + 1, 11, 3, 2, p.primaryCol);
        cv.fillRect(icX + 14, 11, 3, 2, p.primaryCol);
        // Perspective headway range bars below rear bumper
        cv.fillRect(icX + 2, 14, 14, 3, COL.outline);
        cv.fillRect(icX + 3, 15, 12, 1.6, p.primaryCol);
        cv.fillRect(icX, 18, 18, 3, COL.outline);
        cv.fillRect(icX + 1, 19, 16, 1.6, p.primaryCol);

        if (p.deltaStr && p.secDistStr) {
            const dW = drawTextOutline(cv, p.deltaStr, rx, 36, 13, p.deltaCol, { font: 'bold', align: 'right' });
            drawTextOutline(cv, p.secDistStr, rx - dW - 6, 36, 13, COL.softBlue, { font: 'bold', align: 'right' });
        } else if (p.secDistStr) {
            drawTextOutline(cv, p.secDistStr, rx, 36, 13, COL.softBlue, { font: 'bold', align: 'right' });
        } else if (p.deltaStr) {
            drawTextOutline(cv, p.deltaStr, rx, 36, 13, p.deltaCol, { font: 'bold', align: 'right' });
        }
    }

    _paintHud(cv, lineModes, hero, heroCol, heroUnitCol, subText, subCol, subBolt, gearStr, t, profile, units, fg, brakeLit, brakeHold, alertObj, compactBelowRoad, headwayShown, iceChargeKw) {
        cv.clear(COL.clear); // Borderless 3-line black-outlined text (strictly y=100..200 <= 202 ACC)
        const modes = Array.isArray(lineModes) ? lineModes.slice(0, 3) : ['efficiency_gear', 'power', 'brake'];
        // Always use one uniform, non-jumping layout below hud_road (py >= 38) and strictly left of hud_headway
        // (local x <= 144 < 148 on Rows 1-2; Row 3 sits cleanly below hud_headway at py=82..97).
        const baselines = [56, 72, 95];
        const socStr = (typeof t.soc === 'number' && isFinite(t.soc)) ? ('SOC ' + Math.round(t.soc) + '%') : 'SOC --%';
        const socCol = (typeof t.soc === 'number' && t.soc <= 10) ? COL.red : ((typeof t.soc === 'number' && t.soc <= 20) ? COL.amber : COL.white);
        const oilStr = tr('OIL') + ' ' + formatTemp(t.oilTempC, units).text;
        const coolStr = tr('CL') + ' ' + formatTemp(t.coolantTempC, units).text;
        const tempCol = profile.isCold ? COL.icyBlue : COL.softBlue;

        for (let idx = 0; idx < 3; idx++) {
            const by = baselines[idx];
            const m = modes[idx] || 'off';
            const rowMaxW = idx <= 1 ? 138 : (cv.w - 12);
            // Never let a passive alert overwrite Line 3 while the driver is actively pressing the brake!
            const rawHudAlert = alertObj && (alertObj.hudText || alertObj.label);
            const hudAlertTxt = rawHudAlert ? tr(rawHudAlert) : '';
            if (idx === 2 && hudAlertTxt && !(m === 'brake' && brakeLit > 0)) {
                const aCol = alertObj.severity === 'red' ? COL.red : COL.amber;
                const hFit = fitTextLine(cv, hudAlertTxt, cv.w - 10, [16, 15, 14], 'bold');
                drawTextOutline(cv, hFit.text, 6, by, hFit.size, aCol, { font: 'bold', align: 'left' });
                continue;
            }
            if (m === 'off') continue;
            if (m === 'efficiency_gear' || m === 'efficiency') {
                const nSize = idx === 0 ? 23 : 17;
                const uLen = String(hero.unit || '').length;
                const uSize = uLen >= 8 ? 10 : (uLen >= 6 ? 12 : 14);
                if (hero.bolt) {
                    const bH = idx === 0 ? 17 : 13;
                    const bPad = boltWidth(bH) + 3;
                    const vW = cv.textWidth(String(hero.value || ''), nSize, { font: 'num' });
                    const rx = Math.max(55, 6 + bPad + Math.ceil(vW));
                    drawLightningBolt(cv, Math.max(4, Math.round(rx - vW - bPad)), by - bH + 1, heroCol, bH);
                    drawTextOutline(cv, hero.value, rx, by, nSize, heroCol, { font: 'num', align: 'right' });
                    drawTextOutline(cv, hero.unit, rx + 5, by - 1, uSize, heroUnitCol || COL.softBlue, { font: 'bold', align: 'left' });
                } else {
                    // Fixed non-shifting horizontal anchors wide enough for 2-digit '34.6' and strictly clear of hud_headway (x < 148)
                    const valRightX = 55;
                    const unitX = 59;
                    const gearX = 113;
                    drawTextOutline(cv, hero.value, valRightX, by, nSize, heroCol, { font: 'num', align: 'right' });
                    drawTextOutline(cv, hero.unit, unitX, by - 1, uSize, heroUnitCol || COL.softBlue, { font: 'bold', align: 'left' });
                    if (m === 'efficiency_gear' && gearStr) {
                        const gSize = idx === 0 ? 21 : 16;
                        drawTextOutline(cv, gearStr, gearX, by, gSize, COL.white, { font: 'bold', align: 'left' });
                    }
                }
            } else if (m === 'power_gear') {
                const sz = idx === 0 ? 18 : 15;
                const gx = 113;
                const bH = 13;
                const bPad = subBolt ? (boltWidth(bH) + 3) : 0;
                const sFit = fitTextLine(cv, subText, Math.max(40, gx - 10 - bPad), [sz, Math.max(13, sz - 2), Math.max(11, sz - 4)], 'bold');
                if (subBolt) {
                    drawLightningBolt(cv, 6, by - bH + 1, subCol, bH);
                    drawTextOutline(cv, sFit.text, 6 + bPad, by, sFit.size, subCol, { font: 'bold', align: 'left' });
                } else {
                    drawTextOutline(cv, sFit.text, 6, by, sFit.size, subCol, { font: 'bold', align: 'left' });
                }
                if (gearStr) {
                    drawTextOutline(cv, gearStr, gx, by, idx === 0 ? 20 : 16, COL.white, { font: 'bold', align: 'left' });
                }
            } else if (m === 'power') {
                const sz = idx === 0 ? 18 : 15;
                const bH = 13;
                const bPad = subBolt ? (boltWidth(bH) + 3) : 0;
                const sFit = fitTextLine(cv, subText, Math.max(40, rowMaxW - bPad), [sz, Math.max(13, sz - 1), Math.max(12, sz - 2), Math.max(11, sz - 3)], 'bold');
                if (subBolt) {
                    drawLightningBolt(cv, 6, by - bH + 1, subCol, bH);
                    drawTextOutline(cv, sFit.text, 6 + bPad, by, sFit.size, subCol, { font: 'bold', align: 'left' });
                } else {
                    drawTextOutline(cv, sFit.text, 6, by, sFit.size, subCol, { font: 'bold', align: 'left' });
                }
            } else if (m === 'gear') {
                if (gearStr) {
                    const sz = idx === 0 ? 21 : 16;
                    drawTextOutline(cv, gearStr, 6, by, sz, COL.white, { font: 'bold', align: 'left' });
                }
            } else if (m === 'soc') {
                const sz = idx === 0 ? 19 : 16;
                drawTextOutline(cv, socStr, 6, by, sz, socCol, { font: 'bold', align: 'left' });
            } else if (m === 'soc12') {
                const s12Str = (typeof t.soc12 === 'number' && isFinite(t.soc12)) ? ('12V ' + Math.round(t.soc12) + '%') : '12V --%';
                const s12Col = (typeof t.soc12 === 'number' && t.soc12 < 40) ? COL.red : ((typeof t.soc12 === 'number' && t.soc12 < 55) ? COL.amber : COL.white);
                const sz = idx === 0 ? 19 : 16;
                drawTextOutline(cv, s12Str, 6, by, sz, s12Col, { font: 'bold', align: 'left' });
            } else if (m === 'headway') {
                const hp = formatLeadHeadwayParts(t.leadVehicle, units, 'full');
                if (hp) {
                    const hwTxt = hp.primaryStr + (hp.secDistStr ? ('  ' + hp.secDistStr) : '') + (hp.deltaStr ? ('  ' + hp.deltaStr) : '');
                    const hFit = fitTextLine(cv, hwTxt, rowMaxW, [16, 14, 13], 'bold');
                    drawTextOutline(cv, hFit.text, 6, by, hFit.size, hp.primaryCol, { font: 'bold', align: 'left' });
                }
            } else if (m === 'soc_oil') {
                const f = fitTextLine(cv, socStr + '  ' + oilStr, rowMaxW, [16, 14, 13], 'bold');
                drawTextOutline(cv, f.text, 6, by, f.size, COL.softBlue, { font: 'bold', align: 'left' });
            } else if (m === 'temps') {
                const f = fitTextLine(cv, oilStr + '  ' + coolStr, rowMaxW, [16, 14, 13], 'bold');
                drawTextOutline(cv, f.text, 6, by, f.size, tempCol, { font: 'bold', align: 'left' });
            } else if (m === 'brake') {
                const hSegs = 12;
                const stepX = 14;
                const segH = 6;
                const segY = by - 9;
                if (brakeLit > 0) {
                    const hLit = brakeHold ? 1 : clamp(Math.round((fg / 0.55) * hSegs), 1, hSegs);
                    // Grow RIGHT-to-LEFT (amber -> orange -> red), matching instrument cluster _paintBrakeRail
                    for (let i = 0; i < hSegs; i++) {
                        const sx = 6 + i * stepX;
                        const fromRight = hSegs - 1 - i;
                        const sc = fromRight < hLit
                            ? (fromRight >= 8 ? COL.red : (fromRight >= 4 ? COL.orange : COL.amber))
                            : COL.mapRailDim;
                        cv.fillRect(sx - 1, segY - 1, stepX - 1, segH + 2, COL.outline);
                        cv.fillRect(sx, segY, stepX - 3, segH, sc);
                    }
                    if (!brakeHold && fg > 0.02) {
                        const hasBar = typeof t.brakeBar === 'number' && isFinite(t.brakeBar) && t.brakeBar >= 1.5;
                        const bStr = hasBar ? (Math.round(t.brakeBar) + ' bar') : (fg.toFixed(2) + 'g');
                        drawTextOutline(cv, bStr, 6 + hSegs * stepX + 4, by, 14, fg >= 0.36 ? COL.red : COL.amber, { font: 'bold', align: 'left' });
                    }
                } else if (typeof iceChargeKw === 'number' && isFinite(iceChargeKw) && iceChargeKw > 0) {
                    const hChgLit = clamp(Math.round((iceChargeKw / ICE_CHARGE_MAX_KW) * hSegs), 1, hSegs);
                    // Grow LEFT-to-RIGHT in cyan, matching instrument cluster _paintBrakeRail
                    for (let i = 0; i < hSegs; i++) {
                        const sx = 6 + i * stepX;
                        const sc = i < hChgLit ? COL.cyan : COL.mapRailDim;
                        cv.fillRect(sx - 1, segY - 1, stepX - 1, segH + 2, COL.outline);
                        cv.fillRect(sx, segY, stepX - 3, segH, sc);
                    }
                    const boltX = 6 + hSegs * stepX + 3;
                    drawLightningBolt(cv, boltX, by - 12, COL.cyan, 13);
                    drawTextOutline(cv, '+' + iceChargeKw.toFixed(1) + ' kW', boltX + 11, by, 14, COL.cyan, { font: 'bold', align: 'left' });
                }
            }
        }
    }

    _paintMapLeft(cv, t, units, mode, coldOilC) {
        cv.clear(COL.clear);
        const oil = formatTemp(t.oilTempC, units);
        const isColdOil = typeof t.oilTempC === 'number' && t.oilTempC < coldOilC;
        const isHotOil = typeof t.oilTempC === 'number' && t.oilTempC >= 118;
        const colOil = isColdOil ? COL.icyBlue : (isHotOil ? COL.amber : COL.white);
        const oilTag = tr('OIL');
        const oilTagW = drawTextOutline(cv, oilTag, 4, 27, 18, COL.tagBlue, { font: 'bold', align: 'left' });
        drawTextOutline(cv, oil.text, Math.max(50, Math.ceil(4 + oilTagW + 6)), 28, 24, colOil, { font: 'bold', align: 'left' });

        if (mode === 'oil_gbx') {
            const gbx = formatTemp(t.gearboxOilC, units);
            const colGbx = (typeof t.gearboxOilC === 'number' && t.gearboxOilC >= 105) ? COL.amber : COL.white;
            const gbxTag = tr('GBX');
            const gbxTagW = drawTextOutline(cv, gbxTag, 4, 58, 18, COL.tagBlue, { font: 'bold', align: 'left' });
            drawTextOutline(cv, gbx.text, Math.max(50, Math.ceil(4 + gbxTagW + 6)), 59, 24, colGbx, { font: 'bold', align: 'left' });
        } else {
            const cool = formatTemp(t.coolantTempC, units);
            const colCool = (typeof t.coolantTempC === 'number' && t.coolantTempC >= 108) ? COL.red : COL.white;
            const clTag = tr('CL');
            const clTagW = drawTextOutline(cv, clTag, 4, 58, 18, COL.tagBlue, { font: 'bold', align: 'left' });
            drawTextOutline(cv, cool.text, Math.max(50, Math.ceil(4 + clTagW + 6)), 59, 24, colCool, { font: 'bold', align: 'left' });
        }
    }

    _paintMapRight(cv, gearStr, t, units, cornerRightMode, showBrakeRail, showBrakeNum, fg, litCount, absActive, alertObj, iceChargeKw) {
        cv.clear(COL.clear);

        const rawMapAlert = alertObj && (alertObj.hudText || alertObj.label);
        const mapAlertTxt = rawMapAlert ? tr(rawMapAlert) : '';
        if (mapAlertTxt && !(showBrakeRail && litCount > 0)) {
            const aCol = alertObj.severity === 'red' ? COL.red : COL.amber;
            const mFit = fitTextLine(cv, mapAlertTxt, cv.w - 10, [18, 16, 14], 'bold');
            drawTextOutline(cv, mFit.text, cv.w - 6, 21, mFit.size, aCol, { font: 'bold', align: 'right' });
        } else if (showBrakeRail) {
            const segN = 14;
            const mLit = litCount > 0
                ? (litCount === 1 && fg <= 0.02 ? 1 : clamp(Math.round((fg / 0.55) * segN), 1, segN))
                : 0;
            const mChgLit = (mLit === 0 && typeof iceChargeKw === 'number' && isFinite(iceChargeKw) && iceChargeKw > 0)
                ? clamp(Math.round((iceChargeKw / ICE_CHARGE_MAX_KW) * segN), 1, segN)
                : 0;
            const rightX = cv.w - 6;
            for (let i = 0; i < segN; i++) {
                const sx = rightX - (i + 1) * 10 + 3;
                let sc = COL.mapRailDim;
                if (i < mLit) {
                    sc = i >= 9 ? COL.red : (i >= 4 ? COL.orange : COL.amber);
                } else if (mChgLit > 0 && (segN - 1 - i) < mChgLit) {
                    sc = COL.cyan;
                }
                cv.fillRect(sx - 1, 9, 9, 10, COL.outline);
                cv.fillRect(sx, 10, 7, 8, sc);
            }
            if (litCount > 0 && showBrakeNum) {
                const hasBar = typeof t.brakeBar === 'number' && isFinite(t.brakeBar) && t.brakeBar >= 1.5;
                const valStr = hasBar ? (Math.round(t.brakeBar) + ' bar') : (fg.toFixed(2) + 'g');
                const lbl = (absActive ? 'ABS ' : '') + valStr;
                const bCol = (fg >= 0.36 || absActive) ? COL.red : COL.amber;
                drawTextOutline(cv, lbl, rightX - segN * 10 - 6, 20, 16, bCol, { font: 'bold', align: 'right' });
            } else if (mChgLit > 0 && showBrakeNum) {
                const chgStr = '+' + iceChargeKw.toFixed(1) + ' kW';
                const txRight = rightX - segN * 10 - 6;
                const tw = drawTextOutline(cv, chgStr, txRight, 20, 15, COL.cyan, { font: 'bold', align: 'right' });
                drawLightningBolt(cv, Math.max(2, Math.round(txRight - tw - 11)), 8, COL.cyan, 13);
            }
        }

        if (gearStr) {
            drawTextOutline(cv, gearStr, 84, 60, 28, COL.white, { font: 'bold', align: 'right' });
        }

        if (cornerRightMode !== 'off') {
            const m = formatCornerRightMetric(t, units, cornerRightMode);
            const valX = cv.w - 6;
            const valW = drawTextOutline(cv, m.valText, valX, 60, 28, m.col, { font: 'num', align: 'right' });
            drawTextOutline(cv, m.tag, valX - valW - 6, 58, 18, COL.tagGray, { font: 'bold', align: 'right' });
        }
    }

    _paintClusterSpeed(cv, spd, showUnit, fontSizeOpt, showPlate) {
        cv.clear(COL.clear);
        const plateOn = Boolean(showPlate);
        if (plateOn) {
            paintNaturalGlassPlate(cv, 18, { alpha: 164 });
        }
        const valStr = String(spd && spd.value !== undefined ? spd.value : '--');
        const unitStr = (showUnit !== false && spd && spd.unit) ? String(spd.unit) : '';
        const sz = clamp(Number(fontSizeOpt) || 72, 40, 84);
        const cx = Math.round(cv.w / 2);
        const digitY = unitStr ? Math.round(cv.h * (plateOn ? 0.67 : 0.69)) : Math.round(cv.h * 0.78);
        const drawTxt = plateOn ? drawTextClean : drawTextOutline;
        drawTxt(cv, valStr, cx, digitY, sz, COL.white, { font: 'num', align: 'center' });
        if (unitStr) {
            drawTxt(cv, unitStr, cx, Math.min(cv.h - (plateOn ? 8 : 4), digitY + 21), 15, COL.dim, { font: 'bold', align: 'center' });
        }
    }

    _paintClusterTurnCard(cv, guide, units, showPlate) {
        cv.clear(COL.clear);
        if (!guide) return false;

        const plateOn = showPlate !== false;
        if (plateOn) {
            paintNaturalGlassPlate(cv, 18, { alpha: 178 });
        }
        const drawTxt = plateOn ? drawTextClean : drawTextOutline;

        const arrowCx = Math.min(54, Math.round(cv.w * 0.14));
        const arrowCy = Math.round(cv.h / 2);
        const arrowScale = Math.min(0.98, Math.max(0.65, (cv.h - 14) / 96));
        drawArrow(cv, guide, arrowCx, arrowCy, arrowScale, [244, 248, 255, 255], [108, 126, 150, 225]);

        const rx = Math.min(104, Math.round(cv.w * 0.27));
        const rightEdge = cv.w - 14;
        const badge = guide.exitBadge ? String(guide.exitBadge).trim() : '';
        let badgeReserve = 0;
        if (badge) {
            const bw = measureExitBadge(cv, badge, 16);
            drawExitBadge(cv, badge, rightEdge - bw, 14, 26, 16);
            badgeReserve = bw + 10;
        }

        const distStr = guide.dist ? String(guide.dist) : '--';
        const unitStr = guide.unit ? String(guide.unit) : '';
        const unitReserve = unitStr ? (cv.textWidth(unitStr, 20, { font: 'bold' }) + 8) : 0;
        const maxDistW = Math.max(40, rightEdge - rx - badgeReserve - unitReserve);
        const dFit = fitTextLine(cv, distStr, maxDistW, [36, 30, 26, 22], 'bold');
        const distY = Math.round(cv.h * 0.46);
        const dw = drawTxt(cv, dFit.text, rx, distY, dFit.size, COL.white, { font: 'bold', align: 'left' });
        if (unitStr) {
            drawTxt(cv, unitStr, rx + dw + 6, distY - 2, 20, '#7dc4ff', { font: 'bold', align: 'left' });
        }

        const fallbackRoad = guide.kind === 'destination'
            ? tr('Destination')
            : ((guide.kind === 'turn' && guide.dir === 'STRAIGHT_ON') ? tr('Continue straight') : tr('Ahead'));
        const roadRaw = (guide.road && String(guide.road).trim()) ? String(guide.road).trim() : fallbackRoad;
        const rFit = fitTextLine(cv, roadRaw, Math.max(60, rightEdge - rx), [22, 19, 17, 15], 'bold');
        drawTxt(cv, rFit.text, rx, Math.round(cv.h * 0.80), rFit.size, '#dbe7f5', { font: 'bold', align: 'left' });
        return true;
    }

    _paintClusterEtaPill(cv, eta, units, showPlate) {
        cv.clear(COL.clear);
        if (!eta || (!eta.text && typeof eta.remainMeters !== 'number')) return false;

        const plateOn = showPlate !== false;
        if (plateOn) {
            const rad = Math.floor((cv.h - 6) / 2);
            paintNaturalGlassPlate(cv, rad, { alpha: 174 });
        }
        const drawTxt = plateOn ? drawTextClean : drawTextOutline;

        const isZh = getLanguage() === 'zh-CN';
        const etaPrefix = eta.text ? (isZh ? (eta.text + ' \u5230\u8fbe') : ('ETA ' + eta.text)) : '';
        const parts = [];
        if (typeof eta.remainSec === 'number' && isFinite(eta.remainSec) && eta.remainSec > 0) {
            const mins = Math.max(1, Math.round(eta.remainSec / 60));
            if (mins >= 60) {
                const h = Math.floor(mins / 60);
                const m = mins % 60;
                parts.push(isZh ? (h + '\u5c0f\u65f6' + (m > 0 ? (m + '\u5206') : '')) : (h + 'h' + (m > 0 ? (' ' + m + 'm') : '')));
            } else {
                parts.push(isZh ? (mins + '\u5206\u949f') : (mins + ' min'));
            }
        }
        if (typeof eta.remainMeters === 'number' && isFinite(eta.remainMeters) && eta.remainMeters > 0) {
            if (units && units.distUnit === 'mi') {
                const mi = eta.remainMeters / 1609.344;
                parts.push((mi >= 10 ? mi.toFixed(0) : mi.toFixed(1)) + ' mi');
            } else if (eta.remainMeters >= 1000) {
                const km = eta.remainMeters / 1000;
                parts.push((km >= 10 ? km.toFixed(0) : km.toFixed(1)) + ' km');
            } else {
                parts.push(Math.round(eta.remainMeters) + ' m');
            }
        }
        const tailStr = parts.length ? ((etaPrefix ? '  |  ' : '') + parts.join('  |  ')) : '';
        const rawFull = etaPrefix + tailStr;
        if (!rawFull) return false;

        const fit = fitTextLine(cv, rawFull, Math.max(80, cv.w - 28), [22, 20, 18, 16], 'bold');
        const baseY = Math.round(cv.h / 2 + fit.size * 0.35);
        if (etaPrefix && fit.text.indexOf(etaPrefix) === 0) {
            const fullW = cv.textWidth(fit.text, fit.size, { font: 'bold' });
            const startX = Math.max(14, Math.round((cv.w - fullW) / 2));
            const pw = drawTxt(cv, etaPrefix, startX, baseY, fit.size, '#5bc8ff', { font: 'bold', align: 'left' });
            const rem = fit.text.slice(etaPrefix.length);
            if (rem) drawTxt(cv, rem, startX + pw, baseY, fit.size, COL.white, { font: 'bold', align: 'left' });
        } else {
            drawTxt(cv, fit.text, Math.round(cv.w / 2), baseY, fit.size, COL.white, { font: 'bold', align: 'center' });
        }
        return true;
    }

    close() {
        if (this.cr) {
            this.cr.close();
            this.cr = null;
        }
        this.connected = false;
        this.ready = false;
        this.hostConfigKey = '';
        this.userMapMode = 'fullview_dials';
        this.hostModeActive = 'native';
        this.crHostLayers = false;
        this.crHostMask = false;
        this.crRenderState = false;
        this.hostingState = '';
        this.hostingReason = '';
        this.mapHostedInto = '';
        this.mapTargetState = '';
        this.mapTargetReason = '';
        this.mapSlotLocked = false;
        this._standbyRescueActive = false;
        this.standbyRescue = false;
        this.wazeStatus = null;
        this.bezelMaskMode = 'off';
        this.lastHudNavKey = '';
        this.lastHudRoadKey = '';
        this.lastRightWidgetKey = '';
        this.lastTurnCardKey = '';
        this.lastEtaPillKey = '';
        this.lastSpeedKey = '';
        this._turnCardHold = null;
        this._iceChgState = {};
        this.layers = {};
    }
}

module.exports = {
    OverlayRenderer,
    inspectClusterSlotConfig,
    changes,
    resolveCornerRightMode,
    formatLeadHeadwayParts,
    cabinHvacPalette,
    BELOW_SPEED_BASE,
    GEAR_D_BASE,
    CABIN_TEMP_BASE,
    BRAKE_RAIL_BASE,
    CORNER_LEFT_BASE,
    CORNER_RIGHT_BASE,
    HV_SOC_GAUGE_BASE,
    RIGHT_WIDGET_BASE,
    SPEED_BASE,
    TURN_CARD_BASE,
    ETA_PILL_BASE,
    HUD_BASE,
    HUD_HEADWAY_BASE,
    HUD_ROAD_BASE,
    HUD_NAV_BASE,
    MAP_SPEED_RECT,
    MAP_LEFT_RECT,
    MAP_RIGHT_RECT,
    MAP_FALLBACK_RECT: MAP_RIGHT_RECT,
    CLUSTER_LAYER_NAMES,
    PANEL_ALL_LAYERS,
    MAP_LAYER_NAMES,
};
