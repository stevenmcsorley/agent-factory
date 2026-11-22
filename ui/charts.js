import { qrPath } from './qr.js';
import { s, h, anim } from './lib.js';

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

// ---- The Line, in pseudo-3D. Same contract as createLine (an svg and update({ queued, shipped, active, paused })), so the Control room swaps one call. Every machine is drawn from lit
// faces (front, top, side) with gradients and soft shadows; the belt, robot arm, scanner, rollers and press animate (CSS, see "THE LINE 3D" in style.css) only while a run is at that station.
// Built once and updated in place: a job is a small cardboard box that glides from the hopper along the belt to the shipped bin; nothing is torn down between refreshes.
export function createLine3D(stages) {
  const W = 1200, H = 332, BY = 226, X0 = 292, DX = 128, HOP = 92, BIN = 1100, CHUTE = 1100;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'line-svg line3d', role: 'img' });
  const lin = (id, stops, vertical = true) => s('linearGradient', { id, x1: 0, y1: 0, x2: vertical ? 0 : 1, y2: vertical ? 1 : 0 }, ...stops.map(([o, c, a]) => s('stop', { offset: o, 'stop-color': c, ...(a != null ? { 'stop-opacity': a } : {}) })));
  svg.append(s('defs', {},
    lin('l3-steel', [[0, '#8d9299'], [0.45, '#4b4f56'], [1, '#2c2e33']]), lin('l3-side', [[0, '#5b5f66'], [1, '#26282c']]), lin('l3-top', [[0, '#b4b9c0'], [1, '#757a82']]), lin('l3-dark', [[0, '#2a2c31'], [1, '#141517']]),
    lin('l3-belt', [[0, '#4b4d52'], [1, '#202125']]), lin('l3-orange', [[0, '#ff8a4c'], [1, '#e8480c']]), lin('l3-glass', [[0, '#9fd2f0', 0.28], [0.5, '#9fd2f0', 0.06], [1, '#9fd2f0', 0.16]]),
    lin('l3-green', [[0, '#46e6a8'], [1, '#14a068']]), lin('l3-card-f', [[0, '#d2a263'], [1, '#a97d47']]), lin('l3-card-t', [[0, '#e6bd82'], [1, '#c79a5c']]), lin('l3-card-s', [[0, '#a9793f'], [1, '#8a6232']]),
    lin('l3-beam', [[0, '#5cc8ff', 0], [0.5, '#7fdcff', 0.85], [1, '#5cc8ff', 0]]),
    s('radialGradient', { id: 'l3-floor', cx: 0.5, cy: 0.5, r: 0.5 }, s('stop', { offset: 0, 'stop-color': '#000', 'stop-opacity': 0.55 }), s('stop', { offset: 1, 'stop-color': '#000', 'stop-opacity': 0 })),
    s('pattern', { id: 'l3-haz', width: 14, height: 14, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(-45)' }, s('rect', { width: 14, height: 14, fill: '#1a1b1e' }), s('rect', { width: 7, height: 14, fill: '#f0b429' })),
    s('clipPath', { id: 'l3-beltclip' }, s('rect', { x: 150, y: BY - 12, width: 900, height: 16 }))));
  // a lit box: front, top and side faces. (x, y) is the front-top-left corner; d is the depth drawn up and to the right.
  const box = (x, y, w, h, d, o = {}) => s('g', { class: `l3-box ${o.cls ?? ''}` }, s('polygon', { points: `${x + w},${y} ${x + w + d},${y - d * 0.55} ${x + w + d},${y + h - d * 0.55} ${x + w},${y + h}`, fill: `url(#${o.side ?? 'l3-side'})` }),
    s('polygon', { points: `${x},${y} ${x + d},${y - d * 0.55} ${x + w + d},${y - d * 0.55} ${x + w},${y}`, fill: `url(#${o.top ?? 'l3-top'})` }), s('rect', { x, y, width: w, height: h, fill: `url(#${o.front ?? 'l3-steel'})` }),
    s('path', { d: `M${x} ${y}H${x + w}V${y + h}`, class: 'l3-edge' }));
  const shadow = (cx, w) => s('ellipse', { cx, cy: BY + 10, rx: w, ry: 8, fill: 'url(#l3-floor)' });
  const glyph = (key, x, y, sc = 1.45) => s('g', { transform: `translate(${x - 12 * sc} ${y}) scale(${sc})`, class: `l3-glyph ic ic-${glyphKey(key)}` }, ...GLYPHS[glyphKey(key)]());

  // ---- floor and belt
  svg.append(s('rect', { x: 0, y: 0, width: W, height: H, class: 'l3-bg' }));
  svg.append(shadow(600, 560));
  for (const lx of [200, 380, 560, 740, 920, 1030]) svg.append(s('rect', { x: lx - 7, y: BY + 14, width: 14, height: 44, fill: 'url(#l3-dark)', class: 'l3-leg' }), s('rect', { x: lx - 14, y: BY + 54, width: 28, height: 7, fill: 'url(#l3-steel)' }));
  const slats = s('g', { class: 'l3-slats', 'clip-path': 'url(#l3-beltclip)' }); for (let x = 130; x < 1090; x += 24) slats.append(s('line', { x1: x, y1: BY - 12, x2: x - 6, y2: BY + 4, class: 'l3-slat' }));
  svg.append(s('polygon', { points: `150,${BY - 12} 1050,${BY - 12} 1062,${BY + 4} 138,${BY + 4}`, fill: 'url(#l3-top)', opacity: 0.55 }), s('rect', { x: 138, y: BY + 4, width: 924, height: 16, fill: 'url(#l3-belt)' }), s('polygon', { points: `150,${BY - 12} 1050,${BY - 12} 1050,${BY + 4} 150,${BY + 4}`, fill: 'url(#l3-belt)' }), slats,
    s('rect', { x: 138, y: BY + 18, width: 924, height: 3, fill: '#0c0c0e' }), s('path', { d: `M138 ${BY + 4}H1062`, class: 'l3-edge hi' }));

  // ---- hopper (waiting) and the shipped bin
  const hopTickets = Array.from({ length: 5 }, (_, i) => s('g', { class: 'l3-hop-t l-slot', transform: `translate(${58 + (i % 2) * 14 + i * 5} ${96 + i * 9})` }, s('polygon', { points: '0,0 34,0 40,-8 6,-8', fill: 'url(#l3-orange)', opacity: 0.8 }), s('rect', { width: 34, height: 12, fill: 'url(#l3-orange)' }), s('rect', { x: 5, y: 4, width: 16, height: 3, fill: '#fff', opacity: 0.7 })));
  svg.append(shadow(HOP, 76), s('polygon', { points: '22,84 168,84 138,200 52,200', fill: 'url(#l3-steel)' }), s('polygon', { points: '168,84 184,76 154,196 138,200', fill: 'url(#l3-side)' }), s('polygon', { points: '22,84 38,76 184,76 168,84', fill: 'url(#l3-top)' }), s('polygon', { points: '40,88 164,88 140,194 56,194', fill: '#0e0f11', opacity: 0.85 }),
    ...hopTickets, s('polygon', { points: '52,200 138,200 126,214 64,214', fill: 'url(#l3-dark)' }), s('rect', { x: 62, y: 212, width: 10, height: 20, fill: 'url(#l3-dark)' }), s('rect', { x: 118, y: 212, width: 10, height: 20, fill: 'url(#l3-dark)' }));
  const trays = Array.from({ length: 4 }, (_, i) => s('g', { class: 'l3-tray l-slot', transform: `translate(${1062 + i * 3} ${150 - i * 17})` }, s('polygon', { points: '0,0 94,0 104,-10 10,-10', fill: '#5ff0b6' }), s('rect', { width: 94, height: 13, rx: 3, fill: 'url(#l3-green)' }), s('rect', { x: 6, y: 4, width: 46, height: 3, fill: '#fff', opacity: 0.45 })));
  svg.append(shadow(BIN, 70), box(1040, 76, 126, 124, 14, { front: 'l3-dark', cls: 'l3-bin' }), s('rect', { x: 1050, y: 86, width: 106, height: 104, fill: '#07130e', class: 'l3-bin-in' }), s('rect', { x: 1050, y: 86, width: 106, height: 104, class: 'l3-bin-glow' }), ...trays);

  // ---- the six machines
  const stationEls = []; const machines = {
    claim: () => [box(-34, -64, 68, 64, 14), s('rect', { x: -22, y: -50, width: 44, height: 8, fill: '#0b0c0e' }), s('g', { class: 'l3-feed' }, ...[0, 1, 2].map((i) => s('rect', { x: -16 + i * 12, y: -49, width: 8, height: 6, fill: '#f1ece0' }))), s('rect', { x: -26, y: -30, width: 52, height: 4, fill: 'url(#l3-orange)', class: 'l3-accent' }), s('ellipse', { cx: 0, cy: -66, rx: 20, ry: 5, fill: '#1d1e21' })],
    sandbox: () => [box(-38, -76, 76, 76, 16), s('rect', { x: -28, y: -66, width: 56, height: 52, fill: '#0a0b0d' }), s('rect', { x: -22, y: -26, width: 44, height: 6, fill: 'url(#l3-steel)' }), s('rect', { x: -6, y: -58, width: 12, height: 30, fill: 'url(#l3-steel)', class: 'l3-piston' }), s('rect', { x: -28, y: -66, width: 56, height: 52, fill: 'url(#l3-glass)', class: 'l3-glass' }), s('line', { x1: -24, y1: -62, x2: -8, y2: -22, class: 'l3-shine' }), s('rect', { x: -38, y: -30, width: 5, height: 5, fill: 'url(#l3-orange)', class: 'l3-accent' })],
    agent: () => [s('ellipse', { cx: 0, cy: -2, rx: 34, ry: 9, fill: 'url(#l3-dark)' }), s('rect', { x: -22, y: -20, width: 44, height: 18, fill: 'url(#l3-steel)' }), s('ellipse', { cx: 0, cy: -20, rx: 22, ry: 6, fill: 'url(#l3-top)' }), s('circle', { cx: 0, cy: -36, r: 10, fill: 'url(#l3-steel)', class: 'l3-joint' }),
      s('g', { class: 'l3-arm1' }, s('rect', { x: -6, y: -84, width: 12, height: 52, rx: 4, fill: 'url(#l3-steel)' }), s('rect', { x: -6, y: -62, width: 5, height: 26, fill: 'url(#l3-orange)', class: 'l3-accent' }), s('circle', { cx: 0, cy: -84, r: 8, fill: 'url(#l3-steel)', class: 'l3-joint' }),
        s('g', { class: 'l3-arm2' }, s('rect', { x: -5, y: -126, width: 10, height: 46, rx: 4, fill: 'url(#l3-steel)', transform: 'rotate(58 0 -84)' }), s('g', { class: 'l3-claw', transform: 'translate(40 -118)' }, s('circle', { r: 6, fill: 'url(#l3-steel)' }), s('path', { d: 'M2 4 L14 10 L10 14 Z', fill: '#cfd3d9' }), s('path', { d: 'M-2 4 L-2 16 L4 14 Z', fill: '#cfd3d9' }))))],
    verify: () => [box(-46, -82, 14, 82, 8), box(32, -82, 14, 82, 8), box(-46, -96, 92, 16, 12, { cls: 'l3-beam-top' }), s('circle', { cx: 0, cy: -88, r: 6, fill: '#0b0c0e' }), s('circle', { cx: 0, cy: -88, r: 3, class: 'l3-lens' }), s('rect', { x: -30, y: -78, width: 60, height: 3, fill: 'url(#l3-beam)', class: 'l3-scan' })],
    push: () => [box(-38, -26, 76, 26, 14), s('polygon', { points: '-38,-26 40,-62 54,-67 -24,-31', fill: 'url(#l3-top)' }), ...[0, 1, 2, 3, 4].map((i) => s('g', { transform: `translate(${-26 + i * 16} ${-32 - i * 7})` }, s('circle', { r: 6, fill: 'url(#l3-dark)', class: 'l3-roller' }), s('line', { x1: -4, y1: 0, x2: 4, y2: 0, class: 'l3-roller-t' }))), s('rect', { x: -38, y: -14, width: 6, height: 5, fill: 'url(#l3-orange)', class: 'l3-accent' })],
    pr: () => [box(-42, -88, 10, 88, 8), box(32, -88, 10, 88, 8), box(-42, -100, 84, 14, 10, { front: 'l3-dark' }), s('rect', { x: -42, y: -100, width: 84, height: 14, fill: 'url(#l3-haz)', opacity: 0.9 }), s('g', { class: 'l3-press' }, s('rect', { x: -22, y: -86, width: 44, height: 22, fill: 'url(#l3-steel)' }), s('rect', { x: -22, y: -68, width: 44, height: 4, fill: 'url(#l3-orange)', class: 'l3-accent' })),
      s('polygon', { points: '-14,-26 14,-26 20,-31 -8,-31', fill: 'url(#l3-card-t)' }), s('rect', { x: -14, y: -26, width: 28, height: 26, fill: 'url(#l3-card-f)' }), s('rect', { x: -14, y: -16, width: 28, height: 4, fill: '#e9d3a6', opacity: 0.7 })],
  };
  stages.forEach(([key, name], i) => { const cx = X0 + i * DX; const g = s('g', { class: 'l3-station', transform: `translate(${cx} ${BY})` }, shadow0(), ...(machines[key] ?? machines.claim)(), s('circle', { cx: 0, cy: 16, r: 4.5, class: 'l3-lamp' }), glyph(key, 0, 40 - BY));
    svg.append(g, s('text', { x: cx, y: BY + 82, class: 'l3-name', 'text-anchor': 'middle' }, name.toUpperCase())); stationEls.push(g); });
  function shadow0() { return s('ellipse', { cx: 8, cy: 14, rx: 50, ry: 7, fill: 'url(#l3-floor)' }); }
  for (let i = 1; i < stages.length; i++) svg.append(s('line', { x1: X0 + i * DX - DX / 2, y1: BY + 66, x2: X0 + i * DX - DX / 2, y2: BY + 92, class: 'l3-sep' }));
  // numbers and labels
  const qText = s('text', { x: HOP, y: BY + 78, class: 'l3-big', 'text-anchor': 'middle' }, '0'), qLabel = s('text', { x: HOP, y: BY + 98, class: 'l3-label', 'text-anchor': 'middle' }, 'TICKETS WAITING');
  const sText = s('text', { x: BIN + 14, y: BY + 78, class: 'l3-big ship', 'text-anchor': 'middle' }, '0');
  svg.append(s('text', { x: HOP, y: 40, class: 'l3-title', 'text-anchor': 'middle' }, 'HOPPER'), qText, qLabel, s('text', { x: BIN + 14, y: 40, class: 'l3-title', 'text-anchor': 'middle' }, 'SHIPPED'), sText, s('text', { x: BIN + 14, y: BY + 98, class: 'l3-label', 'text-anchor': 'middle' }, 'PRS TODAY'));
  const layer = s('g', { class: 'l-parts' }); svg.append(layer);
  const pausedG = s('g', { class: 'svg-hide' }, s('rect', { x: 150, y: BY - 12, width: 900, height: 32, class: 'l3-pausewash' }), s('text', { x: 600, y: 120, class: 'l3-paused', 'text-anchor': 'middle' }, 'LINE PAUSED')); svg.append(pausedG);

  const parts = new Map(); let ready = false; const last = { q: null, s: null }; const place = (g, x, y) => { g.style.transform = `translate(${x}px, ${y}px)`; };
  const setCount = (el, key, v) => { if (last[key] === v) return; el.textContent = String(v); if (last[key] !== null) { el.classList.remove('l-flash'); void el.getBoundingClientRect(); el.classList.add('l-flash'); } last[key] = v; };
  const makePart = (a) => { const g = s('g', { class: 'l-part-g' }, s('g', { class: 'bob' }, s('polygon', { points: '-15,-22 15,-22 21,-27 -9,-27', fill: 'url(#l3-card-t)' }), s('polygon', { points: '15,-22 21,-27 21,-5 15,0', fill: 'url(#l3-card-s)' }), s('rect', { x: -15, y: -22, width: 30, height: 22, fill: 'url(#l3-card-f)' }), s('rect', { x: -9, y: -13, width: 18, height: 3, fill: '#fff', opacity: 0.6 })));
    const label = s('text', { x: 0, y: -34, class: 'l3-part-label', 'text-anchor': 'middle' }, ''); g.append(label); layer.append(g); return { g, label }; };
  function update({ queued = 0, shipped = 0, active = [], paused = false }) {
    svg.classList.toggle('running', active.length > 0 && !paused); svg.classList.toggle('shipping', shipped > 0);
    svg.setAttribute('aria-label', `Assembly line: ${queued} queued, ${active.length} in progress, ${shipped} shipped today`);
    hopTickets.forEach((e, i) => e.classList.toggle('show', i < Math.min(queued, 5))); trays.forEach((e, i) => e.classList.toggle('show', i < Math.min(shipped, 4)));
    setCount(qText, 'q', queued); setCount(sText, 's', shipped); qLabel.textContent = queued === 1 ? 'TICKET WAITING' : 'TICKETS WAITING'; pausedG.classList.toggle('svg-hide', !paused);
    const per = {}; const seen = new Set(); const lit = new Set();
    for (const a of active) { seen.add(a.run); const si = Math.max(0, stages.findIndex(([k]) => k === a.phase)); lit.add(si); const k = (per[si] = (per[si] ?? -1) + 1); const x = X0 + si * DX + 4, y = BY + 8 - k * 30; let p = parts.get(a.run);
      if (!p) { p = makePart(a); parts.set(a.run, p); p.g.style.transition = 'none'; place(p.g, ready ? HOP : x, ready ? BY - 40 : y); void p.g.getBoundingClientRect(); p.g.style.transition = ''; }
      const t = a.title ?? ''; const short = t.length > 22 ? `${t.slice(0, 21)}…` : t; if (p.label.textContent !== short) p.label.textContent = short; place(p.g, x, y); }
    for (const [id, p] of parts) if (!seen.has(id)) { parts.delete(id); place(p.g, CHUTE, BY - 30); p.g.style.opacity = '0'; setTimeout(() => p.g.remove(), 1400); }
    stationEls.forEach((g, i) => g.classList.toggle('on', lit.has(i))); ready = true;
  }
  return { svg, update };
}
