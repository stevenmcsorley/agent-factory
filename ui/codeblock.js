// One look for every piece of code in the UI (same as the diff viewer): a header with the file name and a Copy button, a line-number gutter,
// light syntax colour, horizontal scroll for long lines. Pure DOM, so the text can never run as HTML.
//   codeBlock(text, { path, lang, start = 1, copyText, label, maxHeight, numbers = true, wrap = false, title })
// `copyText` is what Copy puts on the clipboard when it must differ from what is shown (a secret shown as a placeholder).
// The returned element has setText(t) so output boxes can be updated in place.
import { h, icon, toast } from './lib.js';
import { tokens, LANG, EXT } from './diff.js';

const NAMES = { js: 'JavaScript', json: 'JSON', css: 'CSS', html: 'HTML', py: 'Python', sh: 'Shell', md: 'Markdown', yml: 'YAML' };
const MAX = 3000;

export function codeBlock(text, opts = {}) {
  const o = { start: 1, numbers: true, ...opts }; const root = h('div', { class: `cb${o.wrap ? ' wrap' : ''}` }); let current = String(text ?? '');
  const lang = o.lang ?? LANG[EXT(o.path ?? '')] ?? ''; const lab = o.title ?? o.path ?? (lang ? NAMES[lang] ?? lang : 'Text');
  const copy = h('button', { type: 'button', class: 'cb-copy', title: 'Copy to the clipboard', onclick: async () => { try { await navigator.clipboard.writeText(o.copyText ?? current); toast(`${o.label ?? 'Code'} copied`, 'ok'); } catch { toast('Copy failed: select and copy manually', 'bad'); } } }, icon('copy', 12), 'Copy');
  const head = h('div', { class: 'cb-head' }, h('span', { class: 'cb-name' }, lab), h('span', { class: 'cb-meta' }), copy);
  const scroll = h('div', { class: 'cb-scroll', ...(o.maxHeight ? { style: `max-height:${o.maxHeight}px` } : {}), tabindex: '0', role: 'region', 'aria-label': `${lab} code` });
  const draw = () => {
    const lines = current.replace(/\n$/, '').split('\n'); const shown = lines.slice(0, MAX); const tb = h('tbody', {});
    shown.forEach((l, i) => tb.append(h('tr', { class: 'dr' }, o.numbers ? h('td', { class: 'dn', 'data-n': o.start + i }) : null, h('td', { class: 'dc' }, ...tokens(l, lang), l ? null : '\u200b'))));
    if (lines.length > MAX) tb.append(h('tr', { class: 'dr' }, o.numbers ? h('td', { class: 'dn' }) : null, h('td', { class: 'dc cb-more' }, `… ${(lines.length - MAX).toLocaleString()} more lines not shown`)));
    scroll.replaceChildren(h('table', { class: 'dtab cb-tab' }, tb)); head.querySelector('.cb-meta').textContent = `${lines.length} line${lines.length === 1 ? '' : 's'}`;
  };
  draw(); root.append(head, scroll); root.setText = (t) => { current = String(t ?? ''); draw(); }; return root;
}
