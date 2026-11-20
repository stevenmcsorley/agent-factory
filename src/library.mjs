// The reuse library: a catalog of parts (components, hooks, utilities, services, schemas) that live in a git repo you own, so that when
// something is built the factory can say "you already have these", and the agent copies a tested part instead of writing it again.
//
//   <library repo>/parts/<slug>/part.json   name, kind, summary, tags, stack, version, exports, files, usage, origin, changelog
//                              /README.md    generated from the above
//                              /src/...      the part's source (copied into projects, with a provenance header)
//                              /test/...     its tests
// Everything here is pure (no network): the engine does the git and GitHub work. Fingerprints are cheap min-hash sketches of a file's code
// lines, enough to tell "same code, renamed or lightly edited" without a server or embeddings.
import fs from 'node:fs';
import path from 'node:path';

export const KINDS = ['component', 'hook', 'util', 'service', 'schema', 'style', 'config', 'theme', 'pattern', 'form', 'skill', 'other'];
const LANG = { js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', py: 'Python', go: 'Go', rs: 'Rust', rb: 'Ruby', java: 'Java', kt: 'Kotlin', php: 'PHP', vue: 'Vue', svelte: 'Svelte', css: 'CSS', scss: 'CSS', html: 'HTML' };
const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const clip = (v, n) => String(v ?? '').replace(/\u0000/g, '').slice(0, n);
export const slugify = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
const SEMVER = /^\d+\.\d+\.\d+$/;
export const cmpVersion = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); return 0; };
export const bump = (v, level = 'patch') => { const [a, b, c] = String(v).split('.').map(Number); return level === 'major' ? `${a + 1}.0.0` : level === 'minor' ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`; };

// ---------------------------------------------------------------- fingerprints
const K = 24; const SEEDS = Array.from({ length: K }, (_, i) => Math.imul(i + 1, 0x9e3779b1) >>> 0);
const fnv = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const codeLines = (text) => String(text).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l && !/^(\/\/|#|\*|\/\*|--)/.test(l));
const KEYWORDS = new Set('if else elif for while do return function const let var class new throw try catch finally except raise async await import export from default def lambda in of is not and or switch case break continue typeof instanceof null true false undefined None True False this self super func type struct interface package yield with as extends implements static public private protected void int string bool'.split(' '));
const TOKEN = /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|=>|===|!==|==|!=|<=|>=|&&|\|\||[^\s\w]/g;
// Tokens with names, strings and numbers normalised away, so a copy with renamed variables still matches.
const normTokens = (text) => { const out = []; for (const line of codeLines(text).slice(0, 4000)) for (const t of line.match(TOKEN) ?? []) { out.push(KEYWORDS.has(t) ? t : /^[A-Za-z_$]/.test(t) ? 'I' : /^["'`]/.test(t) ? 'S' : /^\d/.test(t) ? 'N' : t); if (out.length >= 60_000) return out; } return out; };
// A sketch of the file: min-hash over 8-token windows of its normalised code. Too short to say anything -> [].
export function minhash(text, { minTokens = 60, shingle = 8 } = {}) {
  const toks = normTokens(text); if (toks.length < minTokens) return [];
  const sig = new Array(K).fill(0xffffffff);
  for (let i = 0; i + shingle <= toks.length; i++) { const h = fnv(toks.slice(i, i + shingle).join(' ')); for (let k = 0; k < K; k++) { const v = Math.imul(h ^ SEEDS[k], 0x85ebca6b) >>> 0; if (v < sig[k]) sig[k] = v; } }
  return sig;
}
export const similarity = (a, b) => { if (!a?.length || a.length !== b?.length) return 0; let n = 0; for (let i = 0; i < a.length; i++) if (a[i] === b[i]) n++; return n / a.length; };
export const contentHash = (text) => fnv(codeLines(text).join('\n')).toString(16);

