// Small visuals for the Agents and Usage pages: a ring gauge, a split bar, stacked daily columns, a row of health dots, a timeline of events. Plain SVG/DOM (no libraries), coloured by
// CSS classes so both themes work. Every shape carries a title, so hovering explains it and a screen reader can read it.
import { h, s } from './lib.js';

export const compact = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n ?? 0)));
export const percent = (x) => `${Math.round((x ?? 0) * 100)}%`;
export const money = (n) => `$${Number(n ?? 0).toFixed(2)}`;
export const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export const dayLabel = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric' });
export const when = (iso) => { const d = new Date(iso); const today = new Date(); const same = d.toDateString() === today.toDateString(); return same ? `today ${clock(iso)}` : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${clock(iso)}`; };
export const span = (ms) => { if (ms == null) return '–'; if (ms < 45_000) return 'under a minute'; const m = Math.max(1, Math.round(ms / 60_000)); if (m < 60) return `${m} min`; const hh = Math.floor(m / 60); const mm = m % 60; return mm ? `${hh} h ${mm} min` : `${hh} h`; };

// A status chip: tone is ok | warn | bad | off.
export const chip = (tone, text, title) => h('span', { class: `vchip ${tone}`, ...(title ? { title } : {}) }, h('i', { 'aria-hidden': 'true' }), text);

// A ring that fills to value/max. `tone` colours it; `label` is the big number, `sub` the small line under it.
export function gauge({ value, max, label, sub, tone = 'ok', size = 132, title }) {
  const r = 52, c = 2 * Math.PI * r; const frac = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const svg = s('svg', { viewBox: '0 0 120 120', width: size, height: size, role: 'img', 'aria-label': title ?? `${label} ${sub ?? ''}` }, s('title', {}, title ?? `${label} ${sub ?? ''}`),
    s('circle', { cx: 60, cy: 60, r, class: 'gauge-track', fill: 'none', 'stroke-width': 11 }), s('circle', { cx: 60, cy: 60, r, class: `gauge-fill ${tone}`, fill: 'none', 'stroke-width': 11, 'stroke-linecap': 'round', 'stroke-dasharray': `${(c * frac).toFixed(1)} ${c.toFixed(1)}`, transform: 'rotate(-90 60 60)' }));
  return h('div', { class: 'gauge', style: { width: `${size}px`, height: `${size}px` } }, svg, h('div', { class: 'gauge-text' }, h('b', {}, label), sub ? h('span', {}, sub) : null));
}

// One horizontal bar split into parts: [{ label, value, cls }]. A legend sits under it.
export function splitBar(parts, { empty = 'Nothing yet' } = {}) {
  const total = parts.reduce((n, p) => n + p.value, 0); if (!total) return h('div', { class: 'splitbar-empty' }, empty);
  return h('div', { class: 'splitbar-wrap' }, h('div', { class: 'splitbar', role: 'img', 'aria-label': parts.map((p) => `${p.label} ${percent(p.value / total)}`).join(', ') }, ...parts.filter((p) => p.value > 0).map((p) => h('i', { class: p.cls, style: { width: `${(100 * p.value) / total}%` }, title: `${p.label}: ${percent(p.value / total)}` }))),
    h('div', { class: 'splitlegend' }, ...parts.map((p) => h('span', {}, h('i', { class: p.cls }), `${p.label} `, h('b', {}, percent(total ? p.value / total : 0))))));
}

// Stacked columns, one per day. days: [{ day, a, b }] where a and b are numbers; classes name the two series.
export function dayBars(days, { height = 150, aClass = 'a', bClass = 'b', aLabel = 'A', bLabel = 'B', format = compact } = {}) {
  const w = 640, pad = { l: 40, r: 8, t: 10, b: 24 }; const max = Math.max(1, ...days.map((d) => d.a + d.b)); const bw = (w - pad.l - pad.r) / Math.max(1, days.length); const ih = height - pad.t - pad.b;
  const ticks = [0, 0.5, 1].map((f) => ({ y: pad.t + ih * (1 - f), v: max * f }));
  return s('svg', { viewBox: `0 0 ${w} ${height}`, class: 'daybars', role: 'img', 'aria-label': `${aLabel} and ${bLabel} per day` }, s('title', {}, `${aLabel} and ${bLabel} per day`),
    ...ticks.map((t) => s('g', {}, s('line', { x1: pad.l, x2: w - pad.r, y1: t.y, y2: t.y, class: 'grid' }), s('text', { x: pad.l - 6, y: t.y + 3, class: 'axis', 'text-anchor': 'end' }, format(t.v)))),
    ...days.map((d, i) => { const x = pad.l + i * bw + bw * 0.18, ww = bw * 0.64; const hb = (d.b / max) * ih, ha = (d.a / max) * ih; const yb = pad.t + ih - hb, ya = yb - ha; const label = dayLabel(d.day);
      return s('g', { class: 'daycol' }, s('title', {}, `${label}: ${aLabel} ${format(d.a)}, ${bLabel} ${format(d.b)}`), s('rect', { x, y: pad.t, width: ww, height: ih, class: 'hit', fill: 'transparent' }), hb > 0 ? s('rect', { x, y: yb, width: ww, height: hb, class: bClass, rx: 2 }) : null, ha > 0 ? s('rect', { x, y: ya, width: ww, height: ha, class: aClass, rx: 2 }) : null,
        s('text', { x: x + ww / 2, y: height - 8, class: 'axis', 'text-anchor': 'middle' }, days.length > 14 ? (i % 3 === 0 ? label.split(' ')[1] : '') : label)); }).filter(Boolean));
}

// A row of dots, one per item: [{ tone, title }].
export const dots = (items) => h('div', { class: 'vdots', role: 'img', 'aria-label': `${items.filter((i) => i.tone === 'ok').length} of ${items.length} ready` }, ...items.map((i) => h('i', { class: i.tone, title: i.title })));

// A single progress bar.
export const meter = (value, max, tone = 'ok', title) => h('div', { class: 'vmeter', role: 'img', 'aria-label': title ?? `${value} of ${max}`, ...(title ? { title } : {}) }, h('i', { class: tone, style: { width: `${max > 0 ? Math.min(100, (100 * value) / max) : 0}%` } }));

// Events on a time axis. events: [{ at, kind, title }], kinds map to colours in CSS (.ev-codex-limit ...).
export function timeline(events, from, to, { height = 56 } = {}) {
  const w = 640, pad = 10; const a = Date.parse(from), b = Date.parse(to); const x = (t) => pad + ((t - a) / Math.max(1, b - a)) * (w - 2 * pad);
  const day = 86_400_000; const ticks = []; for (let t = Date.parse(`${new Date(a).toISOString().slice(0, 10)}T00:00:00Z`) + day; t < b; t += day) ticks.push(t);
  return s('svg', { viewBox: `0 0 ${w} ${height}`, class: 'timeline', role: 'img', 'aria-label': `${events.length} events` }, s('title', {}, `${events.length} events in this period`), s('line', { x1: pad, x2: w - pad, y1: height / 2, y2: height / 2, class: 'axisline' }),
    ...ticks.map((t) => s('line', { x1: x(t), x2: x(t), y1: height / 2 - 6, y2: height / 2 + 6, class: 'tick' })),
    ...events.map((e, i) => s('circle', { cx: x(Date.parse(e.at)), cy: height / 2 + ((i % 3) - 1) * 9, r: 5, class: `ev ev-${e.kind}` }, s('title', {}, `${when(e.at)} · ${e.title}`))));
}
