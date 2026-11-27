'use strict';
/**
 * GearHUD - la marcha engranada en el HUD, en el cuadro o en los dos.
 *
 *  - Siempre: escucha las señales de marcha, las enseña en pantalla y las registra en data/senales.log.
 *  - "Dónde mostrar la marcha" (de fábrica, en ningún sitio): HUD, cuadro o los dos, con cluster-render.
 *  - Solo con el coche listo (estado 10): nunca al encender o apagar, cuando el guardián de cluster-render
 *    cuenta un aviso si el cuadro se va justo después de mostrar el HUD (dos avisos lo desactivan).
 *  - Si Redline u otra app toma el HUD (kit/hud_claim.js), se le deja mientras lo tenga.
 *  - Los datos de demo solo se ven en la pantalla central, nunca en el HUD ni en el cuadro.
 *  - "Calibrar", solo parado: rejilla con coordenadas, marcha de prueba y fin. Se apaga sola al moverse.
 *
 * Un fallo no puede tirar la app: MainApp borra los datos de una app que se cae y la desinstala a la segunda.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { Canvas } = require('./kit/canvas');
const G = require('./kit/gauges');
const { HudClaim } = require('./kit/hud_claim');
const { ClusterRender } = require('./cluster_render_client.js');
const { GearState } = require('./gear_state');
const { Outputs } = require('./outputs');
const { layout } = require('./glyphs');
const { colourOf, opacityOf } = require('./colors');
const SignalLog = require('./signal_log');
const { hudText, readPositionFile, rolesFor, roleOf } = require('./rules');

const W = 1600, H = 520;
const SPEED_K = 0.015625, RPM_K = 0.25, INVALID16 = 65535;
const CALIB_MS = 120000, CALIB_MAX_KMH = 3;
const CALIB_STEPS = ['off', 'grid', 'test'];
const RPM_AFTER_MS = 15000;      // sin marcha del cambio tras este rato con el coche listo: se piden las rpm para estimarla
const DAY_NIGHT = { KEINE_AENDERUNG: 0, TAG: 1, NACHT: 2, SIGNAL_UNGUELTIG: 3 };
const DEMO_SCRIPT = [['P', 0, 1500], ['D', 0, 800], ['D', 1, 900], ['D', 2, 1000], ['D', 3, 1200], ['D', 4, 1500], ['D', 5, 1800],
    ['S', 4, 1500], ['S', 3, 1200], ['S', 2, 1000], ['D', 0, 1500]];

let missing = {};
try { missing = require('./kit/missing-interfaces.json'); } catch (e) { /* nada quitado al instalar */ }

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const ID = ctx.spec.id || 'rubenrios_gearhud';
        const cfg = ctx.spec.config;
        const get = (k) => settings.get(k);
        const state = new GearState();
        const recorder = new SignalLog(ctx.dataDir, (e) => log.warn('registro: ' + e));
        const live = { speed: null, rpm: null, night: null, raw: {}, counts: {}, lastAt: {} };
        let carSeen = false, calib = 0, calibUntil = 0, message = '', readySince = 0, rpmWatched = false;
        const safely = (what, fn) => (...a) => { try { return fn(...a); } catch (e) { log.warn(what + ': ' + (e && e.stack || e)); return undefined; } };
        if (Object.keys(missing).length) log.info('quitado al instalar (el coche no lo tiene): ' + Object.keys(missing).join(', '));

        const base = { panel: cfg.positions.panel, hud: cfg.hud.anchors };
        let places = readPositionFile(path.join(ctx.dataDir, 'posicion.json'), base, log) || base;

        const hudGlyph = { size: cfg.hud.size, cellH: cfg.hud.cellH, baseline: cfg.hud.baseline, font: cfg.glyph.font };
        const centreGlyph = Object.assign({}, hudGlyph, { shadow: cfg.glyph.shadow });
        // junto a la D: la letra de gear_overlay (celda de 96 x 128, estirada un 20 %, con sombra)
        const clusterGlyph = { size: cfg.glyph.size, cellH: cfg.glyph.h, baseline: cfg.glyph.baseline, font: cfg.glyph.font, stretch: cfg.glyph.stretch, shadow: cfg.glyph.shadow };
        const out = new Outputs({ ClusterRender, Canvas, id: ID, log, hudGlyph, clusterGlyph, centreGlyph, hudVisible: cfg.hud.visible });

        /* ---------- señales ---------- */
        const note = (name, v) => {
            carSeen = true;
            live.raw[name] = v; live.counts[name] = (live.counts[name] || 0) + 1; live.lastAt[name] = Date.now();
            if (get('record')) recorder.add(name, v, { kmh: live.speed, rpm: live.rpm, vista: state.view(Date.now(), { guess: get('guess') }).digit });
        };
        const watch = (iface, handlers) => {
            if (missing[iface]) { log.info('señal ' + iface.split('.').pop() + ': no está en este coche'); return; }
            ctx.signals.watch(iface, '1', handlers, log)
                .then((s) => log.info('señal ' + iface.split('.').pop() + (s && s.error ? ' error: ' + s.error : ' suscrita')))
                .catch((e) => log.warn('señal ' + iface + ': ' + e));
        };
        const sig = (name, fn) => safely(name, (v) => { fn(v); note(name, v); });
        watch('de.bmw.infrastructure.VehicleInformation', {
            statusGearboxDrive: sig('statusGearboxDrive', (v) => state.gearbox(v, Date.now())),
            DataPowerTrain2: sig('DataPowerTrain2', (v) => state.selection(v, Date.now())),
        });
        watch('de.bmw.infotainment.misc.MDrive', { dataDisplayGearbox: sig('dataDisplayGearbox', (v) => state.programme(v)) });
        watch('de.bmw.infotainment.drivingexcitement.FES', { statusFESVehicleDynamicSwitchHMI: sig('statusFESVehicleDynamicSwitchHMI', (v) => state.mode(v)) });
        watch('de.bmw.infrastructure.VehicleCondition', { VehicleCondition: sig('VehicleCondition', (v) => state.vehicleCondition(v)) });
        watch('de.bmw.infotainment.vehicle.Vehicle', {
            statusDayNightChangeOver: sig('statusDayNightChangeOver', (v) => {
                const x = v && typeof v === 'object' ? v.dayNightChangeOver : v, c = typeof x === 'string' ? DAY_NIGHT[x] : x;
                if (c === 1 || c === 2) live.night = c === 2;
            }),
        });
        // la velocidad, siempre (ligera): calibrar solo parado, la estimación y el contexto del registro
        watch('de.bmw.infotainment.vehicle.Vehicle2', { statusCarSpeed2: safely('velocidad', (v) => {
            const r = v && v.speedVehicleCentreOfGravity;
            live.speed = r === undefined || r === INVALID16 ? null : r * SPEED_K; carSeen = true;
        }) });
        // las rpm, solo si hacen falta: llegan muchas veces por segundo y solo sirven para estimar la marcha
        const watchRpm = () => {
            if (rpmWatched) return;
            rpmWatched = true;
            log.info('el cambio no da la marcha: se piden las rpm para estimarla');
            watch('de.bmw.infotainment.vehicle.CDS', { statusEngineSpeed2: safely('rpm', (v) => {
                const r = v && v.actualValueRPMEngineCrankshaft;
                live.rpm = r === undefined || r === INVALID16 ? null : r * RPM_K;
                state.motion(live.rpm, live.speed, Date.now());
            }) });
        };

        /* ---------- demo (solo pantalla) ---------- */
        const t0 = Date.now();
        const demoOn = () => { const m = get('demo'); return m === 'on' || (m !== 'off' && !carSeen && Date.now() - t0 > 5000); };
        const demoState = new GearState();
        const total = DEMO_SCRIPT.reduce((n, s) => n + s[2], 0);
        const demoView = (now) => {
            let at = (now - t0) % total;
            const step = DEMO_SCRIPT.find((s) => { if (at < s[2]) return true; at -= s[2]; return false; });
            demoState.gearbox({ statusActualGearDrive: step[1] > 0 ? 'G' + step[1] : 'N_OR_P', statusActualStageDrive: step[0] === 'S' ? 'D' : step[0] }, now);
            demoState.programme({ displayProgramGearbox: step[0] === 'S' ? 'S_MINUS_PROGRAMM' : 'NONE' });
            return demoState.view(now);
        };

        /* ---------- dónde va cada cosa ---------- */
        const hudPlace = () => {
            const a = places.hud[get('hudPos')] || places.hud.right;
            const k = (Number(get('hudSize')) || 100) / 100 * cfg.hud.height / cfg.hud.size;
            return { cx: a[0] + (Number(get('hudX')) || 0), cy: a[1] + (Number(get('hudY')) || 0), k };
        };
        /** Que el texto no se salga de su destino: se desplaza dentro. */
        const inside = (items, k, w, h) => {
            if (!items.length) return items;
            const x0 = Math.min.apply(null, items.map((i) => i.x)), y0 = Math.min.apply(null, items.map((i) => i.y));
            const x1 = Math.max.apply(null, items.map((i) => i.x + i.w)), y1 = Math.max.apply(null, items.map((i) => i.y + i.h));
            const dx = x0 < 0 ? -x0 : x1 > w ? w - x1 : 0, dy = y0 < 0 ? -y0 : y1 > h ? h - y1 : 0;
            return items.map((i) => Object.assign({}, i, { x: i.x + dx, y: i.y + dy }));
        };
        /** El texto de una marcha (letra: 'D', 'S'...) colocado en una salida ya configurada, cada carácter con su color. */
        const placed = (kind, text, letter, p, w, h) => {
            const cellOf = out.cellOf(kind), mode = get('modeColours');
            const items = layout(cellOf, text, p.cx, p.cy, p.k, cfg.hud.gap).map((i) => {
                const c = cellOf(i.ch);
                return Object.assign(i, { w: c.w * i.k, h: c.h * i.k, role: roleOf(letter, i.ch, mode) });
            });
            return inside(items, p.k, w, h);
        };
        const nextToD = (v) => {
            const place = v.layout === 'sport' ? 'sport' : get('dPlace'), p = places.panel[place];
            // en M el cuadro ya muestra el número; en Sport, sin posición medida, mejor nada que un número fuera de sitio
            if (!p || !v.ready || !(v.letter === 'D' || v.letter === 'S') || !(v.digit >= 1 && v.digit <= 9)) return { items: [], keep: v.ready && (v.letter === 'D' || v.letter === 'S') && !!p };
            // (x, y): esquina de la celda de 96 px de ancho (estirada) que miden las posiciones; el número va centrado en ella
            const k = p.scale || 1, c = out.cellOf('nextToD')(String(v.digit));
            const x = p.x + (cfg.glyph.w * (cfg.glyph.stretch || 1) * k - c.w * k) / 2;
            return { items: [{ ch: String(v.digit), x, y: p.y, k }], keep: true };
        };

        /* ---------- el HUD con otras apps ---------- */
        let others = [], othersAt = 0;
        const standing = { on: null, at: 0 };
        const giveWay = (now) => {
            if (!get('hudGiveWay')) return false;
            if (now - othersAt > 1000) { others = HudClaim.others(ID); othersAt = now; }
            return others.length > 0;
        };

        /* ---------- bucle: 10 veces por segundo, con la pantalla abierta o cerrada ---------- */
        let view = state.view(Date.now(), { guess: get('guess') }), shown = { hud: '', cluster: '' };
        const stopCalib = (why) => { calib = 0; calibUntil = 0; out.grid('hud', false); out.grid('panel', false); if (why) message = why; };
        const tick = safely('tick', () => {
            const now = Date.now(), demo = demoOn(), show = get('show');
            view = demo ? demoView(now) : state.view(now, { guess: get('guess') });
            readySince = state.ready() && carSeen ? readySince || now : 0;
            if (get('guess') && !rpmWatched && readySince && now - readySince > RPM_AFTER_MS && !state.boxSeen && !state.selSeen) watchRpm();
            if (get('guess') && !rpmWatched && missing['de.bmw.infrastructure.VehicleInformation']) watchRpm();
            if (calib && (now > calibUntil || !(live.speed !== null && live.speed < CALIB_MAX_KMH))) stopCalib('Calibración terminada');

            const hudOn = (show === 'hud' || show === 'both') && !demo, clusterOn = (show === 'cluster' || show === 'both') && !demo;
            if (hudOn !== standing.on || now - standing.at > 30000) { HudClaim.standing(ID, hudOn); standing.on = hudOn; standing.at = now; }
            const night = live.night === true;
            const test = calib && CALIB_STEPS[calib] === 'test';
            const tv = test ? { ready: true, letter: 'D', digit: 8, layout: view.layout } : view;

            // HUD
            if (!hudOn) { out.off('hud'); shown.hud = ''; }
            else {
                out.grid('hud', CALIB_STEPS[calib] === 'grid');
                const text = tv.ready && (test || !giveWay(now)) ? hudText(tv, get) : '';
                out.configure('hud', rolesFor('hud', get, colourOf));
                out.draw('hud', placed('hud', text, tv.letter, hudPlace(), 800, 480), opacityOf(night, get('nightBright')));
                shown.hud = text;
            }
            // cuadro: junto a la D o en el centro
            const where = get('clusterPlace') === 'centre' ? 'centre' : 'nextToD';
            if (!clusterOn) { out.off('nextToD'); out.off('centre'); shown.cluster = ''; }
            else {
                out.off(where === 'centre' ? 'nextToD' : 'centre');
                out.grid('panel', CALIB_STEPS[calib] === 'grid' && where === 'nextToD');
                if (where === 'nextToD') {
                    out.configure('nextToD', rolesFor('nextToD', get, colourOf));
                    const w = nextToD(tv);
                    out.draw('nextToD', w.items, 1, w.keep);
                    shown.cluster = w.items.length ? w.items[0].ch : '';
                } else {
                    const text = tv.ready ? hudText(tv, get) : '';
                    const k = cfg.centre.height / cfg.hud.cellH;
                    out.configure('centre', rolesFor('centre', get, colourOf));
                    out.draw('centre', placed('centre', text, tv.letter, { cx: cfg.centre.anchor[0], cy: cfg.centre.anchor[1], k }, 1088, 480), 1);
                    shown.cluster = text;
                }
            }
        });
        setInterval(tick, 100);
        setInterval(safely('flush', () => recorder.flush()), 5000);

        /* ---------- botones ---------- */
        ui.onClick('BTN_CALIB', safely('calibrar', () => {
            const show = get('show');
            if (show === 'off') { message = 'Primero elige en Ajustes dónde mostrar la marcha'; return; }
            if (demoOn() || !(live.speed !== null && live.speed < CALIB_MAX_KMH)) { message = 'Solo con el coche parado'; return; }
            calib = (calib + 1) % CALIB_STEPS.length;
            calibUntil = calib ? Date.now() + CALIB_MS : 0;
            if (!calib) stopCalib('Calibración terminada');
            else message = CALIB_STEPS[calib] === 'grid' ? 'Rejilla en el HUD / cuadro: haz una foto' : 'Marcha de prueba (D8) en la posición actual';
        }));
        ui.onClick('BTN_RELOAD', safely('recargar', () => {
            const r = readPositionFile(path.join(ctx.dataDir, 'posicion.json'), base, log);
            places = r || base;
            message = r ? 'Posición cargada de posicion.json' : 'No hay un posicion.json válido: posiciones de fábrica';
        }));

        /* ---------- pantalla ---------- */
        function render() {
            const t = ctx.theme(), now = Date.now(), cv = ctx.canvas(W, H).clear(t.bg), v = view, demo = demoOn();
            const big = !v.letter ? '' : 'PRN'.indexOf(v.letter) >= 0 ? v.letter : v.letter + (v.digit >= 1 && v.digit <= 9 ? v.digit : '');
            // en S y M, con su color (el de "Color en S" / "Color en M"), como en el HUD
            const bigColour = (v.letter === 'S' || v.letter === 'M') && get('modeColours') !== 'off' ? colourOf(get(v.letter === 'S' ? 'sColour' : 'mColour'), get) : t.text;
            if (big) cv.text(big, 210, 300, 220, bigColour, { align: 'center', font: 'gear', literal: true });
            else cv.text('Sin marcha', 210, 240, 40, t.dim, { align: 'center', font: 'bold', literal: true });
            const src = { gearbox: 'Marcha del cambio', selection: 'Marcha de la palanca (DataPowerTrain2)', guess: 'Marcha estimada con rpm y velocidad' }[v.source] || 'Todavía sin marcha';
            cv.text(v.reason || src, 40, 380, 26, t.dim, { literal: true });
            cv.text(live.speed === null ? '- km/h' : Math.round(live.speed) + ' km/h', 40, 420, 26, t.dim, { literal: true });
            cv.text(rpmWatched ? (live.rpm === null ? '- rpm' : Math.round(live.rpm) + ' rpm') : '', 220, 420, 26, t.dim, { literal: true });

            // vista previa del HUD: la escena de 800x480 a la mitad, la zona visible del cristal y la marcha con su color
            const px = 470, py = 64, s = 0.5, vis = cfg.hud.visible;
            cv.fillRect(px, py, 800 * s, 480 * s, '#000000');
            cv.fillRect(px + vis.x * s, py + vis.y * s, vis.w * s, 1, '#303840'); cv.fillRect(px + vis.x * s, py + (vis.y + vis.h) * s, vis.w * s, 1, '#303840');
            cv.fillRect(px + vis.x * s, py + vis.y * s, 1, vis.h * s, '#303840'); cv.fillRect(px + (vis.x + vis.w) * s, py + vis.y * s, 1, vis.h * s, '#303840');
            // sin marcha que enseñar (aparcado, coche apagado), un D3 de ejemplo: el color y el sitio se ven igual
            const real = v.ready ? hudText(v, get) : '', letter = real ? v.letter : 'D', ht = real || hudText({ letter: 'D', digit: 3 }, get) || '3';
            const hp = hudPlace(), night = live.night === true, op = opacityOf(night, get('nightBright'));
            const roles = rolesFor('hud', get, colourOf), mode = get('modeColours'), size = cfg.hud.size * hp.k * s;
            const alpha = op < 1 ? Math.round(op * 255).toString(16).padStart(2, '0') : '';
            // carácter a carácter, cada uno con el color de su papel (S en rojo, M en naranja...)
            const opt = { font: 'gear', literal: true }, gapPx = cfg.hud.gap * hp.k * s;
            const widths = ht.split('').map((ch) => cv.textWidth(ch, size, opt));
            let pen = px + hp.cx * s - (widths.reduce((a, b) => a + b, 0) + gapPx * (widths.length - 1)) / 2;
            const base = py + (hp.cy + (cfg.hud.baseline - cfg.hud.cellH / 2) * hp.k) * s;
            ht.split('').forEach((ch, i) => {
                const r = roles[roleOf(letter, ch, mode)] || roles.base;
                cv.text(ch, pen, base, size, r.colour + alpha, opt);
                pen += widths[i] + gapPx;
            });
            cv.text('Vista previa del HUD' + (real ? '' : ' (ejemplo)') + (night ? ', de noche' : ''), px, py + 480 * s + 30, 22, t.dim, { literal: true });

            // estado
            const x2 = 920;
            let y = 96;
            const line = (txt, c) => { cv.text(txt, x2, y, 24, c || t.text, { literal: true }); y += 36; };
            const show = get('show');
            line('Mostrar: ' + ({ off: 'en ningún sitio (solo registra)', hud: 'HUD', cluster: 'cuadro', both: 'HUD y cuadro' }[show] || show), show === 'off' ? t.warn : t.text);
            if (demo) line('Datos de demo: solo en esta pantalla, nunca en el HUD ni en el cuadro', t.accent);
            line('HUD: ' + out.describe('hud') + (giveWay(now) ? '  ·  cedido a ' + others.join(', ') : ''), t.dim);
            line('Cuadro: ' + out.describe(get('clusterPlace') === 'centre' ? 'centre' : 'nextToD'), t.dim);
            line('Coche: ' + (state.condition === undefined ? 'sin estado' : state.condition === null ? 'estado desconocido' : state.ready() ? 'listo' : 'estado ' + state.condition) +
                (live.night === null ? '' : live.night ? '  ·  noche' : '  ·  día'), t.dim);
            const rows = ['statusGearboxDrive', 'DataPowerTrain2', 'dataDisplayGearbox', 'VehicleCondition'];
            rows.forEach((n) => {
                const age = live.lastAt[n] ? 'hace ' + Math.round((now - live.lastAt[n]) / 1000) + ' s' : 'nunca';
                line(n + '  ×' + (live.counts[n] || 0) + '  ' + age, t.dim);
            });
            if (Object.keys(missing).length) line('No están en este coche: ' + Object.keys(missing).map((i) => i.split('.').pop()).join(', '), t.warn);
            if (state.disagreements) line('Las dos señales de marcha discrepan: ' + state.disagreements, t.warn);
            if (message) cv.text(message, 40, 490, 26, t.accent, { literal: true });
            G.frame(cv, t, ['GearHUD'], 0, [demo && { text: 'DEMO' }, calib && { text: 'CALIBRANDO' }]);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 4, render);
        Promise.resolve().then(render).catch((e) => log.warn('primer fotograma: ' + e));
    },
});

