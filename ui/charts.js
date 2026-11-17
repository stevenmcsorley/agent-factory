import { s, h, anim } from './lib.js';

// Dependency-free SVG/DOM visuals. Colours come from CSS classes so both themes work. No inline style attributes (strict CSP):
// geometry goes in SVG attributes, animation timing through the CSSOM.

// Digits that roll up from 0 to the value on mount (the DOM is rebuilt on each data change, so this plays on every new render).
export function odometer(value, pad = 2) {
  const str = String(Math.max(0, Math.round(value ?? 0))).padStart(pad, '0');
  const cols = [...str].map((d) => { const strip = h('span', { class: 'odo-strip' }, [...'0123456789'].map((x) => h('i', {}, x))); strip.dataset.d = d; return h('span', { class: 'odo-col' }, strip); });
  const el = h('span', { class: 'odo', 'aria-label': String(value) }, cols);
  const set = () => cols.forEach((c, i) => { c.firstChild.style.transitionDelay = `${i * 70}ms`; c.firstChild.style.transform = `translateY(${-Number(c.firstChild.dataset.d) * 10}%)`; });
  if (anim.on) requestAnimationFrame(() => requestAnimationFrame(set)); // roll up from 0 only when arriving on the page
  else { cols.forEach((c) => { c.firstChild.style.transition = 'none'; }); set(); } // background refresh: show the value, no replay
  return el;
}

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
  const stationEls = stages.map(([, name], i) => { const g = s('g', { class: 'l-station', transform: `translate(${X0 + i * DX} 0)` }, s('path', { d: `M-38 ${BY + 14} V74 H38 V${BY + 14}`, class: 'l-gantry' }), s('circle', { cx: 0, cy: 92, r: 8, class: 'l-lamp' }), s('text', { x: 0, y: 58, class: 'l-code', 'text-anchor': 'middle' }, `0${i + 1}`), s('text', { x: 0, y: BY + 40, class: 'l-name' }, name)); svg.append(g); return g; });
  const layer = s('g', { class: 'l-parts' }); svg.append(layer);
  const pausedG = s('g', { class: 'svg-hide' }, s('rect', { x: 150, y: BY - 12, width: 910, height: 24, class: 'l-warn' }), s('text', { x: 605, y: 48, class: 'l-paused' }, 'LINE PAUSED')); svg.append(pausedG);

  const parts = new Map(); let ready = false; const last = { q: null, s: null };
  const place = (g, x, y) => { g.style.transform = `translate(${x}px, ${y}px)`; };
  const setCount = (el, key, v) => { if (last[key] === v) return; el.textContent = String(v); if (last[key] !== null) { el.classList.remove('l-flash'); void el.getBoundingClientRect(); el.classList.add('l-flash'); } last[key] = v; };
  const makePart = (a) => { const g = s('g', { class: 'l-part-g' }, s('g', { class: 'bob' }, s('path', { d: TICKET, class: 'l-part', transform: 'translate(-23 0)' }), s('line', { x1: -14, y1: 11, x2: 14, y2: 11, class: 'l-part-line' }), s('line', { x1: -14, y1: 19, x2: 6, y2: 19, class: 'l-part-line' })), s('text', { x: 0, y: -9, class: 'l-title' })); layer.append(g); return { g, label: g.lastChild }; };

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

// A decorative-but-deterministic barcode derived from the run id, like the one on a real work-order traveler.
export function barcode(id) {
  const svg = s('svg', { viewBox: '0 0 220 38', height: 38, width: 220, class: 'barcode', role: 'img', 'aria-label': `Work order ${id}` });
  let x = 4; const seq = `A${id}A`;
  for (const c of seq) { const v = parseInt(c, 16); const bits = Number.isNaN(v) ? 9 : v; for (let b = 3; b >= 0; b--) { const w = (bits >> b) & 1 ? 3 : 1.5; svg.append(s('rect', { x, y: 0, width: w, height: 38 })); x += w + 2.2; } x += 2; }
  svg.setAttribute('viewBox', `0 0 ${Math.ceil(x + 2)} 38`); svg.setAttribute('width', String(Math.ceil(x + 2))); return svg;
}
