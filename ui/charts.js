import { s, h, dur } from './lib.js';

// Dependency-free SVG charts. Colours come from CSS classes so light/dark themes just work.
export function ring(value, max, { size = 84, label = '', sub = '', tone = 'accent' } = {}) {
  const r = size / 2 - 7, c = 2 * Math.PI * r, f = max ? Math.min(1, value / max) : 0;
  return h('div', { class: 'ring', style: { width: `${size}px`, height: `${size}px` } },
    s('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size },
      s('circle', { cx: size / 2, cy: size / 2, r, class: 'ring-bg', fill: 'none', 'stroke-width': 7 }),
      s('circle', { cx: size / 2, cy: size / 2, r, class: `ring-fg ${tone}`, fill: 'none', 'stroke-width': 7, 'stroke-linecap': 'round', 'stroke-dasharray': `${c * f} ${c}`, transform: `rotate(-90 ${size / 2} ${size / 2})` })),
    h('div', { class: 'ring-c' }, h('b', {}, label), sub ? h('small', {}, sub) : null));
}

export function spark(values, { w = 120, h: ht = 32, tone = 'accent' } = {}) {
  const max = Math.max(1, ...values), step = w / Math.max(1, values.length - 1);
  const pts = values.map((v, i) => [i * step, ht - 3 - (v / max) * (ht - 8)]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  return s('svg', { viewBox: `0 0 ${w} ${ht}`, width: w, height: ht, class: 'spark', 'aria-hidden': 'true' },
    s('path', { d: `${line} L${w} ${ht} L0 ${ht} Z`, class: `spark-fill ${tone}` }), s('path', { d: line, class: `spark-line ${tone}`, fill: 'none', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
    s('circle', { cx: pts.at(-1)[0], cy: pts.at(-1)[1], r: 2.8, class: `spark-dot ${tone}` }));
}

// Stacked daily bars: succeeded / failed / neutral (gate bounces etc).
export function bars(days, { height = 150 } = {}) {
  const W = 640, pad = { l: 26, r: 6, t: 10, b: 22 }, iw = W - pad.l - pad.r, ih = height - pad.t - pad.b;
  const max = Math.max(3, ...days.map((d) => d.ok + d.failed + d.neutral)), bw = iw / days.length, gap = Math.min(10, bw * 0.28);
  const tip = h('div', { class: 'tip', hidden: true }); const wrap = h('div', { class: 'chart' }, tip);
  const svg = s('svg', { viewBox: `0 0 ${W} ${height}`, class: 'bars', role: 'img', 'aria-label': 'Runs per day' });
  [0, 0.5, 1].forEach((f) => { const y = pad.t + ih - f * ih; svg.append(s('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, class: 'grid' }), s('text', { x: pad.l - 6, y: y + 3, class: 'ax', 'text-anchor': 'end' }, Math.round(max * f))); });
  days.forEach((d, i) => {
    const x = pad.l + i * bw + gap / 2, w = bw - gap; let y = pad.t + ih;
    const seg = (n, cls) => { if (!n) return; const hh = (n / max) * ih; y -= hh; svg.append(s('rect', { x, y, width: w, height: hh, rx: Math.min(4, w / 3), class: `bar ${cls}` })); };
    seg(d.ok, 'ok'); seg(d.failed, 'bad'); seg(d.neutral, 'neu');
    const hit = s('rect', { x: pad.l + i * bw, y: pad.t, width: bw, height: ih, class: 'hit' });
    hit.addEventListener('mouseenter', () => { tip.hidden = false; tip.replaceChildren(h('b', {}, new Date(d.date + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })), h('div', {}, h('i', { class: 'sw ok' }), `${d.ok} PRs opened`), h('div', {}, h('i', { class: 'sw bad' }), `${d.failed} failed`), h('div', {}, h('i', { class: 'sw neu' }), `${d.neutral} needed info / skipped`)); tip.style.left = `${((pad.l + i * bw + bw / 2) / W) * 100}%`; });
    hit.addEventListener('mouseleave', () => { tip.hidden = true; });
    svg.append(hit);
    if (i % Math.ceil(days.length / 7) === 0 || i === days.length - 1) svg.append(s('text', { x: pad.l + i * bw + bw / 2, y: height - 6, class: 'ax', 'text-anchor': 'middle' }, new Date(d.date + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })));
  });
  wrap.append(svg); return wrap;
}

// Phase timeline for a finished run: proportional segments with durations.
export function timeline(phases, total) {
  const sum = Math.max(1, phases.reduce((a, p) => a + (p.ms ?? 0), 0) || total || 1);
  return h('div', { class: 'tl' }, h('div', { class: 'tl-bar' }, phases.map((p) => h('div', { class: `tl-seg ph-${p.name}`, style: { flexGrow: String(Math.max(0.04, (p.ms ?? 0) / sum)) }, title: `${p.name}${p.detail ? ` — ${p.detail}` : ''}: ${dur(p.ms)}` }))),
    h('div', { class: 'tl-legend' }, phases.map((p) => h('div', { class: 'tl-item' }, h('i', { class: `sw ph-${p.name}` }), h('b', {}, p.name), h('span', {}, dur(p.ms)), p.detail ? h('small', {}, String(p.detail).slice(0, 60)) : null))));
}