// ---------------------------------------------------------------- what a file offers
export function exportsOf(text, ext) {
  const out = []; const add = (name, kind, args) => { if (name && !out.some((x) => x.name === name) && out.length < 30) out.push({ name, kind, signature: kind === 'function' ? `${name}(${clip(args, 80).replace(/\s+/g, ' ').trim()})` : name }); };
  const t = String(text).slice(0, 300_000);
  if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte'].includes(ext)) {
    for (const m of t.matchAll(/^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/gm)) add(m[1], 'function', m[2]);
    for (const m of t.matchAll(/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>/gm)) add(m[1], 'function', m[2] ?? m[3]);
    for (const m of t.matchAll(/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=:]/gm)) add(m[1], 'const');
    for (const m of t.matchAll(/^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm)) add(m[1], 'class');
    for (const m of t.matchAll(/^\s*export\s+(?:interface|type)\s+([A-Za-z_$][\w$]*)/gm)) add(m[1], 'type');
    for (const m of t.matchAll(/^\s*module\.exports\s*=\s*\{([^}]*)\}/gm)) for (const n of m[1].split(',')) add(n.split(':')[0].trim(), 'function', '');
    for (const m of t.matchAll(/^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/gm)) add(m[1], 'function', '');
  } else if (ext === 'py') {
    for (const m of t.matchAll(/^(?:async\s+)?def\s+([A-Za-z]\w*)\s*\(([^)]*)\)/gm)) if (!m[1].startsWith('_')) add(m[1], 'function', m[2]);
    for (const m of t.matchAll(/^class\s+([A-Za-z]\w*)/gm)) add(m[1], 'class');
  } else if (ext === 'go') {
    for (const m of t.matchAll(/^func\s+([A-Z]\w*)\s*\(([^)]*)\)/gm)) add(m[1], 'function', m[2]);
  }
  return out;
}
export function classify(files, exps) {
  const e = files.map((f) => path.extname(f).slice(1)); const names = exps.map((x) => x.name);
  if (e.every((x) => ['css', 'scss'].includes(x))) return 'style';
  if (names.some((n) => /^use[A-Z]/.test(n))) return 'hook';
  if (e.some((x) => ['jsx', 'tsx', 'vue', 'svelte'].includes(x)) || names.some((n) => /^[A-Z][a-z]/.test(n) && exps.find((x) => x.name === n)?.kind === 'function')) return 'component';
  if (/zod|schema|joi|yup|types?/i.test(files.join(' ')) || names.some((n) => /schema/i.test(n))) return 'schema';
  if (files.some((f) => /(api|client|service|http|fetch)/i.test(path.basename(f)))) return 'service';
  if (files.some((f) => /config|settings/i.test(path.basename(f)))) return 'config';
  return 'util';
}
export const stackOf = (files) => [...new Set(files.map((f) => LANG[path.extname(f).slice(1).toLowerCase()]).filter(Boolean))];

