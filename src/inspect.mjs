// The "look around the code" part of project analysis, in plain terms: how the code is laid out, where code is repeated (which files, which
// lines), and which source files have no test. Fast, line-based, dependency-free; every claim is a heuristic and the UI says so.
import path from 'node:path';

const W = 6;                                   // a "repeat" is at least this many identical code lines in a row
const CODE_LANGS = new Set(['JavaScript', 'TypeScript', 'Python', 'Go', 'Rust', 'Java', 'Kotlin', 'Ruby', 'PHP', 'C#', 'C', 'C++', 'Swift']);
const base = (rel) => path.basename(rel).toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/^test[_-]|[._-](?:test|spec)$/g, '');

// Names a test file refers to (import/require paths), so `import { x } from '../src/gate.mjs'` counts as "gate.mjs has a test".
export function importedNames(text) {
  const out = new Set(); const re = /(?:from|import|require)\s*\(?\s*['"]([^'"\n]{1,200})['"]/g; let m; let n = 0;
  while ((m = re.exec(text)) && n++ < 200) out.add(base(m[1].split('?')[0]));
  return out;
}

// recs: [{ rel, lang, isTest, lines, norm: [{ t, n }], refs?: Set }]  (norm = the meaningful code lines with their real line numbers)
export function inspectCode(recs, { maxWindows = 400_000 } = {}) {
  const src = recs.filter((r) => !r.isTest);

  // ---- layout: lines per folder (two levels deep)
  const dirs = new Map();
  for (const r of recs) {
    const segs = path.dirname(r.rel).split('/').filter((s) => s && s !== '.'); const key = segs.slice(0, 2).join('/') || '(root)';
    const d = dirs.get(key) ?? { path: key, files: 0, lines: 0, testLines: 0 }; d.files++; d.lines += r.lines; if (r.isTest) d.testLines += r.lines; dirs.set(key, d);
  }

  // ---- repeated code: identical runs of W code lines that appear in two places (merged into maximal blocks)
  const seen = new Map(); const blocks = []; let windows = 0, dupLines = 0;
  for (const r of src) {
    const n = r.norm; const mark = new Set(); let cur = null;
    for (let i = 0; i + W <= n.length && windows < maxWindows; i++) {
      windows++; const win = n.slice(i, i + W).map((x) => x.t); if (new Set(win).size < 3) { cur = null; continue; }   // a run of (almost) the same line is a table or filler, not a copy
      const key = win.join('\n'); const o = seen.get(key);
      if (!o) { seen.set(key, { file: r.rel, idx: i, n }); cur = null; continue; }
      if (o.file === r.rel && Math.abs(o.idx - i) < W) { cur = null; continue; }            // overlapping with itself (e.g. a repetitive table): not a copy
      for (let k = 0; k < W; k++) mark.add(i + k);
      if (cur && cur.o.file === o.file && cur.jEnd + 1 === o.idx && cur.iEnd + 1 === i) { cur.iEnd = i; cur.jEnd = o.idx; }
      else { cur = { o, jStart: o.idx, jEnd: o.idx, iStart: i, iEnd: i, bFile: r.rel, bN: n }; blocks.push(cur); }
    }
    dupLines += mark.size;
  }
  const dupBlocks = blocks.map((b) => ({ lines: b.iEnd - b.iStart + W, a: { file: b.o.file, start: b.o.n[b.jStart].n, end: b.o.n[b.jEnd + W - 1].n }, b: { file: b.bFile, start: b.bN[b.iStart].n, end: b.bN[b.iEnd + W - 1].n } }))
    .sort((x, y) => y.lines - x.lines).slice(0, 12).map((b) => ({ ...b, key: `dup:${b.b.file}:${b.b.start}` }));

  // ---- which source files have no test (by name, or because a test imports them)
  const known = new Set(); for (const r of recs.filter((x) => x.isTest)) { known.add(base(r.rel)); r.refs?.forEach((x) => known.add(x)); }
  const sources = src.filter((r) => CODE_LANGS.has(r.lang) && r.lines >= 15);
  const untestedAll = sources.filter((r) => !known.has(base(r.rel)));
  return {
    structure: { dirs: [...dirs.values()].sort((a, b) => b.lines - a.lines).slice(0, 14), sourceFiles: sources.length, testedFiles: sources.length - untestedAll.length, untested: untestedAll.sort((a, b) => b.lines - a.lines).slice(0, 12).map((r) => ({ file: r.rel, lines: r.lines, key: `untested:${r.rel}:1` })) },
    duplicates: { dupLines, blocks: dupBlocks },
  };
}
