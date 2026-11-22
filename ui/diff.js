// A GitHub-style diff viewer: one collapsible section per file, old/new line-number gutters, hunk headers, unified or split layout,
// the changed part of a line highlighted inside it, and light syntax colouring. Pure DOM (no innerHTML), so file content can never run.
import { h, icon } from './lib.js';

const MAX_LINES = 6000, AUTO_COLLAPSE = 600;
const EXT = (p) => (/\.([a-z0-9]+)$/i.exec(p)?.[1] ?? '').toLowerCase();
const LANG = { js: 'js', mjs: 'js', cjs: 'js', ts: 'js', jsx: 'js', tsx: 'js', json: 'json', css: 'css', scss: 'css', html: 'html', htm: 'html', svg: 'html', xml: 'html', py: 'py', sh: 'sh', md: 'md', yml: 'yml', yaml: 'yml' };
const KW = { js: 'const let var function return if else for while of in new class extends import export from default async await try catch throw switch case break continue typeof instanceof null undefined true false this static get set', py: 'def class return if elif else for while in import from as with try except raise lambda None True False pass yield not and or is async await', sh: 'if then else fi for do done while case esac function in export echo cd exit', css: '' };

// ---- parse a unified diff into files > hunks > rows
export function parseDiff(text) {
  const files = []; let f = null, hunk = null, o = 0, n = 0;
  for (const l of text.split('\n')) {
    if (l.startsWith('diff --git ')) { const m = / b\/(.+)$/.exec(l); f = { path: m ? m[1] : l.slice(11), old: null, status: 'modified', hunks: [], add: 0, del: 0, binary: false }; files.push(f); hunk = null; continue; }
    if (!f) continue;
    if (!hunk) {
      if (l.startsWith('new file')) f.status = 'added'; else if (l.startsWith('deleted file')) f.status = 'deleted'; else if (l.startsWith('rename from ')) { f.old = l.slice(12); f.status = 'renamed'; } else if (l.startsWith('Binary files') || l.startsWith('GIT binary')) f.binary = true;
      else if (l.startsWith('--- ') || l.startsWith('+++ ') || l.startsWith('index ') || l.startsWith('similarity') || l.startsWith('rename to') || l.startsWith('old mode') || l.startsWith('new mode')) continue;
    }
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(l);
    if (m) { hunk = { head: `${l.slice(0, l.indexOf(' @@', 3) + 3)}${m[3] ? ` ${m[3]}` : ''}`, rows: [] }; f.hunks.push(hunk); o = +m[1]; n = +m[2]; continue; }
    if (!hunk) continue; const c = l[0], t = l.slice(1);
    if (c === '+') { hunk.rows.push({ k: 'add', n, t }); n++; f.add++; } else if (c === '-') { hunk.rows.push({ k: 'del', o, t }); o++; f.del++; } else if (c === ' ') { hunk.rows.push({ k: 'ctx', o, n, t }); o++; n++; } else if (c === '\\') hunk.rows.push({ k: 'note', t: l });
  }
  return files;
}

// ---- the part of a line that really changed: strip the common start and end of a removed/added pair
function inner(a, b) { let s = 0; const m = Math.min(a.length, b.length); while (s < m && a[s] === b[s]) s++; let e = 0; while (e < m - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++; return [[s, a.length - e], [s, b.length - e]]; }
function pairUp(rows) {   // mark ranges on consecutive removed/added blocks of the same length
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].k !== 'del') continue; let j = i; while (rows[j]?.k === 'del') j++; let k = j; while (rows[k]?.k === 'add') k++;
    const nd = j - i, na = k - j; if (nd === na) for (let x = 0; x < nd; x++) { const d = rows[i + x], a = rows[j + x]; if (d.t.length < 400 && a.t.length < 400 && d.t !== a.t) { const [rd, ra] = inner(d.t, a.t); if (rd[1] - rd[0] < d.t.length || ra[1] - ra[0] < a.t.length) { d.mark = rd; a.mark = ra; } } }
    i = k - 1;
  }
}