// ---------------------------------------------------------------- part metadata
export function cleanMeta(m, { existing } = {}) {
  const name = clip(m?.name, 80).trim(); const slug = slugify(m?.slug || name); if (!slug) throw bad('A part needs a name');
  const kind = KINDS.includes(m?.kind) ? m.kind : 'util'; const version = m?.version && SEMVER.test(m.version) ? m.version : existing?.version ?? '0.1.0';
  const strs = (v, n, len) => (Array.isArray(v) ? v : []).map((x) => clip(x, len).trim()).filter(Boolean).slice(0, n);
  return { name: name || slug, slug, kind, summary: clip(m?.summary, 300).trim(), tags: [...new Set(strs(m?.tags, 12, 30).map((t) => t.toLowerCase()))], stack: strs(m?.stack, 6, 30),
    version, exports: (Array.isArray(m?.exports) ? m.exports : []).slice(0, 30).map((x) => ({ name: clip(x?.name, 80), kind: clip(x?.kind, 12), signature: clip(x?.signature, 160) })).filter((x) => x.name),
    files: (Array.isArray(m?.files) ? m.files : []).slice(0, 40).map((f) => ({ path: clip(f?.path, 200), role: f?.role === 'test' ? 'test' : 'source', lines: Number(f?.lines) || 0 })).filter((f) => f.path && !f.path.includes('..')),
    usage: clip(m?.usage, 2000), origin: m?.origin && typeof m.origin === 'object' ? { project: clip(m.origin.project, 60), repo: clip(m.origin.repo, 120), base: clip(m.origin.base, 60), files: strs(m.origin.files, 40, 200) } : undefined,
    deprecated: !!m?.deprecated, replacedBy: m?.replacedBy ? slugify(m.replacedBy) : undefined, createdAt: m?.createdAt ?? existing?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(),
    changelog: (Array.isArray(m?.changelog) ? m.changelog : existing?.changelog ?? []).slice(-30).map((c) => ({ version: clip(c?.version, 20), date: clip(c?.date, 30), note: clip(c?.note, 300) })) };
}
export function readmeFor(meta) {
  const L = [`# ${meta.name}`, '', `\`${meta.slug}@${meta.version}\` · ${meta.kind} · ${meta.stack.join(', ') || 'any stack'}${meta.deprecated ? ` · DEPRECATED${meta.replacedBy ? ` (use ${meta.replacedBy})` : ''}` : ''}`, '', meta.summary || '(no summary yet)', ''];
  if (meta.exports.length) L.push('## API', '', ...meta.exports.map((e) => `- \`${e.signature || e.name}\` (${e.kind})`), '');
  if (meta.usage) L.push('## Usage', '', '```', meta.usage, '```', '');
  L.push('## Files', '', ...meta.files.map((f) => `- \`${f.path}\` (${f.role}, ${f.lines} lines)`), '');
  if (meta.origin?.repo) L.push('## Origin', '', `Extracted from \`${meta.origin.repo}\` (${meta.origin.files.join(', ')}).`, '');
  if (meta.changelog.length) L.push('## Changelog', '', ...meta.changelog.slice().reverse().map((c) => `- **${c.version}** (${c.date.slice(0, 10)}): ${c.note}`), '');
  L.push('Copy the files under `src/` into a project, keep the `factory-part:` header, and the factory will track which version the project uses.', '');
  return L.join('\n');
}

// ---------------------------------------------------------------- reading the catalog from a library checkout
const safeJoin = (root, rel) => { const full = path.resolve(root, rel); if (!full.startsWith(path.resolve(root) + path.sep)) throw bad('bad path'); return full; };
export function readCatalog(dir) {
  const root = path.join(dir, 'parts'); let slugs = []; try { slugs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
  const out = [];
  for (const slug of slugs.sort()) {
    let meta; try { meta = JSON.parse(fs.readFileSync(path.join(root, slug, 'part.json'), 'utf8')); } catch { continue; }
    let clean; try { clean = cleanMeta({ ...meta, slug }, {}); } catch { continue; }
    clean.createdAt = meta.createdAt ?? clean.createdAt; clean.updatedAt = meta.updatedAt ?? clean.updatedAt;
    const sources = clean.files.filter((f) => f.role === 'source'); const prints = []; let lines = 0;
    for (const f of sources) { try { const txt = fs.readFileSync(safeJoin(path.join(root, slug), f.path), 'utf8'); lines += codeLines(txt).length; prints.push({ file: f.path, sig: minhash(txt), hash: contentHash(txt) }); } catch { /* missing file */ } }
    out.push({ ...clean, lines, tested: clean.files.some((f) => f.role === 'test'), prints });
  }
  return out;
}
export function readPart(dir, slug) {
  const s = slugify(slug); const root = path.join(dir, 'parts', s); if (!fs.existsSync(path.join(root, 'part.json'))) throw bad(`No such part: ${slug}`, 404);
  const meta = cleanMeta({ ...JSON.parse(fs.readFileSync(path.join(root, 'part.json'), 'utf8')), slug: s }, {});
  const files = meta.files.map((f) => { let content = ''; try { content = fs.readFileSync(safeJoin(root, f.path), 'utf8').slice(0, 200_000); } catch { /* missing */ } return { ...f, content }; });
  return { ...meta, files, readme: (() => { try { return fs.readFileSync(path.join(root, 'README.md'), 'utf8'); } catch { return readmeFor(meta); } })() };
}
export const publicPart = ({ prints, ...p }) => p;

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'add', 'make', 'use', 'new', 'should', 'when', 'then', 'each', 'all', 'any', 'are', 'can', 'its', 'will', 'has', 'have', 'not', 'but', 'you', 'our', 'your']);
export const tokens = (s) => [...new Set(String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).flatMap((w) => (/[a-z][A-Z]/.test(w) ? w : [w])).filter((w) => w.length > 2 && !STOP.has(w)))];
const splitCamel = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
// Keyword search over name, tags, exports, kind and summary: simple, explainable, no embeddings.
export function searchCatalog(catalog, query, { stack = [], limit = 5, minScore = 3 } = {}) {
  const q = tokens(splitCamel(query)); if (!q.length) return [];
  const want = new Set(stack.map((s) => s.toLowerCase()));
  return catalog.filter((p) => !p.deprecated).map((p) => {
    let score = 0; let strong = false; const hit = new Set(); const why = new Set(); const name = new Set(tokens(`${p.name} ${p.slug}`)), tags = new Set(p.tags), exp = new Set(p.exports.flatMap((e) => tokens(splitCamel(e.name)))), sum = new Set(tokens(p.summary));
    for (const w of q) { if (name.has(w)) { score += 5; strong = true; hit.add(w); why.add(`name “${w}”`); } if (tags.has(w)) { score += 3; strong = true; hit.add(w); why.add(`tag “${w}”`); } if (exp.has(w)) { score += 4; hit.add(w); why.add(`exports “${w}”`); } if (sum.has(w)) { score += 1; hit.add(w); why.add(`“${w}” in summary`); } if (p.kind === w) { score += 2; why.add(`kind ${p.kind}`); } }
    if (q.length >= 2 && hit.size < 2 && !strong) score = 0;                       // one generic word ("parse") is not enough to call it relevant
    if (score && want.size && p.stack.length && p.stack.some((s) => want.has(s.toLowerCase()))) { score += 1; why.add('matches your stack'); } else if (score && want.size && p.stack.length && !p.stack.some((s) => want.has(s.toLowerCase()))) score -= 2;
    return { part: p, score, why: [...why] };
  }).filter((r) => r.score >= minScore).sort((a, b) => b.score - a.score || a.part.slug.localeCompare(b.part.slug)).slice(0, limit);
}

