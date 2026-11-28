'use strict';
/**
 * layout_config.js - Adjustable cluster overlay geometry & trigger configuration.
 *
 * Right-wing widget geometry (`right_widget`) is intentionally excluded from manual
 * override to preserve chyiz v0.9.3's calibrated KOMBI4 right-wing homography mask.
 * All other cluster overlays (top-center iOS turn card, ETA pill, frameless speed,
 * below_speed, corner vitals, brake rail, gear badge, cabin temp, HV SoC gauge) support
 * manual coordinates via this file, optional /var/opt/cluster-render/cockpit_layout.json,
 * and native iDrive RHMI nudge settings.
 *
 * Strict Node 8.16.2 (ES2017): no optional chaining, no ??, no dependencies.
 */

const fs = require('fs');

const DEFAULT_RUNTIME_LAYOUT_PATH = '/var/opt/cluster-render/cockpit_layout.json';

const LOCKED_WIDGETS = {
    right_widget: true,
    right_media: true,
    right_trip: true,
    right_tpms: true,
    right_charging: true,
};

const LEGACY_ALIASES = {
    metrics_left: 'below_speed',
    corner_oil_coolant: 'corner_left',
};

const DEFAULT_LAYOUT = {
    guidance_turn_card: {
        enabled: true,
        x: 760,
        y: 18,
        w: 400,
        h: 96,
        autoTriggerDistanceMeters: 350,
        dismissDelaySeconds: 2.5,
    },
    eta_pill: {
        enabled: true,
        x: 760,
        y: 628,
        w: 400,
        h: 46,
    },
    speed: {
        enabled: true,
        x: 372,
        y: 328,
        w: 220,
        h: 90,
        fontSize: 72,
        showUnit: true,
    },
    below_speed: {
        enabled: true,
        x: 392,
        y: 445,
        w: 214,
        h: 84,
    },
    corner_left: {
        enabled: true,
        x: 8,
        y: 643,
        w: 116,
        h: 66,
    },
    corner_right: {
        enabled: true,
        x: 1816,
        y: 646,
        w: 98,
        h: 66,
    },
    brake_rail: {
        enabled: true,
        x: 1280,
        y: 609,
        w: 296,
        h: 31,
    },
    gear_d: {
        enabled: true,
        x: 1461,
        y: 650,
        w: 26,
        h: 56,
    },
    cabin_temp: {
        enabled: true,
        x: 1488,
        y: 654,
        w: 51,
        h: 50,
    },
    hv_soc_gauge: {
        enabled: true,
        x: 1796,
        y: 452,
        w: 92,
        h: 56,
    },
};

