'use strict';
/**
 * route.js - the trip's arrival time, time left, distance left and traffic, from what the car's guidance
 * services report (no car in it: tested on a PC).
 *
 * The car's catalog (G22, iDrive 7) has the same struct in two places:
 *   ProjectedModeGuiding.waypoints  (CarPlay / Android Auto routes): DestinationInfo[]
 *   Guidance.finalDestinationInfo / nextDestinationInfo / allDestinationsInfo  (BMW's own navigation)
 * DestinationInfo = { delayTime (s), delayStatus (GREEN / YELLOW / RED), travelTime (s),
 *   estimatedArrivalTime { includedTimeOffset, date { invalid, year, month, day }, time { hours, minutes, seconds } },
 *   formattedDistance { distance: '12.4', unit: MILE_US, rawDistance }, directionToDestination, position,
 *   isCheckeredFlag, stopOverNumber, ... }. The cluster's bottom strip shows a route's ETA from these.
 *
 * Node 8: no ?., ??, object spread or optional catch binding.
 */

const UNITS = { MILE_US: 'mi', MILE_UK: 'mi', KM: 'km', METER: 'm', FEET: 'ft', YARD: 'yd', 1: 'km', 2: 'mi', 3: 'mi', 4: 'm', 5: 'yd', 6: 'ft' };

// 4294967295 (UInt32 all ones) is the car's "no value"
const NONE = 4294967295;
const num = (x) => (typeof x === 'number' && isFinite(x) ? x : (typeof x === 'string' && x.trim() !== '' && isFinite(Number(x)) ? Number(x) : null));
const enumName = (v) => (v && typeof v === 'object' ? (v.name || v.value || Object.keys(v)[0]) : v);

/** The destination among a list: the checkered flag (the final one), else the last. */
function finalOf(list) {
    if (!Array.isArray(list) || !list.length) return null;
    const flagged = list.filter((d) => d && d.isCheckeredFlag);
    return flagged.length ? flagged[flagged.length - 1] : list[list.length - 1];
}

/**
 * A DestinationInfo as { arrival: { h, m } | null, travelSec, delaySec, traffic: 'green'|'yellow'|'red'|null,
 * dist: '12.4', unit: 'mi', rawDist, final } or null when it says nothing (no time and no distance).
 */
function decode(d) {
    if (!d || typeof d !== 'object') return null;
    const e = d.estimatedArrivalTime || {}, t = e.time || {}, date = e.date || {};
    // the car's names: time { invalid, hour, minute, seconds } (G22, iDrive 7); hours / minutes also taken
    const h = num(t.hour !== undefined ? t.hour : t.hours), m = num(t.minute !== undefined ? t.minute : t.minutes);
    const arrival = h !== null && m !== null && !date.invalid && !t.invalid && h < 24 && m < 60 ? { h: h, m: m } : null;
    const travel = num(d.travelTime), delay = num(d.delayTime);
    const fd = d.formattedDistance || {};
    const dist = fd.distance !== undefined && fd.distance !== null && String(fd.distance).trim() !== '' ? String(fd.distance).trim() : null;
    const status = String(enumName(d.delayStatus) || '').toUpperCase();
    const out = {
        arrival: arrival,
        travelSec: travel !== null && travel !== NONE && travel > 0 && travel < 7 * 86400 ? travel : null,
        delaySec: delay !== null && delay !== NONE && delay > 0 && delay < 86400 ? delay : null,
        traffic: status === 'GREEN' ? 'green' : status === 'YELLOW' ? 'yellow' : status === 'RED' ? 'red' : null,
        dist: dist, unit: UNITS[enumName(fd.unit)] || null, rawDist: num(fd.rawDistance),
        final: !!d.isCheckeredFlag,
    };
    // a finished route the phone hasn't cleared yet (0 ft, 0 s left): nothing to show
    if ((out.rawDist === 0 || out.dist === '0') && !out.travelSec) return null;
    return out.arrival || out.travelSec || out.dist ? out : null;
}

/**
 * The trip to show from the latest values: { src: 'carplay' | 'bmw', ...decode() } or null.
 * v: { waypoints, finalDestinationInfo, nextDestinationInfo, allDestinationsInfo, projectedActive }
 */
function pick(v) {
    const cp = decode(finalOf(v.waypoints));
    if (cp) return Object.assign({ src: 'carplay' }, cp);
    const bmw = decode(v.finalDestinationInfo) || decode(finalOf(v.allDestinationsInfo)) || decode(v.nextDestinationInfo);
    if (bmw) return Object.assign({ src: 'bmw' }, bmw);
    return null;
}