// ---------------------------------------------------------------- building a part from project files
export function provenanceHeader(meta, ext) {
  const text = `factory-part: ${meta.slug}@${meta.version} (reuse library; update via the factory, do not edit in place)`;
  if (['py', 'rb', 'sh'].includes(ext)) return `# ${text}\n`; if (['css', 'scss'].includes(ext)) return `/* ${text} */\n`; if (['html', 'vue', 'svelte', 'svg', 'md'].includes(ext)) return `<!-- ${text} -->\n`; return `// ${text}\n`;
}
const isTestFile = (rel) => /(^|\/)(tests?|__tests__|spec)\//i.test(rel) || /\.(test|spec)\.[a-z]+$/i.test(rel) || /_test\.(go|py)$/.test(rel) || /^test_.*\.py$/.test(path.basename(rel));
// files: [{ rel, content }] from the project (sources and, optionally, their tests). Returns { meta, files: Map(path -> string) } ready to commit into the library.
export function buildPart({ name, kind, summary, tags, usage, version, files, origin, existing, note }) {
  if (!files?.length) throw bad('Pick at least one file'); const used = new Set();
  const src = files.filter((f) => !isTestFile(f.rel)); const tests = files.filter((f) => isTestFile(f.rel)); if (!src.length) throw bad('A part needs at least one source file (not only tests)');
  const place = (dir, f) => { let base = path.basename(f.rel); let p = `${dir}/${base}`; for (let i = 2; used.has(p); i++) p = `${dir}/${i}-${base}`; used.add(p); return p; };
  const placed = [...src.map((f) => ({ f, path: place('src', f), role: 'source' })), ...tests.map((f) => ({ f, path: place('test', f), role: 'test' }))];
  const exps = src.flatMap((f) => exportsOf(f.content, path.extname(f.rel).slice(1).toLowerCase()));
  const ver = version ?? (existing ? bump(existing.version, 'minor') : '0.1.0');
  const meta = cleanMeta({ name, kind: kind ?? classify(src.map((f) => f.rel), exps), summary, tags, usage, version: ver, stack: stackOf(src.map((f) => f.rel)), exports: exps,
    files: placed.map((x) => ({ path: x.path, role: x.role, lines: codeLines(x.f.content).length })), origin, createdAt: existing?.createdAt, changelog: [...(existing?.changelog ?? []), { version: ver, date: new Date().toISOString(), note: note || (existing ? 'Updated' : 'Extracted from a project') }] }, { existing });
  const out = new Map(); for (const x of placed) out.set(`parts/${meta.slug}/${x.path}`, x.f.content);
  out.set(`parts/${meta.slug}/part.json`, `${JSON.stringify(meta, null, 2)}\n`); out.set(`parts/${meta.slug}/README.md`, readmeFor(meta));
  return { meta, files: out };
}