function clampNum(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

function cloneLayoutDefaults() {
    const out = {};
    const keys = Object.keys(DEFAULT_LAYOUT);
    for (let i = 0; i < keys.length; i++) {
        out[keys[i]] = Object.assign({}, DEFAULT_LAYOUT[keys[i]]);
    }
    return out;
}

function mergeExternalLayout(extRaw) {
    const merged = cloneLayoutDefaults();
    if (!extRaw || typeof extRaw !== 'object') return { widgets: merged, customKeys: {} };
    const src = extRaw.widgets && typeof extRaw.widgets === 'object' ? extRaw.widgets : extRaw;
    const customKeys = {};
    const names = Object.keys(src);
    for (let i = 0; i < names.length; i++) {
        const rawKey = names[i];
        if (LOCKED_WIDGETS[rawKey]) continue;
        const canon = LEGACY_ALIASES[rawKey] || rawKey;
        if (LOCKED_WIDGETS[canon] || !merged[canon]) continue;
        const patch = src[rawKey];
        if (!patch || typeof patch !== 'object') continue;
        const target = merged[canon];
        if (typeof patch.enabled === 'boolean') target.enabled = patch.enabled;
        if (typeof patch.x === 'number' && isFinite(patch.x)) {
            target.x = Math.round(patch.x);
            customKeys[canon] = true;
        }
        if (typeof patch.y === 'number' && isFinite(patch.y)) {
            target.y = Math.round(patch.y);
            customKeys[canon] = true;
        }
        if (typeof patch.w === 'number' && isFinite(patch.w) && patch.w >= 24 && patch.w <= 1200) {
            target.w = Math.round(patch.w);
        }
        if (typeof patch.h === 'number' && isFinite(patch.h) && patch.h >= 24 && patch.h <= 480) {
            target.h = Math.round(patch.h);
        }
        if (canon === 'speed') {
            if (typeof patch.fontSize === 'number' && isFinite(patch.fontSize)) {
                target.fontSize = clampNum(Math.round(patch.fontSize), 36, 84);
            }
            if (typeof patch.showUnit === 'boolean') target.showUnit = patch.showUnit;
        }
        if (canon === 'guidance_turn_card') {
            if (typeof patch.autoTriggerDistanceMeters === 'number' && isFinite(patch.autoTriggerDistanceMeters)) {
                target.autoTriggerDistanceMeters = Math.max(0, Math.round(patch.autoTriggerDistanceMeters));
            }
            if (typeof patch.dismissDelaySeconds === 'number' && isFinite(patch.dismissDelaySeconds)) {
                target.dismissDelaySeconds = clampNum(patch.dismissDelaySeconds, 0, 15);
            }
        }
    }
    return { widgets: merged, customKeys };
}

class LayoutStore {
    constructor(filePath) {
        this.filePath = filePath || process.env.COCKPIT_LAYOUT_PATH || DEFAULT_RUNTIME_LAYOUT_PATH;
        this._cached = null;
        this._lastMtimeMs = -1;
        this._lastCheckMs = 0;
    }

    get(nowMs) {
        const now = typeof nowMs === 'number' ? nowMs : Date.now();
        if (this._cached && now - this._lastCheckMs < 1000) {
            return this._cached;
        }
        this._lastCheckMs = now;
        try {
            if (this.filePath && fs.existsSync(this.filePath)) {
                const st = fs.statSync(this.filePath);
                if (!this._cached || st.mtimeMs !== this._lastMtimeMs) {
                    this._lastMtimeMs = st.mtimeMs;
                    const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
                    this._cached = mergeExternalLayout(parsed);
                }
                return this._cached;
            }
        } catch (e) { /* keep defaults on unreadable or malformed runtime override */ }
        this._lastMtimeMs = -1;
        this._cached = { widgets: cloneLayoutDefaults(), customKeys: {} };
        return this._cached;
    }
}

function resolveWidgetRect(layoutState, name, fallbackRect, nudgeX, nudgeY, defaultBounds) {
    if (LOCKED_WIDGETS[name]) {
        return {
            x: clampNum(fallbackRect.x + (nudgeX || 0), defaultBounds.minX, defaultBounds.maxX),
            y: clampNum(fallbackRect.y + (nudgeY || 0), defaultBounds.minY, defaultBounds.maxY),
            w: fallbackRect.w,
            h: fallbackRect.h,
        };
    }
    const wSpec = (layoutState && layoutState.widgets && layoutState.widgets[name]) || fallbackRect;
    const isCustom = Boolean(layoutState && layoutState.customKeys && layoutState.customKeys[name]);
    const nx = typeof nudgeX === 'number' && isFinite(nudgeX) ? nudgeX : 0;
    const ny = typeof nudgeY === 'number' && isFinite(nudgeY) ? nudgeY : 0;
    const w = wSpec.w || fallbackRect.w;
    const h = wSpec.h || fallbackRect.h;
    const rawX = (typeof wSpec.x === 'number' ? wSpec.x : fallbackRect.x) + nx;
    const rawY = (typeof wSpec.y === 'number' ? wSpec.y : fallbackRect.y) + ny;
    if (isCustom || !defaultBounds) {
        return {
            x: clampNum(rawX, 0, Math.max(0, 1920 - w)),
            y: clampNum(rawY, 0, Math.max(0, 720 - h)),
            w,
            h,
        };
    }
    return {
        x: clampNum(rawX, defaultBounds.minX, defaultBounds.maxX),
        y: clampNum(rawY, defaultBounds.minY, defaultBounds.maxY),
        w,
        h,
    };
}

module.exports = {
    DEFAULT_LAYOUT,
    DEFAULT_RUNTIME_LAYOUT_PATH,
    LOCKED_WIDGETS,
    LEGACY_ALIASES,
    LayoutStore,
    mergeExternalLayout,
    resolveWidgetRect,
};
