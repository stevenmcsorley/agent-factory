import { s, h } from './lib.js';

// Dependency-free SVG/DOM visuals. Colours come from CSS classes so both themes work. No inline style attributes (strict CSP):
// geometry goes in SVG attributes, animation timing through the CSSOM.

// Digits that roll up from 0 to the value on mount (the DOM is rebuilt on each data change, so this plays on every new render).
export function odometer(value, pad = 2) {
  const str = String(Math.max(0, Math.round(value ?? 0))).padStart(pad, '0');
  const cols = [...str].map((d) => { const strip = h('span', { class: 'odo-strip' }, [...'0123456789'].map((x) => h('i', {}, x))); strip.dataset.d = d; return h('span', { class: 'odo-col' }, strip); });
  const el = h('span', { class: 'odo', 'aria-label': String(value) }, cols);
  requestAnimationFrame(() => requestAnimationFrame(() => cols.forEach((c, i) => { c.firstChild.style.transitionDelay = `${i * 70}ms`; c.firstChild.style.transform = `translateY(${-Number(c.firstChild.dataset.d) * 10}%)`; })));
  return el;
}

// The assembly line: HOPPER (queued tickets) → six stations on a belt → SHIPPED chute. Active runs sit at their current station.
const TICKET = 'M0 0H46V9a4.5 4.5 0 000 9V30H0V18a4.5 4.5 0 000-9Z';
export function line({ queued = 0, shipped = 0, active = [], paused = false, stages }) {
  const W = 1200, H = 262, BY = 168, X0 = 250, DX = 138;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: `line-svg ${active.length && !paused ? 'running' : ''}`, role: 'img', 'aria-label': `Assembly line: ${queued} queued, ${active.length} in progress, ${shipped} shipped today` });
  svg.append(s('defs', {}, s('pattern', { id: 'haz', width: 18, height: 18, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(-45)' }, s('rect', { width: 9, height: 18, fill: 'currentColor', class: 'haz-a' }))));
  for (let x = 0; x <= W; x += 60) svg.append(s('line', { x1: x, y1: 0, x2: x, y2: H, class: 'l-grid' }));
  // belt
  svg.append(s('rect', { x: 150, y: BY - 12, width: 910, height: 24, class: 'l-belt-bed' }), s('line', { x1: 150, y1: BY, x2: 1060, y2: BY, class: 'l-belt' }));
  // hopper
  const bin = s('g', {}, s('path', { d: 'M24 56H146L120 148H50Z', class: 'l-bin' }));
  for (let i = 0; i < Math.min(queued, 5); i++) bin.append(s('path', { d: TICKET, transform: `translate(${50 + i * 6} ${64 + i * 13}) scale(.9)`, class: `l-ticket ${i === 0 ? 'on' : ''}` }));
  svg.append(bin, s('text', { x: 85, y: 36, class: 'l-label' }, 'Hopper'), s('text', { x: 85, y: 200, class: 'l-big' }, String(queued)), s('text', { x: 85, y: 222, class: 'l-label' }, queued === 1 ? 'ticket waiting' : 'tickets waiting'));
  // stations
  stages.forEach(([key, name], i) => {
    const x = X0 + i * DX; const here = active.filter((a) => a.phase === key);
    const g = s('g', { class: `l-station ${here.length ? 'on' : ''}`, transform: `translate(${x} 0)` },
      s('path', { d: `M-38 ${BY + 14} V74 H38 V${BY + 14}`, class: 'l-gantry' }), s('circle', { cx: 0, cy: 92, r: 8, class: 'l-lamp' }), s('text', { x: 0, y: 58, class: 'l-code', 'text-anchor': 'middle' }, `0${i + 1}`), s('text', { x: 0, y: BY + 40, class: 'l-name' }, name));
    here.forEach((a, k) => {
      const part = s('g', { class: 'l-part-wrap', transform: `translate(${-23 + (k % 2) * 8} ${BY - 40 - k * 34})` }, s('path', { d: TICKET, class: 'l-part' }), s('line', { x1: 9, y1: 11, x2: 37, y2: 11, class: 'l-part-line' }), s('line', { x1: 9, y1: 19, x2: 29, y2: 19, class: 'l-part-line' }), s('title', {}, a.title ?? ''));
      part.style.animationDelay = `${k * 0.3}s`; g.append(part);
    });
    if (here[0]) g.append(s('text', { x: 0, y: 28, class: 'l-title' }, (here[0].title ?? '').length > 24 ? `${(here[0].title ?? '').slice(0, 23)}…` : (here[0].title ?? '')));
    svg.append(g);
  });
  // shipped chute
  const out = s('g', {}, s('rect', { x: 1066, y: 56, width: 110, height: 92, class: 'l-bin' }));
  for (let i = 0; i < Math.min(shipped, 4); i++) out.append(s('path', { d: TICKET, transform: `translate(${1086 + i * 5} ${64 + i * 17}) scale(.82)`, class: 'l-ticket l-ship' }));
  svg.append(out, s('text', { x: 1121, y: 36, class: 'l-label' }, 'Shipped'), s('text', { x: 1121, y: 200, class: 'l-big l-ship-big' }, String(shipped)), s('text', { x: 1121, y: 222, class: 'l-label' }, 'PRs today'));
  if (paused) svg.append(s('rect', { x: 150, y: BY - 12, width: 910, height: 24, class: 'l-warn' }), s('text', { x: 605, y: 48, class: 'l-paused' }, 'LINE PAUSED'));
  return svg;
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