// ---------------------------------------------------------------- who uses what
const HEADER = /factory-part:\s*([a-z0-9-]+)@(\d+\.\d+\.\d+)/;
// files: [{ rel, content }] changed in a run. A file counts as a use if it carries the provenance header or is a copy of a part's source file.
export function detectUsage(files, catalog) {
  const out = []; const hashes = new Map(); for (const p of catalog) for (const pr of p.prints) hashes.set(pr.hash, { slug: p.slug, version: p.version });
  for (const f of files) {
    const h = HEADER.exec(String(f.content).slice(0, 1500)); if (h) { out.push({ slug: h[1], version: h[2], file: f.rel, via: 'header' }); continue; }
    if (codeLines(f.content).length >= 8) { const m = hashes.get(contentHash(f.content)); if (m) out.push({ ...m, file: f.rel, via: 'copy' }); }
  }
  return out;
}
export function updateLock(lock, usages, { library } = {}) {
  const next = { library: library ?? lock?.library ?? null, parts: { ...(lock?.parts ?? {}) } };
  for (const u of usages) { const cur = next.parts[u.slug] ?? { files: [] }; next.parts[u.slug] = { version: u.version, files: [...new Set([...(cur.files ?? []), u.file])].slice(0, 40), updatedAt: new Date().toISOString() }; }
  return next;
}
// Files in a project that reinvent a part: similar to a part file but not carrying its header.
export function reinvented(files, catalog, { threshold = 0.6 } = {}) {
  const out = [];
  for (const f of files) {
    if (HEADER.test(String(f.content).slice(0, 1500))) continue; const sig = minhash(f.content); if (!sig.length) continue; let best = null;
    for (const p of catalog) { if (p.deprecated) continue; for (const pr of p.prints) { const s = similarity(sig, pr.sig); if (s >= threshold && (!best || s > best.s)) best = { s, p }; } }
    if (best) out.push({ file: f.rel, slug: best.p.slug, version: best.p.version, similarity: Math.round(best.s * 100) });
  }
  return out;
}