/** The arrival as 5:42 PM: the car's own, else now + time left. */
function arrivalText(r, now) {
    let h, m;
    if (r.arrival) { h = r.arrival.h; m = r.arrival.m; }
    else if (r.travelSec) { const d = new Date(now + r.travelSec * 1000); h = d.getHours(); m = d.getMinutes(); }
    else return null;
    return ((h % 12) || 12) + ':' + (m < 10 ? '0' : '') + m + (h < 12 ? ' AM' : ' PM');
}
/** Time left as 23 min / 1 h 05 min. */
function leftText(sec) {
    if (!sec && sec !== 0) return null;
    const mins = Math.max(0, Math.round(sec / 60));
    return mins < 60 ? mins + ' min' : Math.floor(mins / 60) + ' h ' + (mins % 60 < 10 ? '0' : '') + (mins % 60) + ' min';
}

/**
 * Traffic, guessed: CarPlay never sends Apple Maps' delay to the car (every route logged: delayStatus UNDEFINED,
 * delayTime 0), so the colour comes from what it does send, the time and distance left:
 *   slip   the arrival time getting later than the earliest one of the last 8 minutes (traffic you're in now; once
 *          the arrival stops slipping, the minutes lost drop out of the window and it's green again)
 *   pace   the average speed Apple's time left implies for the distance left, against what open roads allow
 *          (45 mph over 12 mi or more, 30 mph over 4-12 mi; under 4 mi it can't tell a city street from a jam)
 * The worse of the two: yellow from 3 min late (slip) or 4 min and 25 % over (pace), red from 8 min / 10 min and 35 %.
 * Apple's own colour wins whenever the car does send one.
 */
const WINDOW_MS = 8 * 60000;
const HOLD_MS = 45000;          // a colour change must last this long before it shows
class TrafficGuess {
    constructor() { this.reset(); }
    reset() { this.hist = []; this.start = null; this.last = null; this.shown = undefined; }
    apply(r, now) {
        if (!r || !r.travelSec) return r;
        const arr = now + r.travelSec * 1000;
        if (this.start === null) this.start = now;
        // the earliest arrival of the last WINDOW_MS, after the first half minute (the phone's first numbers settle)
        if (now - this.start > 30000) this.hist.push([now, arr]);
        while (this.hist.length && now - this.hist[0][0] > WINDOW_MS) this.hist.shift();
        const best = this.hist.reduce((b, x) => (b === null || x[1] < b ? x[1] : b), null);
        const slipMin = best === null ? 0 : Math.max(0, (arr - best) / 60000);
        let paceMin = 0;
        const mi = r.rawDist ? r.rawDist / 1609.34 : null;
        if (mi !== null && mi >= 4) {
            const free = (mi / (mi >= 12 ? 45 : 30)) * 60, mins = r.travelSec / 60;
            if (mins > free) paceMin = (mins - free) / mins >= 0.25 ? mins - free : 0;
            if (paceMin && (mins - free) / mins < 0.35 && paceMin >= 10) paceMin = 9.9;   // red needs both 10 min and 35 %
        }
        // slip only counts on trips it can tell: 3 mi or more and 10 min or more left (on a short city trip a few red
        // lights are minutes, and Apple sends whole minutes); and only when it's a real share of the time left
        const mins = r.travelSec / 60;
        const slipOk = mi !== null && mi >= 3 && mins >= 10;
        const slipLvl = !slipOk ? 0 : slipMin >= 8 && slipMin >= 0.4 * mins ? 2 : slipMin >= 4 && slipMin >= 0.25 * mins ? 1 : 0;
        const lvl = (x, y, z) => (x >= y ? 2 : x >= z ? 1 : 0);
        let level = Math.max(slipLvl, lvl(paceMin, 10, 4));
        // no flicker: a new colour must hold 45 s before it shows
        if (this.shown === undefined) { this.shown = level; this.cand = level; this.candAt = now; }
        if (level !== this.cand) { this.cand = level; this.candAt = now; }
        if (this.cand !== this.shown && now - this.candAt >= HOLD_MS) this.shown = this.cand;
        level = this.shown;
        this.last = { slipMin: Math.round(slipMin * 10) / 10, paceMin: Math.round(paceMin * 10) / 10, level: level };
        if (!r.traffic) r = Object.assign({}, r, { traffic: ['green', 'yellow', 'red'][level], guessed: true });
        return r;
    }
}

module.exports = { TrafficGuess, decode, pick, finalOf, arrivalText, leftText };