// ---- light syntax colouring: strings, comments, numbers, keywords (tag/attr for markup). Returns spans.
function tokens(line, lang) {
  if (!line) return [''];
  if (!lang || lang === 'md' || line.length > 600) return [line];
  const kw = new Set((KW[lang] ?? '').split(' ').filter(Boolean)); const out = []; let i = 0;
  const push = (t, c) => { if (t) out.push(c ? h('span', { class: c }, t) : t); };
  const re = lang === 'html' ? /(<!--.*?-->|<\/?[a-zA-Z][\w:-]*|\/?>|"[^"]*"|'[^']*'|\s[\w:-]+(?==))/y : lang === 'json' ? /("(?:[^"\\]|\\.)*"(?=\s*:)|"(?:[^"\\]|\\.)*"|-?\b\d[\d.eE+-]*\b|\b(?:true|false|null)\b)/y
    : lang === 'css' ? /(\/\*.*?\*\/|"[^"]*"|'[^']*'|#[0-9a-fA-F]{3,8}\b|-?\d[\d.]*(?:px|rem|em|%|vh|vw|s|ms)?|--[\w-]+|@[\w-]+|[.#][\w-]+|[\w-]+(?=\s*:))/y
    : /(\/\/.*|#.*|\/\*.*?\*\/|`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b\d[\d._]*\b|[A-Za-z_$][\w$]*)/y;
  while (i < line.length) {
    re.lastIndex = i; let m = re.exec(line); if (!m) { const nx = line.slice(i).search(re.source.includes('\\s[') ? /\S/ : /[\w"'`#/@.<-]/); const cut = nx > 0 ? i + nx : line.length; push(line.slice(i, cut)); i = cut; continue; }
    // sticky regex matched at i exactly
    const t = m[0]; let c = '';
    if (lang === 'html') c = t.startsWith('<!--') ? 'sx-c' : t[0] === '<' ? 'sx-t' : t[0] === '"' || t[0] === "'" ? 'sx-s' : /^[>/]/.test(t) ? 'sx-t' : 'sx-a';
    else if (lang === 'json') c = t[0] === '"' ? (/"\s*:/.test(line.slice(i + t.length - 1, i + t.length + 3)) || line[i + t.length] === ':' ? 'sx-a' : 'sx-s') : /^-?\d/.test(t) ? 'sx-n' : 'sx-k';
    else if (lang === 'css') c = t.startsWith('/*') ? 'sx-c' : /^["']/.test(t) ? 'sx-s' : /^[#]?[0-9a-f]{3,8}$/i.test(t.slice(1)) && t[0] === '#' ? 'sx-n' : /^-?\d/.test(t) ? 'sx-n' : t.startsWith('--') ? 'sx-a' : t[0] === '@' ? 'sx-k' : /^[.#]/.test(t) ? 'sx-t' : 'sx-a';
    else c = t.startsWith('//') || t.startsWith('/*') || (t[0] === '#' && (lang === 'py' || lang === 'sh' || lang === 'yml')) ? 'sx-c' : /^["'`]/.test(t) ? 'sx-s' : /^\d/.test(t) ? 'sx-n' : kw.has(t) ? 'sx-k' : '';
    push(t, c); i += t.length || 1;
  }
  return out;
}

function code(row, lang) {   // a code cell: syntax colour, with the changed range wrapped
  const kids = [];
  if (row.mark) { const [a, b] = row.mark; const cls = row.k === 'add' ? 'in-add' : 'in-del'; const seg = (s, e, c) => { if (e > s) kids.push(c ? h('span', { class: c }, ...tokens(row.t.slice(s, e), lang)) : h('span', {}, ...tokens(row.t.slice(s, e), lang))); }; seg(0, a); seg(a, b, cls); seg(b, row.t.length); }
  else kids.push(...tokens(row.t, lang));
  return h('td', { class: 'dc' }, ...(kids.length ? kids : ['​']));
}

const sign = (k) => (k === 'add' ? '+' : k === 'del' ? '−' : ' ');
function unified(file, lang) {
  const tb = h('tbody', {}); const cols = { class: 'dtab' };
  for (const hk of file.hunks) {
    pairUp(hk.rows); tb.append(h('tr', { class: 'dr hunk' }, h('td', { class: 'dn', colspan: 2 }, icon('chevron', 12)), h('td', { class: 'dc' }, hk.head)));
    for (const r of hk.rows) { if (r.k === 'note') { tb.append(h('tr', { class: 'dr note' }, h('td', { class: 'dn', colspan: 2 }), h('td', { class: 'dc' }, r.t))); continue; }
      tb.append(h('tr', { class: `dr ${r.k}` }, h('td', { class: 'dn', 'data-n': r.o ?? '' }), h('td', { class: 'dn', 'data-n': r.n ?? '' }), h('td', { class: 'dc', 'data-s': sign(r.k) }, ...code(r, lang).childNodes))); }
  }
  return h('table', cols, tb);
}
function split(file, lang) {
  const tb = h('tbody', {});
  for (const hk of file.hunks) {
    pairUp(hk.rows); tb.append(h('tr', { class: 'dr hunk' }, h('td', { class: 'dn' }, icon('chevron', 12)), h('td', { class: 'dc', colspan: 3 }, hk.head)));
    const rows = hk.rows.filter((r) => r.k !== 'note'); const cell = (r, side) => r ? [h('td', { class: `dn ${r.k}`, 'data-n': (side === 'l' ? r.o : r.n) ?? '' }), h('td', { class: `dc ${r.k}`, 'data-s': sign(r.k) }, ...code(r, lang).childNodes)] : [h('td', { class: 'dn empty' }), h('td', { class: 'dc empty' })];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.k === 'ctx') { tb.append(h('tr', { class: 'dr' }, ...cell(r, 'l'), ...cell(r, 'r'))); continue; }
      let j = i; const dels = [], adds = []; while (rows[j]?.k === 'del') dels.push(rows[j++]); while (rows[j]?.k === 'add') adds.push(rows[j++]);
      for (let x = 0; x < Math.max(dels.length, adds.length); x++) tb.append(h('tr', { class: 'dr' }, ...cell(dels[x], 'l'), ...cell(adds[x], 'r')));
      i = j - 1;
    }
  }
  return h('table', { class: 'dtab split' }, h('colgroup', {}, h('col', { class: 'cn' }), h('col', { class: 'cc' }), h('col', { class: 'cn' }), h('col', { class: 'cc' })), tb);
}

const STATUS = { added: ['Added', 'ok'], deleted: ['Deleted', 'bad'], renamed: ['Renamed', 'warn'], modified: ['', ''] };
// Plain English for the bar: +3 −1 as five squares like GitHub.
function bar(add, del) { const t = add + del; const n = 5; const a = t ? Math.round((add / t) * n) : 0; const d = t ? Math.min(n - a, Math.round((del / t) * n)) : 0; return h('span', { class: 'dbar', 'aria-hidden': 'true' }, ...Array.from({ length: n }, (_, i) => h('i', { class: i < a ? 'a' : i < a + d ? 'd' : '' }))); }

export function diffViewer(text) {
  const files = parseDiff(text); if (!files.length) return h('p', { class: 'muted small' }, 'No changes.');
  let mode = 'unified'; try { mode = localStorage.getItem('af-diff-mode') === 'split' ? 'split' : 'unified'; } catch { /* storage blocked: fine */ }
  const wrap = h('div', { class: 'dv' }); const body = h('div', { class: 'dv-files' }); const sections = [];
  const total = files.reduce((s, f) => ({ add: s.add + f.add, del: s.del + f.del }), { add: 0, del: 0 }); let shown = 0;
  const render = () => {
    body.replaceChildren(); sections.length = 0; shown = 0;
    for (const f of files) {
      const lang = LANG[EXT(f.path)]; const lines = f.hunks.reduce((s, x) => s + x.rows.length, 0); const big = lines > AUTO_COLLAPSE; const over = shown + lines > MAX_LINES; shown += lines;
      const [st, sc] = STATUS[f.status]; const id = `f-${files.indexOf(f)}`;
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : ''; const name = f.path.slice(dir.length);
      let content;
      const mk = () => (f.binary ? h('p', { class: 'dv-note' }, 'Binary file not shown.') : !f.hunks.length ? h('p', { class: 'dv-note' }, f.status === 'renamed' ? `Renamed from ${f.old}` : 'No content changes.') : h('div', { class: 'dv-scroll' }, mode === 'split' ? split(f, lang) : unified(f, lang)));
      const det = h('details', { class: 'dv-file', id, open: !big && !over }, h('summary', {}, h('span', { class: 'dv-chev' }, icon('chevron', 14)), h('span', { class: 'dv-path' }, dir ? h('span', { class: 'dv-dir' }, dir) : null, h('b', {}, name)), st ? h('span', { class: `pill2 ${sc}` }, st) : null, f.binary ? h('span', { class: 'small muted' }, 'binary') : h('span', { class: 'dv-count' }, f.add ? h('span', { class: 'plus' }, `+${f.add}`) : null, f.del ? h('span', { class: 'minus' }, `−${f.del}`) : null, bar(f.add, f.del))));
      const fill = () => { if (!content) { content = mk(); det.append(content); } }; if (det.open) fill(); det.addEventListener('toggle', () => { if (det.open) fill(); });
      if (big || over) det.append(h('p', { class: 'dv-note' }, `${lines.toLocaleString()} changed lines: collapsed. Open the file to see them.`));
      body.append(det); sections.push(det);
    }
  };
  const setAll = (open) => sections.forEach((d) => { d.open = open; });
  const seg = (m, label) => h('button', { type: 'button', class: mode === m ? 'on' : '', 'aria-pressed': String(mode === m), onclick: () => { mode = m; try { localStorage.setItem('af-diff-mode', m); } catch { /* ok */ } segs.replaceChildren(seg('unified', 'Unified'), seg('split', 'Split')); render(); } }, label);
  const segs = h('div', { class: 'dv-seg', role: 'group', 'aria-label': 'Diff layout' }, seg('unified', 'Unified'), seg('split', 'Split'));
  const index = h('details', { class: 'dv-index' }, h('summary', {}, `${files.length} file${files.length === 1 ? '' : 's'} changed`), h('ul', {}, files.map((f, i) => h('li', {}, h('a', { href: `#f-${i}`, onclick: (e) => { e.preventDefault(); const d = sections[i]; d.open = true; d.scrollIntoView({ block: 'start' }); } }, f.path), h('span', { class: 'dv-count' }, f.binary ? 'binary' : [f.add ? h('span', { class: 'plus' }, `+${f.add}`) : null, f.del ? h('span', { class: 'minus' }, `−${f.del}`) : null])))));
  wrap.append(h('div', { class: 'dv-bar' }, h('div', { class: 'dv-sum' }, h('b', {}, `${files.length} file${files.length === 1 ? '' : 's'}`), ' changed ', h('span', { class: 'plus' }, `+${total.add}`), ' ', h('span', { class: 'minus' }, `−${total.del}`)), h('div', { class: 'row nowrap' }, files.length > 1 ? h('button', { type: 'button', class: 'btn sm', onclick: () => setAll(false) }, 'Collapse all') : null, files.length > 1 ? h('button', { type: 'button', class: 'btn sm', onclick: () => setAll(true) }, 'Expand all') : null, segs)), files.length > 1 ? index : null, body);
  render(); return wrap;
}