// ---------------------------------------------------------------- cross-project candidates
// fingerprints: { projectId: [{ file, lines, exports:[names], sig:[...] }] }. Clusters of similar files across (or within) projects.
export function candidates(fingerprints, { threshold = 0.5, nameThreshold = 0.3 } = {}) {
  const items = []; for (const [project, list] of Object.entries(fingerprints)) for (const f of list ?? []) if (f.sig?.length) items.push({ project, ...f });
  const parent = items.map((_, i) => i); const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i]))); const sims = new Map();
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j]; if (a.project === b.project && a.file === b.file) continue;
    const ab = a.kind === 'boilerplate', bb = b.kind === 'boilerplate'; if (ab !== bb) continue;          // templates are only compared with templates
    const s = similarity(a.sig, b.sig); const shared = a.exports?.some((n) => b.exports?.includes(n)); const sameName = ab && a.project !== b.project && path.basename(a.file) === path.basename(b.file);
    if (ab ? (sameName && s >= nameThreshold) : (s >= threshold || (shared && s >= nameThreshold))) { parent[find(i)] = find(j); sims.set(`${i}:${j}`, s); }
  }
  const groups = new Map(); items.forEach((it, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); });
  const out = [];
  for (const idx of groups.values()) {
    if (idx.length < 2) continue; const members = idx.map((i) => items[i]); const best = Math.max(...[...sims.entries()].filter(([k]) => { const [x, y] = k.split(':').map(Number); return idx.includes(x) && idx.includes(y); }).map(([, s]) => s), 0);
    const names = {}; for (const m of members) for (const n of m.exports ?? []) names[n] = (names[n] ?? 0) + 1; const top = Object.entries(names).sort((a, b) => b[1] - a[1])[0]?.[0];
    const projects = [...new Set(members.map((m) => m.project))];
    out.push({ name: top ?? path.basename(members[0].file).replace(/\.[^.]+$/, ''), similarity: Math.round(best * 100), projects, locations: members.map((m) => ({ project: m.project, file: m.file, lines: m.lines })), template: members.every((m) => m.kind === 'boilerplate'), reason: members.every((m) => m.kind === 'boilerplate') ? `The same template file in ${projects.length} project${projects.length > 1 ? 's' : ''}: a recipe, not an importable part` : projects.length > 1 ? `The same code appears in ${projects.length} projects` : 'Near-identical files in one project' });
  }
  return out.sort((a, b) => b.projects.length - a.projects.length || b.similarity - a.similarity || b.locations.length - a.locations.length).slice(0, 40);
}
// The compact index stored with each project's analysis so candidates can be found across projects without re-reading their code.
const FP_LANGS = new Set(['JavaScript', 'TypeScript', 'Python', 'Go', 'Vue', 'Svelte', 'CSS', 'Ruby', 'PHP', 'Java', 'Kotlin']);
// Template files: scripts, packaging, CI, container and build configs. Not code to import, but the same file rewritten per project is exactly what a recipe should hold.
const BOILERPLATE = /(^|\/)(Dockerfile[\w.-]*|docker-compose[\w.-]*\.ya?ml|compose[\w.-]*\.ya?ml|[\w.-]+\.(?:sh|desktop|service|conf|toml)|control|Makefile|tsconfig[\w.-]*\.json|vite\.config\.\w+|eslint\.config\.\w+|\.eslintrc[\w.-]*|\.prettierrc[\w.-]*|\.github\/workflows\/[\w.-]+\.ya?ml|\.gitlab-ci\.yml|nginx[\w.-]*\.conf)$/;
export const isBoilerplate = (rel) => BOILERPLATE.test(rel);
export function boilerplateOf(rel, text, lines) {
  if (!isBoilerplate(rel) || lines < 5 || lines > 400) return null; const sig = minhash(text, { minTokens: 20, shingle: 4 }); if (!sig.length) return null;
  return { file: rel, lines, exports: [], sig, kind: 'boilerplate' };
}
export function fingerprintOf(rel, text, lines, lang) {
  if (!FP_LANGS.has(lang) || lines < 8) return null; const sig = minhash(text); if (!sig.length) return null;
  return { file: rel, lines, exports: exportsOf(text, path.extname(rel).slice(1).toLowerCase()).map((e) => e.name).slice(0, 12), sig };
}

// ---------------------------------------------------------------- profiles: a named "house style" (theme, patterns, forms, skills + conventions) a project can start from
export function cleanProfile(raw) {
  const name = clip(raw?.name, 80).trim(); const slug = slugify(raw?.slug || name); if (!slug) throw bad('A profile needs a name');
  const strs = (v, n, len) => [...new Set((Array.isArray(v) ? v : []).map((x) => slugify(clip(x, len))).filter(Boolean))].slice(0, n);
  return { name: name || slug, slug, description: clip(raw?.description, 300).trim(), parts: strs(raw?.parts, 30, 60), conventions: clip(raw?.conventions, 4000).trim(), stack: (Array.isArray(raw?.stack) ? raw.stack : []).map((x) => clip(x, 30).trim()).filter(Boolean).slice(0, 6), updatedAt: new Date().toISOString() };
}
export function readProfiles(dir) {
  const root = path.join(dir, 'profiles'); let files = []; try { files = fs.readdirSync(root).filter((f) => f.endsWith('.json')); } catch { return []; }
  return files.sort().map((f) => { try { const p = cleanProfile({ ...JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')), slug: f.replace(/\.json$/, '') }); return p; } catch { return null; } }).filter(Boolean);
}
