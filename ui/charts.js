import { qrPath } from './qr.js';
import { s, h, anim } from './lib.js';
import { SPRITES as SP } from './linesprites.js';
import { stationOf, nextStep, dwellFor } from './journey.js';

// Dependency-free SVG/DOM visuals. Colours come from CSS classes so both themes work. No inline style attributes (strict CSP):
// geometry goes in SVG attributes, animation timing through the CSSOM.

// Digits that roll up from 0 to the value on mount (the DOM is rebuilt on each data change, so this plays on every new render).
export function odometer(value, pad = 2) {
  const str = String(Math.max(0, Math.round(value ?? 0))).padStart(pad, '0');
  const cols = [...str].map((d) => { const strip = h('span', { class: 'odo-strip' }, [...'0123456789'].map((x) => h('i', {}, x))); strip.dataset.d = d; return h('span', { class: 'odo-col' }, strip); });
  const el = h('span', { class: 'odo', 'aria-label': String(value) }, ...cols, h('span', { class: 'sr' }, String(Math.max(0, Math.round(value ?? 0)))));
  const set = () => cols.forEach((c, i) => { c.firstChild.style.transitionDelay = `${i * 70}ms`; c.firstChild.style.transform = `translateY(${-Number(c.firstChild.dataset.d) * 10}%)`; });
  if (anim.on) requestAnimationFrame(() => requestAnimationFrame(set)); // roll up from 0 only when arriving on the page
  else { cols.forEach((c) => { c.firstChild.style.transition = 'none'; }); set(); } // background refresh: show the value, no replay
  return el;
}

// ── Station glyphs: 24-unit monoline icons (one stroke weight, round caps). Each has named parts so CSS can animate them when its
// station is active. The same glyphs are used on the line (animated) and the run page route sheet (static).
const P = (d, cls) => s('path', { d, ...(cls ? { class: cls } : {}) });
const GLYPHS = {
  claim: () => [P('M7 5H5.5A1.5 1.5 0 004 6.5v13A1.5 1.5 0 005.5 21h13a1.5 1.5 0 001.5-1.5v-13A1.5 1.5 0 0018.5 5H17'), s('rect', { x: 8, y: 2.5, width: 8, height: 4.5, rx: 1.2, class: 'clip' }), P('M8 14l2.8 2.8L16 11.2', 'tick')],
  sandbox: () => [P('M4 7.5v9L12 21l8-4.5v-9M12 12v9'), P('M4 7.5L12 3l8 4.5-8 4.5z', 'lid')],
  agent: () => { const pins = ['M9 3v3', 'M15 3v3', 'M9 18v3', 'M15 18v3', 'M3 9h3', 'M3 15h3', 'M18 9h3', 'M18 15h3'].map((d, i) => { const e = P(d, 'pin'); e.style.animationDelay = `${i * 0.13}s`; return e; });
    return [s('rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }), s('rect', { x: 10, y: 10, width: 4, height: 4, rx: 0.8, class: 'core' }), ...pins]; },
  verify: () => [s('g', { class: 'glass' }, s('circle', { cx: 10.5, cy: 10.5, r: 6.2 }), P('M15.2 15.2L20.5 20.5'), P('M7.8 10.6l2 2 3.6-4', 'tick'))],
  review: () => [s('g', { class: 'glass' }, P('M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z'), s('circle', { cx: 12, cy: 12, r: 3 }))],
  push: () => [P('M4 15.5v3a1.5 1.5 0 001.5 1.5h13a1.5 1.5 0 001.5-1.5v-3'), s('g', { class: 'arrow' }, P('M12 15V4'), P('M7.5 8.5L12 4l4.5 4.5'))],
  ship: () => [s('g', { class: 'plane' }, P('M21 3L3 10.5l7 2.5 2.5 7z'), P('M21 3L10 13')), P('M3.5 20.5h6', 'ground')],
};
const glyphKey = (k) => (k === 'pr' ? 'ship' : k === 'visual' ? 'review' : k); // the pipeline calls the last stage `pr`; on screen it is "Ship"
export const stationGlyph = (key, size = 22) => { const k = glyphKey(key); return s('svg', { viewBox: '0 0 24 24', width: size, height: size, class: `ic ic-${k}`, 'aria-hidden': 'true' }, ...(GLYPHS[k] ?? GLYPHS.claim)()); };

// The assembly line. Built ONCE and updated in place: tickets slide from the hopper to their station and on to the chute, the belt keeps
// running, and nothing is torn down between refreshes (rebuilding the SVG every few seconds is what made it jitter and "bounce").
const TICKET = 'M0 0H46V9a4.5 4.5 0 000 9V30H0V18a4.5 4.5 0 000-9Z';
export function createLine(stages) {
  const W = 1200, H = 262, BY = 168, X0 = 250, DX = 138, HOP = 85, CHUTE = 1121;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'line-svg', role: 'img' });
  svg.append(s('defs', {}, s('pattern', { id: 'haz', width: 18, height: 18, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(-45)' }, s('rect', { width: 9, height: 18, class: 'haz-a' }))));
  for (let x = 0; x <= W; x += 60) svg.append(s('line', { x1: x, y1: 0, x2: x, y2: H, class: 'l-grid' }));
  svg.append(s('rect', { x: 150, y: BY - 12, width: 910, height: 24, class: 'l-belt-bed' }), s('line', { x1: 150, y1: BY, x2: 1060, y2: BY, class: 'l-belt' }));
  // hopper (queued) and chute (shipped): fixed slots whose visibility changes
  svg.append(s('path', { d: 'M24 56H146L120 148H50Z', class: 'l-bin' }), s('rect', { x: 1066, y: 56, width: 110, height: 92, class: 'l-bin' }));
  const hop = Array.from({ length: 5 }, (_, i) => s('path', { d: TICKET, transform: `translate(${50 + i * 6} ${64 + i * 13}) scale(.9)`, class: `l-ticket l-slot ${i === 0 ? 'on' : ''}` }));
  const ship = Array.from({ length: 4 }, (_, i) => s('path', { d: TICKET, transform: `translate(${1086 + i * 5} ${64 + i * 17}) scale(.82)`, class: 'l-ticket l-ship l-slot' }));
  svg.append(...hop, ...ship);
  const qText = s('text', { x: HOP, y: 200, class: 'l-big' }, '0'), qLabel = s('text', { x: HOP, y: 222, class: 'l-label' }, 'tickets waiting');
  const sText = s('text', { x: CHUTE, y: 200, class: 'l-big l-ship-big' }, '0');
  svg.append(s('text', { x: HOP, y: 36, class: 'l-label' }, 'Hopper'), qText, qLabel, s('text', { x: CHUTE, y: 36, class: 'l-label' }, 'Shipped'), sText, s('text', { x: CHUTE, y: 222, class: 'l-label' }, 'PRs today'));
  const stationEls = stages.map(([key, name], i) => { const g = s('g', { class: 'l-station', transform: `translate(${X0 + i * DX} 0)` },
    s('text', { x: 0, y: 30, class: 'l-code', 'text-anchor': 'middle' }, `0${i + 1}`),
    s('g', { transform: 'translate(-20 36) scale(1.67)' }, s('g', { class: `ic ic-${glyphKey(key)}` }, ...GLYPHS[glyphKey(key)]())),
    s('path', { d: `M-38 ${BY + 14} V98 H38 V${BY + 14}`, class: 'l-gantry' }), s('circle', { cx: 0, cy: 98, r: 5.5, class: 'l-lamp' }), s('text', { x: 0, y: BY + 40, class: 'l-name' }, name)); svg.append(g); return g; });
  const layer = s('g', { class: 'l-parts' }); svg.append(layer);
  const pausedG = s('g', { class: 'svg-hide' }, s('rect', { x: 150, y: BY - 12, width: 910, height: 24, class: 'l-warn' }), s('text', { x: 605, y: 48, class: 'l-paused' }, 'LINE PAUSED')); svg.append(pausedG);

  const parts = new Map(); let ready = false; const last = { q: null, s: null };
  const place = (g, x, y) => { g.style.transform = `translate(${x}px, ${y}px)`; };
  const setCount = (el, key, v) => { if (last[key] === v) return; el.textContent = String(v); if (last[key] !== null) { el.classList.remove('l-flash'); void el.getBoundingClientRect(); el.classList.add('l-flash'); } last[key] = v; };
  const makePart = (a) => { const g = s('g', { class: 'l-part-g' }, s('g', { class: 'bob' }, s('path', { d: TICKET, class: 'l-part', transform: 'translate(-23 0)' }), s('line', { x1: -14, y1: 11, x2: 14, y2: 11, class: 'l-part-line' }), s('line', { x1: -14, y1: 19, x2: 6, y2: 19, class: 'l-part-line' })), s('text', { x: 0, y: -11, class: 'l-title' })); layer.append(g); return { g, label: g.lastChild }; };

  function update({ queued = 0, shipped = 0, active = [], paused = false }) {
    svg.classList.toggle('running', active.length > 0 && !paused);
    svg.setAttribute('aria-label', `Assembly line: ${queued} queued, ${active.length} in progress, ${shipped} shipped today`);
    hop.forEach((e, i) => e.classList.toggle('show', i < Math.min(queued, 5))); ship.forEach((e, i) => e.classList.toggle('show', i < Math.min(shipped, 4)));
    setCount(qText, 'q', queued); setCount(sText, 's', shipped); qLabel.textContent = queued === 1 ? 'ticket waiting' : 'tickets waiting';
    pausedG.classList.toggle('svg-hide', !paused);
    const per = {}; const seen = new Set(); const lit = new Set();
    for (const a of active) {
      seen.add(a.run); const si = Math.max(0, stages.findIndex(([k]) => k === a.phase)); lit.add(si); const k = (per[si] = (per[si] ?? -1) + 1);
      const x = X0 + si * DX, y = BY - 46 - k * 38; let p = parts.get(a.run);
      if (!p) { p = makePart(a); parts.set(a.run, p); p.g.style.transition = 'none'; place(p.g, ready ? HOP : x, ready ? 96 : y); void p.g.getBoundingClientRect(); p.g.style.transition = ''; } // new job: appears IN the hopper, then slides out
      const t = a.title ?? ''; const short = t.length > 22 ? `${t.slice(0, 21)}…` : t; if (p.label.textContent !== short) p.label.textContent = short;
      place(p.g, x, y);
    }
    for (const [id, p] of parts) if (!seen.has(id)) { parts.delete(id); place(p.g, CHUTE, 100); p.g.style.opacity = '0'; setTimeout(() => p.g.remove(), 1200); } // finished: rides into the shipped chute
    stationEls.forEach((g, i) => g.classList.toggle('on', lit.has(i)));
    ready = true;
  }
  return { svg, update };
}

// 14-bar mini history for a project cell.
export function miniBars(values, { w = 280, h: ht = 38 } = {}) {
  const max = Math.max(1, ...values), bw = w / values.length;
  const svg = s('svg', { viewBox: `0 0 ${w} ${ht}`, class: 'mini', preserveAspectRatio: 'none', 'aria-hidden': 'true' }, s('line', { x1: 0, x2: w, y1: ht - 0.5, y2: ht - 0.5 }));
  values.forEach((v, i) => { const hh = v ? Math.max(4, (v / max) * (ht - 4)) : 2; svg.append(s('rect', { x: i * bw + 1.5, y: ht - hh, width: bw - 3, height: hh, class: v ? '' : 'z' })); });
  return svg;
}

// Daily stacked bars: shipped / failed / needed-info.
export function bars(days, { height = 170 } = {}) {
  const W = 640, pad = { l: 28, r: 6, t: 10, b: 22 }, iw = W - pad.l - pad.r, ih = height - pad.t - pad.b;
  const max = Math.max(3, ...days.map((d) => d.ok + d.failed + d.neutral)), bw = iw / days.length, gap = Math.min(8, bw * 0.3);
  const tip = h('div', { class: 'tip', hidden: true }); const wrap = h('div', { class: 'chart' }, tip);
  const svg = s('svg', { viewBox: `0 0 ${W} ${height}`, class: 'bars', role: 'img', 'aria-label': 'Runs per day' });
  [0, 0.5, 1].forEach((f) => { const y = pad.t + ih - f * ih; svg.append(s('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, class: 'gl' }), s('text', { x: pad.l - 7, y: y + 3, class: 'ax', 'text-anchor': 'end' }, Math.round(max * f))); });
  days.forEach((d, i) => {
    const x = pad.l + i * bw + gap / 2, w = bw - gap; let y = pad.t + ih;
    const seg = (n, cls) => { if (!n) return; const hh = (n / max) * ih; y -= hh; svg.append(s('rect', { x, y, width: w, height: hh, class: `bar ${cls}` })); };
    seg(d.ok, 'ok'); seg(d.failed, 'bad'); seg(d.neutral, 'neu');
    const hit = s('rect', { x: pad.l + i * bw, y: pad.t, width: bw, height: ih, class: 'hit' });
    hit.addEventListener('mouseenter', () => { tip.hidden = false; tip.replaceChildren(h('b', {}, new Date(d.date + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })), h('div', {}, h('i', { class: 'sw ok' }), `${d.ok} shipped`), h('div', {}, h('i', { class: 'sw bad' }), `${d.failed} failed`), h('div', {}, h('i', { class: 'sw neu' }), `${d.neutral} needed info`)); tip.style.left = `${((pad.l + i * bw + bw / 2) / W) * 100}%`; });
    hit.addEventListener('mouseleave', () => { tip.hidden = true; });
    svg.append(hit);
    if (i % Math.ceil(days.length / 7) === 0 || i === days.length - 1) svg.append(s('text', { x: pad.l + i * bw + bw / 2, y: height - 6, class: 'ax', 'text-anchor': 'middle' }, new Date(d.date + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })));
  });
  wrap.append(svg); return wrap;
}

// A real, scannable QR code for a finished run: it opens the pull request when there is one, otherwise it carries the run's repo, ticket and status as text.
// Always dark on white with a quiet zone, whatever the theme, because scanners need the contrast.
export function scanCode(run, link) {
  const text = link || `agent-factory work order ${run.id} | ${run.repo ?? 'repo unknown'} | ticket #${run.ticket ?? '?'} | ${run.status ?? 'unknown'}`;
  const { d, size } = qrPath(text, 'L');
  const svg = s('svg', { viewBox: `0 0 ${size} ${size}`, class: 'scancode', role: 'img', 'aria-label': link ? 'QR code: opens the pull request' : 'QR code: run details' });
  svg.append(s('rect', { width: size, height: size, rx: 1.5, fill: '#fff' }), s('path', { d, fill: '#111' }));
  return svg;
}

// ---- The Line. Same contract as createLine (an svg and update({ queued, shipped, active, paused })).
// The machines are cut from the artwork the Line is based on (design/line-reference.png, see scripts/make-line-sprites.py) so they keep its photographic look; everything that moves is a
// separate layer on top: the belt surface scrolls, the robot arm swings from its shoulder, the press head comes down, scan beams sweep, and each parcel is a real object that rides the belt
// and is worked on at every station. Everything is laid out in the artwork's own pixel space (viewBox 1672 wide) on an exact grid: the hopper, six machines and the bin are eight evenly spaced
// slots, and the belt legs are evenly spaced under the belt. Built once and updated in place.
const ART = 'art/';
export function createLine3D(stages) {
  const VX = 0, VY = 128, W = 1672, H = 414, SLOT0 = 140, PITCH = (1552 - 140) / 7, BELT0 = 222, BELT1 = 1446, LANE = 394;
  const svg = s('svg', { viewBox: `${VX} ${VY} ${W} ${H}`, class: 'line-svg lineart', role: 'img' });
  const slotX = (i) => SLOT0 + i * PITCH; const stX = (i) => slotX(i + 1);
  const img = (name, dx = 0, dy = 0, extra = {}) => { const b = SP[name]; return s('image', { href: `${ART}${name}.webp`, x: b[0] + dx, y: b[1] + dy, width: b[2] - b[0], height: b[3] - b[1], ...extra }); };
  const grad = (id, stops, x2 = 0, y2 = 1) => s('linearGradient', { id, x1: 0, y1: 0, x2, y2 }, ...stops.map(([o, c, a]) => s('stop', { offset: o, 'stop-color': c, ...(a != null ? { 'stop-opacity': a } : {}) })));
  const glyph = (key, x, y, sc = 1.9) => s('g', { transform: `translate(${x - 12 * sc} ${y - 12 * sc}) scale(${sc})`, class: `ln-glyph ic ic-${glyphKey(key)}` }, ...GLYPHS[glyphKey(key)]());
  svg.append(s('defs', {},
    grad('ln-steel', [[0, '#9aa0a8'], [0.5, '#5a5e65'], [1, '#2d2f33']]), grad('ln-orange', [[0, '#ff9a5c'], [1, '#e8480c']]), grad('ln-beam', [[0, '#7fdcff', 0], [0.5, '#c8f3ff', 0.95], [1, '#7fdcff', 0]], 1, 0),
    grad('ln-floor', [[0, '#000', 0.55], [1, '#000', 0]]), grad('ln-inner', [[0, '#34373b'], [0.45, '#1d1f22'], [1, '#101113']]),
    s('radialGradient', { id: 'ln-blue', cx: 0.5, cy: 0.55, r: 0.65 }, s('stop', { offset: 0, 'stop-color': '#6fd0ff', 'stop-opacity': 0.85 }), s('stop', { offset: 1, 'stop-color': '#6fd0ff', 'stop-opacity': 0 })),
    s('radialGradient', { id: 'ln-warm', cx: 0.5, cy: 0.5, r: 0.5 }, s('stop', { offset: 0, 'stop-color': '#ffb066', 'stop-opacity': 0.95 }), s('stop', { offset: 1, 'stop-color': '#ff6a1f', 'stop-opacity': 0 })),
    s('radialGradient', { id: 'ln-shadow', cx: 0.5, cy: 0.5, r: 0.5 }, s('stop', { offset: 0, 'stop-color': '#000', 'stop-opacity': 0.6 }), s('stop', { offset: 1, 'stop-color': '#000', 'stop-opacity': 0 })),
    s('clipPath', { id: 'ln-belt-top' }, s('rect', { x: BELT0 + 55, y: 360, width: BELT1 - BELT0 - 110, height: 44 })), s('clipPath', { id: 'ln-belt-front' }, s('rect', { x: BELT0 + 55, y: 404, width: BELT1 - BELT0 - 110, height: 40 })),
    s('clipPath', { id: 'ln-hopper-hole' }, s('polygon', { points: '48,254 212,254 173,338 87,338' }))));

  // ---- floor shadow, belt (caps, scrolling top, front, evenly spread legs)
  svg.append(s('ellipse', { cx: 834, cy: 488, rx: 640, ry: 22, fill: 'url(#ln-shadow)' }));
  const legs = Array.from({ length: 6 }, (_, k) => 312 + k * ((BELT1 - BELT0 - 180) / 5));
  for (const lx of legs) svg.append(img('belt-leg', lx - 475 + 0, 0, { x: lx - 23 }));
  svg.style.setProperty('--tw', `${SP['belt-top'][2] - SP['belt-top'][0]}px`); const scroll = s('g', { class: 'ln-scroll' }); const TW = SP['belt-top'][2] - SP['belt-top'][0]; const tiles = Math.ceil((BELT1 - BELT0 - 110) / TW) + 2;
  for (let k = -1; k < tiles; k++) scroll.append(img('belt-top', BELT0 + 55 - SP['belt-top'][0] + k * TW, 0));
  const front = s('g', { 'clip-path': 'url(#ln-belt-front)' }); for (let k = 0; k < tiles; k++) front.append(img('belt-front', BELT0 + 55 - SP['belt-front'][0] + k * TW, 0));
  svg.append(front, s('g', { 'clip-path': 'url(#ln-belt-top)' }, scroll), img('belt-cap-l', BELT0 - SP['belt-cap-l'][0], 0), s('g', { transform: `translate(${BELT1 + BELT0} 0) scale(-1 1)` }, img('belt-cap-l', BELT0 - SP['belt-cap-l'][0], 0)));
  svg.append(s('rect', { x: BELT0 + 55, y: 366, width: BELT1 - BELT0 - 110, height: 26, fill: 'url(#ln-floor)', opacity: 0.0 }));

  // ---- hopper: a cut-away bin, parcels pile up from the bottom inside it
  const HX = slotX(0) - 139.5; // artwork's hopper centre is x 139.5
  const hopG = s('g', { transform: `translate(${HX - 0} 0)` });
  const hopPile = s('g', { 'clip-path': 'url(#ln-hopper-hole)' });
  hopG.append(s('polygon', { points: '44,250 216,250 176,342 84,342', fill: 'url(#ln-inner)' }), s('polygon', { points: '44,250 216,250 212,262 48,262', fill: '#000', opacity: 0.5 }), hopPile, img('hopper'));
  svg.append(s('ellipse', { cx: slotX(0), cy: 400, rx: 120, ry: 12, fill: 'url(#ln-shadow)' }), hopG);
  const PILE = [[108, 336], [148, 336], [128, 309], [98, 309], [158, 309]]; const pileEls = PILE.map(([x, y]) => s('g', { class: 'ln-pile', transform: `translate(${x} ${y}) scale(.5)` }, s('image', { href: `${ART}parcel.webp`, x: -38, y: -58, width: 76, height: 58 })));
  hopPile.append(...pileEls);

  // ---- shipped bin: frame, with the stack of green trays growing inside it
  const BX = slotX(7) - 1544;
  const binG = s('g', { transform: `translate(${BX} 0)` }); const trayClip = s('clipPath', { id: 'ln-trays-clip' }, s('rect', { x: 1460, y: 322, width: 176, height: 70 })); svg.firstChild.append(trayClip);
  binG.append(s('rect', { x: 1462, y: 224, width: 166, height: 164, fill: '#070d0a' }), s('g', { 'clip-path': 'url(#ln-trays-clip)' }, img('bin-trays')), img('bin-frame'), s('rect', { x: 1440, y: 202, width: 208, height: 208, rx: 8, class: 'ln-bin-glow' }));
  svg.append(s('ellipse', { cx: slotX(7), cy: 414, rx: 110, ry: 12, fill: 'url(#ln-shadow)' }), binG);
  const TRAY_TOP = [324, 294, 264, 238]; // where the top of each tray in the stack starts (artwork y)

  // ---- the six machines, each a sprite plus its own moving layers (artwork coordinates; the group is shifted onto its grid slot)
  const ART_C = { claim: 385, sandbox: 580, agent: 760, verify: 952, push: 1133, pr: 1312 };
  const lamp = (x, y, w, h) => s('rect', { x, y, width: w, height: h, rx: 2, fill: 'url(#ln-orange)', class: 'ln-glow' });
  const MACH = {
    claim: () => [img('claim'),
      s('g', { 'clip-path': 'url(#ln-claim-clip)' }, s('g', { class: 'ln-shimmer' }, ...Array.from({ length: 9 }, (_, i) => s('rect', { x: 330, y: 250 + i * 10, width: 116, height: 4, fill: '#fff', opacity: 0.5 })))),
      lamp(316, 338, 8, 30), lamp(446, 338, 8, 30),
      ...[0, 1].map((i) => s('g', { class: `ln-slip ln-slip${i}`, transform: 'translate(385 270)' }, s('rect', { x: -12, y: -7, width: 24, height: 14, rx: 1.5, fill: '#f8f4e8', stroke: '#b9b3a2', 'stroke-width': 1 }), s('rect', { x: -8, y: -3, width: 12, height: 2, fill: '#8d887a' }), s('rect', { x: -8, y: 1, width: 8, height: 2, fill: '#8d887a' })))],
    sandbox: () => [img('sandbox'), s('rect', { x: 532, y: 258, width: 92, height: 84, fill: 'url(#ln-blue)', class: 'ln-blueglow' }), s('rect', { x: 534, y: 258, width: 88, height: 3, fill: '#bdeaff', class: 'ln-sweep' }), lamp(639, 272, 8, 14)],
    agent: () => { const J1 = [772, 317], J2 = [731, 263], J3 = [804, 227]; const part = (name, j) => s('image', { href: `${ART}${name}.webp`, x: SP[name][0] - j[0], y: SP[name][1] - j[1], width: SP[name][2] - SP[name][0], height: SP[name][3] - SP[name][1] });
      // a real jointed arm: the lower arm turns at the shoulder, the upper arm at the elbow (inside the lower arm's turn), the wrist and gripper at the wrist (inside both). Each part is drawn under the ball of the joint it hangs from.
      const arm = s('g', { transform: `translate(${J1[0]} ${J1[1]})` }, s('g', { class: 'ln-lower' }, s('g', { transform: `translate(${J2[0] - J1[0]} ${J2[1] - J1[1]})` }, s('g', { class: 'ln-upper' }, s('g', { transform: `translate(${J3[0] - J2[0]} ${J3[1] - J2[1]})` }, s('g', { class: 'ln-wristg' }, part('robot-wrist', J3))), part('robot-upper', J2))), part('robot-lower', J1)));
      return [img('robot-base'), arm, s('g', { class: 'ln-sparks', transform: 'translate(812 337)' }, s('circle', { cx: -3, cy: 2, r: 3, fill: '#ffd98a' }), s('circle', { cx: 6, cy: -3, r: 2.2, fill: '#ff9a4c' }), s('circle', { cx: 1, cy: -8, r: 1.8, fill: '#fff6d6' }), s('circle', { cx: -9, cy: -5, r: 1.6, fill: '#ffb366' }))]; },
    verify: () => [img('gate'), s('circle', { cx: 955, cy: 250, r: 15, fill: 'url(#ln-blue)', class: 'ln-lens' }), s('rect', { x: 909, y: 280, width: 5, height: 70, fill: '#fff', class: 'ln-glow' }), s('rect', { x: 990, y: 280, width: 5, height: 70, fill: '#fff', class: 'ln-glow' }),
      s('g', { class: 'ln-scan' }, s('rect', { x: -9, y: 262, width: 18, height: 130, fill: 'url(#ln-beam)' }), s('rect', { x: -1, y: 262, width: 2, height: 130, fill: '#eefaff' })), s('circle', { cx: 984, cy: 249, r: 4, class: 'ln-vlight' })],
    push: () => [img('push'), s('g', { 'clip-path': 'url(#ln-push-clip)' }, s('g', { class: 'ln-rollglint' }, ...Array.from({ length: 8 }, (_, i) => s('rect', { x: 1060, y: 250 + i * 18, width: 160, height: 3, fill: '#fff', opacity: 0.45, transform: 'skewY(-4)' })))),
      ...[[1155, 354], [1144, 318], [1132, 282]].map(([x, y], i) => s('path', { d: 'M-11 5 L0 -6 L11 5', class: `ln-chev ln-chev${i}`, transform: `translate(${x} ${y}) rotate(-19)` })),
      ...[0, 1].map((i) => s('g', { class: `ln-ghost ln-ghost${i}`, transform: 'translate(1160 374)' }, s('rect', { x: -9, y: -12, width: 18, height: 12, rx: 1.5, fill: '#ffb066', opacity: 0.9 }), s('rect', { x: -9, y: -12, width: 18, height: 12, rx: 1.5, fill: 'none', stroke: '#fff', 'stroke-width': 1.2, opacity: 0.8 })))],
    pr: () => [img('press'), s('g', { class: 'ln-head' }, s('rect', { x: 1305, y: 244, width: 12, height: 40, fill: 'url(#ln-steel)' }), s('rect', { x: 1272, y: 280, width: 78, height: 17, rx: 2, fill: 'url(#ln-steel)', stroke: '#15161a', 'stroke-width': 1.2 }), s('rect', { x: 1272, y: 293, width: 78, height: 4, fill: 'url(#ln-orange)', class: 'ln-glow' }), s('rect', { x: 1272, y: 280, width: 78, height: 3, fill: '#fff', opacity: 0.35 }))],
  };
  svg.firstChild.append(s('clipPath', { id: 'ln-claim-clip' }, s('polygon', { points: '346,262 432,262 440,334 336,334' })), s('clipPath', { id: 'ln-push-clip' }, s('polygon', { points: '1098,262 1172,262 1200,392 1086,392' })));
  const stationEls = [], names = [], overlays = [], sprites = [];
  stages.forEach(([key, name], i) => { const X = stX(i); const dx = X - (ART_C[key] ?? 385); const m = (MACH[key] ?? MACH.claim)();
    const sprite = s('g', { class: 'ln-station', transform: `translate(${dx} 0)` }, m[0]); sprites.push(sprite);
    const rest = s('g', { class: 'ln-station ln-over', transform: `translate(${dx} 0)` }, ...m.slice(1)); overlays.push(rest);
    if (key === 'agent') { sprite.append(...[]); }
    stationEls.push(sprite, rest);
    names.push(s('text', { x: X, y: 512, class: 'ln-name', 'text-anchor': 'middle' }, name.toUpperCase()));
  });
  // the sandbox's force field sits around the parcel and the press/lift effects need the parcel position, so they live in the parcel overlay layer
  const fieldX = stX(stages.findIndex(([k]) => k === 'sandbox')); const field = s('g', { class: 'ln-field', transform: `translate(${fieldX} ${LANE})` }, s('g', { class: 'ln-fieldin' }, s('ellipse', { rx: 54, ry: 10, class: 'ln-ring' }), s('path', { d: 'M-54 0 A54 70 0 0 1 54 0', class: 'ln-dome' }), s('path', { d: 'M-54 0 A54 70 0 0 1 54 0 Z', fill: 'rgba(110,200,255,.12)' })));
  const liftX = stX(stages.findIndex(([k]) => k === 'push')); const lift = s('g', { class: 'ln-lift', transform: `translate(${liftX} ${LANE})` }, s('ellipse', { rx: 50, ry: 8, fill: 'url(#ln-warm)' }), s('rect', { x: -30, y: -70, width: 60, height: 70, fill: 'url(#ln-warm)', opacity: 0.4 }));
  const pressX = stX(stages.findIndex(([k]) => k === 'pr'));
  svg.append(...sprites);
  const layer = s('g', { class: 'ln-parts' }); svg.append(layer, field, lift, ...overlays);

  // ---- labels, numbers, glyphs (live text over the artwork)
  const qText = s('text', { x: slotX(0), y: 496, class: 'ln-big', 'text-anchor': 'middle' }, '0'), qLabel = s('text', { x: slotX(0), y: 526, class: 'ln-label', 'text-anchor': 'middle' }, 'TICKETS WAITING');
  const sText = s('text', { x: slotX(7), y: 496, class: 'ln-big ship', 'text-anchor': 'middle' }, '0');
  svg.append(s('text', { x: slotX(0), y: 168, class: 'ln-title', 'text-anchor': 'middle' }, 'HOPPER'), qText, qLabel, s('text', { x: slotX(7), y: 168, class: 'ln-title', 'text-anchor': 'middle' }, 'SHIPPED'), sText, s('text', { x: slotX(7), y: 526, class: 'ln-label', 'text-anchor': 'middle' }, 'PRS TODAY'), ...names);
  const glyphs = stages.map(([key], i) => glyph(key, stX(i), 168)); svg.append(...glyphs);
  for (let i = 1; i < stages.length; i++) { const x = (stX(i - 1) + stX(i)) / 2; svg.append(s('line', { x1: x, y1: 490, x2: x, y2: 526, class: 'ln-sep' })); }
  const labels = s('g', { class: 'ln-parts ln-labels' }); svg.append(labels);
  const pausedG = s('g', { class: 'svg-hide' }, s('rect', { x: BELT0, y: 362, width: BELT1 - BELT0, height: 80, class: 'ln-pausewash' }), s('text', { x: 834, y: 300, class: 'ln-paused', 'text-anchor': 'middle' }, 'LINE PAUSED')); svg.append(pausedG);

  // ---- a parcel: the cardboard box from the artwork. It picks up a label, a code stripe, a check mark and a strap as it goes down the line.
  const OFF = { agent: 52 }; const lane = (key) => (key === 'pr' ? 362 : LANE);
  const parts = new Map(); let ready = false; let timer = null; let pausedNow = false; const keys0 = stages.map(([k]) => k); const HOPPER_MOUTH = BELT0 + 20; const last = { q: null, s: null }; const place = (g, x, y) => { g.style.transform = `translate(${x}px, ${y}px)`; };
  const setCount = (el, key, v) => { if (last[key] === v) return; el.textContent = String(v); if (last[key] !== null) { el.classList.remove('l-flash'); void el.getBoundingClientRect(); el.classList.add('l-flash'); } last[key] = v; };
  const makePart = () => { const inner = s('g', { class: 'bob' }, s('image', { href: `${ART}parcel.webp`, x: -38, y: -58, width: 76, height: 58 }),
      s('g', { class: 'p-label' }, s('rect', { x: -27, y: -34, width: 26, height: 17, fill: '#f8f4e8', stroke: '#b9b3a2', 'stroke-width': 0.8 }), s('rect', { x: -23, y: -29, width: 17, height: 2.2, fill: '#8d887a' }), s('rect', { x: -23, y: -24, width: 11, height: 2.2, fill: '#8d887a' })),
      s('rect', { x: -28, y: -10, width: 52, height: 4, rx: 1, fill: '#1fbf7e', class: 'p-code' }), s('g', { class: 'p-check' }, s('circle', { cx: 17, cy: -21, r: 8.5, fill: '#3be0a1', stroke: '#07130e', 'stroke-width': 1 }), s('path', { d: 'M12.5 -21L16 -17.5L22 -25', fill: 'none', stroke: '#07130e', 'stroke-width': 2.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })),
      s('rect', { x: -3, y: -50, width: 11, height: 49, fill: '#2fe0a0', opacity: 0.85, class: 'p-tape' }));
    const g = s('g', { class: 'l-part-g' }, s('g', { transform: 'scale(.96)' }, inner)); layer.append(g); const lab = s('g', { class: 'l-part-g l-lab' }, s('text', { x: 0, y: 0, class: 'ln-part-label', 'text-anchor': 'middle' }, '')); labels.append(lab); return { g, inner, lab, label: lab.firstChild }; };
  function update({ queued = 0, shipped = 0, active = [], paused = false, ends = {} }) {
    svg.classList.toggle('shipping', shipped > 0);
    svg.setAttribute('aria-label', `Assembly line: ${queued} queued, ${active.length} in progress, ${shipped} shipped today`);
    pileEls.forEach((e, i) => e.classList.toggle('show', i < Math.min(queued, 5)));
    const trays = Math.min(shipped, 4); trayClip.firstChild.setAttribute('y', trays ? TRAY_TOP[trays - 1] - 4 : 400); trayClip.firstChild.setAttribute('height', trays ? 392 - (TRAY_TOP[trays - 1] - 4) : 0);
    setCount(qText, 'q', queued); setCount(sText, 's', shipped); qLabel.textContent = queued === 1 ? 'TICKET WAITING' : 'TICKETS WAITING'; pausedG.classList.toggle('svg-hide', !paused); pausedNow = paused;
    // data in: note how far each real job has got (never going backwards) and which have finished. The parcels' own journey (below) decides what is drawn.
    const seen = new Set(); const keys = stages.map(([k]) => k); const now = Date.now();
    for (const a of active) { seen.add(a.run); const target = stationOf(a.phase, keys); let p = parts.get(a.run);
      if (!p) { p = makePart(); p.target = target ?? 0; p.done = false; p.exiting = false; p.title = a.title ?? ''; p.run = a.run; p.vis = ready ? -1 : p.target; p.readyAt = now + (ready ? 800 : 0); parts.set(a.run, p);
        for (const e of [p.g, p.lab]) { e.style.transition = 'none'; e.style.opacity = '0'; place(e, ready ? HOPPER_MOUTH : stX(p.vis) + (OFF[keys[p.vis]] ?? 0), ready ? LANE : lane(keys[p.vis])); } void p.g.getBoundingClientRect(); for (const e of [p.g, p.lab]) { e.style.transition = ''; e.style.opacity = ''; } if (!ready) show(p); }
      else if (target != null) p.target = Math.max(p.target, target); p.title = a.title ?? p.title; }
    for (const [id, p] of parts) if (!seen.has(id)) { if (!p.done) { p.done = true; p.doneAt = now; } if (ends[id] != null) p.outcome = ends[id]; else if (now - p.doneAt > 6000) p.outcome = 'ok'; }   // how it ended comes from the log; if it never arrives, assume it shipped
    ensureTicker(); redraw(); ready = true;
  }
  // ---- the journey: one step at a time, each station for as long as its motion takes
  const placeAt = (p, k) => { const key = keys0[p.vis]; place(p.g, stX(p.vis) + (OFF[key] ?? 0) - k * 84, lane(key)); place(p.lab, stX(p.vis), 204); p.lab.style.display = k > 0 ? 'none' : ''; };
  function show(p) { const key = keys0[p.vis]; if (key == null) return; const cls = `bob at-${key} s${p.vis}`; if (p.inner.getAttribute('class') !== cls) p.inner.setAttribute('class', cls); const t = p.title ?? ''; const short = t.length > 19 ? `${t.slice(0, 18)}…` : t; if (p.label.textContent !== short) p.label.textContent = short; }
  function redraw() {
    const at = {}; const lit = new Set();
    for (const p of parts.values()) { if (p.exiting || p.vis < 0) continue; show(p); placeAt(p, (at[p.vis] = (at[p.vis] ?? -1) + 1)); lit.add(p.vis); }
    const moving = [...parts.values()].some((p) => !p.exiting); svg.classList.toggle('running', moving && !pausedNow);
    stationEls.forEach((g, i) => g.classList.toggle('on', lit.has(Math.floor(i / 2)))); names.forEach((n, i) => n.classList.toggle('on', lit.has(i))); glyphs.forEach((n, i) => n.classList.toggle('on', lit.has(i))); field.classList.toggle('on', lit.has(keys0.indexOf('sandbox'))); lift.classList.toggle('on', lit.has(keys0.indexOf('push')));
  }
  function exitToBin(p) {
    p.exiting = true; place(p.g, BELT1 - 24, LANE); place(p.lab, BELT1 - 24, 204); p.lab.style.opacity = '0';   // along the belt to its end, then into the bin
    setTimeout(() => { place(p.g, slotX(7) - 10, 330); p.g.style.opacity = '0'; }, 1100); setTimeout(() => { p.g.remove(); p.lab.remove(); }, 2600);
    for (const [id, q] of parts) if (q === p) parts.delete(id); redraw();
  }
  // a job that stopped without shipping (it needs an answer, or failed): the parcel is taken off the belt where it stopped
  function dropOff(p) { p.exiting = true; p.inner.setAttribute('class', `bob rejected`); const g = p.g; place(g, (Number(/translate\(([-\d.]+)px/.exec(g.style.transform)?.[1]) || stX(Math.max(0, p.vis))), LANE + 46); g.style.opacity = '0'; p.lab.style.opacity = '0'; setTimeout(() => { p.g.remove(); p.lab.remove(); }, 1800); for (const [id, q] of parts) if (q === p) parts.delete(id); redraw(); }
  function tick() {
    if (!svg.isConnected) { clearInterval(timer); timer = null; return; } const now = Date.now(); let changed = false;
    for (const p of [...parts.values()]) { if (p.exiting || now < p.readyAt) continue; const nx = nextStep({ vis: p.vis, target: p.target, done: p.done && (p.outcome != null || p.doneAt == null), last: keys0.length - 1, outcome: p.outcome });
      if (!nx) continue; if (nx.exit) { exitToBin(p); continue; } if (nx.drop) { dropOff(p); continue; } p.vis = nx.move; p.readyAt = now + dwellFor(keys0[p.vis]) + (p.vis === 0 ? 0 : 0); changed = true; }
    if (changed) redraw(); if (!parts.size && timer) { clearInterval(timer); timer = null; }
  }
  function ensureTicker() { if (!timer) timer = setInterval(tick, 200); }
  return { svg, update };
}
