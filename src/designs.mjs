// Designs: mockups a designer agent drafts for a project, which you review, comment on, edit and approve.
// Only APPROVED designs reach the builder: they are the visual language its changes must follow.
// A design is a folder under the project pack:  designs/<id>/design.json  +  v1.html, v2.html, ...
// Each mockup is one self-contained HTML file. It is shown in a sandboxed frame with no scripts and no network, and is cleaned on the way in as a second layer.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const STATUSES = ['drafting', 'proposed', 'approved', 'rejected', 'failed', 'archived'];
export const MAX_IN_USE = 6;   // the builder is told about this many approved designs; more would crowd out the ticket
export const KINDS = ['screen', 'assets'];
const LIMITS = { area: 40, svg: 60_000, assetFiles: 12, html: 400_000, title: 100, request: 6_000, feedback: 4_000, rationale: 1_500, comments: 60, versions: 30, designs: 40 };
const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const clip = (v, n) => String(v ?? '').replace(/\r\n/g, '\n').replace(/\u0000/g, '').slice(0, n);
const ID = /^[a-f0-9]{8}$/;
const root = (packDir) => path.join(packDir, 'designs');
const dirOf = (packDir, id) => { if (!ID.test(String(id))) throw bad('Bad design id', 404); return path.join(root(packDir), id); };
const write = (f, data) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(`${f}.tmp`, data); fs.renameSync(`${f}.tmp`, f); };

// Defence in depth: the frame is sandboxed and its CSP forbids scripts and network, but nothing active should be stored at all.
export function cleanDesignHtml(input) {
  let html = clip(input, LIMITS.html + 1); if (html.length > LIMITS.html) throw bad(`A design can be at most ${LIMITS.html / 1000} KB of HTML`);
  html = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|iframe|object|embed)\b[\s\S]*?(<\/\1\s*>|$)/gi, '').replace(/<\/?(script|iframe|object|embed|link|base|meta|form)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '').replace(/\b(href|src|action|formaction|xlink:href)\s*=\s*("\s*(?:javascript|data:text\/html|vbscript):[^"]*"|'\s*(?:javascript|data:text\/html|vbscript):[^']*')/gi, '$1="#"')
    .replace(/@import[^;]+;?/gi, '').replace(/url\(\s*(['"]?)\s*(?:https?:)?\/\/[^)]*\)/gi, 'none');
  if (!/<(html|body|div|main|section|header|nav|style)\b/i.test(html)) throw bad('That does not look like an HTML page');
  if (!/<html\b/i.test(html)) html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${html}</body></html>`;
  return html;
}

// SVG artwork is data we will commit to a repo and show in pages, so it is cleaned on the way in: nothing active, nothing that fetches, nothing outside the picture.
export function cleanSvg(input) {
  let svg = clip(input, LIMITS.svg + 1).trim(); if (svg.length > LIMITS.svg) throw bad(`An SVG file can be at most ${LIMITS.svg / 1000} KB`);
  const start = svg.search(/<svg[\s>]/i); if (start < 0) throw bad('That is not an SVG (it has no <svg> element)'); svg = svg.slice(start); const end = svg.toLowerCase().lastIndexOf('</svg>'); if (end < 0) throw bad('The SVG is not closed'); svg = svg.slice(0, end + 6);
  svg = svg.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?xml[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[^>]*>/gi, '').replace(/<(script|foreignObject|iframe|object|embed|image|audio|video|animate|set)\b[\s\S]*?(<\/\1\s*>|\/>)/gi, '')
    .replace(/<\/?(script|foreignObject|iframe|object|embed|image|link|meta)\b[^>]*>/gi, '').replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(xlink:)?href\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*')/gi, '').replace(/@import[^;]+;?/gi, '').replace(/url\(\s*(['"]?)\s*(?!#)[^)]*\)/gi, 'none');
  if (!/<svg[^>]*\sxmlns=/i.test(svg)) svg = svg.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return svg;
}
const assetName = (n) => { const base = String(n ?? '').replace(/\.svg$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); if (!base) throw bad('Every asset needs a file name'); return base; };
const dataUri = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
// A contact sheet so the set can be judged at a glance: every file on light and dark, at three sizes.
function contactSheet(title, files) {
  // Inline, not <img>: an image does not inherit the text colour, so a currentColor icon would turn black on the dark panel.
  const cell = (f, bg, fg) => `<div class="c" style="background:${bg};color:${fg}">${[96, 40, 20].map((px) => `<span class="i" style="width:${px}px;height:${px}px">${f.svg}</span>`).join('')}</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:14px system-ui;margin:0;padding:20px;background:#f4f4f2;color:#222}h1{font-size:18px;margin:0 0 16px}.row{display:grid;grid-template-columns:150px 1fr 1fr;gap:10px;align-items:center;margin-bottom:10px}.n{font:12px ui-monospace,monospace}.c{display:flex;gap:16px;align-items:center;padding:12px 16px;border:1px solid #ddd;border-radius:8px}.i{display:block;flex:none}.i svg{width:100%;height:100%;display:block}@media(max-width:560px){.row{grid-template-columns:1fr}}</style></head><body><h1>${title.replace(/[<>&]/g, '')}</h1>${files.map((f) => `<div class="row"><div class="n">${f.name}.svg</div>${cell(f, '#ffffff', '#111')}${cell(f, '#161616', '#eee')}</div>`).join('')}</body></html>`;
}

const cleanArea = (a) => String(a ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, LIMITS.area);
const load = (packDir, id) => { try { return JSON.parse(fs.readFileSync(path.join(dirOf(packDir, id), 'design.json'), 'utf8')); } catch (e) { if (e.status) throw e; throw bad('No such design', 404); } };
const save = (packDir, d) => { d.updatedAt = new Date().toISOString(); write(path.join(dirOf(packDir, d.id), 'design.json'), JSON.stringify(d, null, 2)); return d; };

export function listDesigns(packDir) {
  let ids = []; try { ids = fs.readdirSync(root(packDir)).filter((x) => ID.test(x)); } catch { /* none yet */ }
  return ids.map((id) => { try { return load(packDir, id); } catch { return null; } }).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
export const getDesign = (packDir, id) => load(packDir, id);
export function createDesign(packDir, { title, request, kind = 'screen', area }) {
  if (!KINDS.includes(kind)) throw bad(`kind must be one of ${KINDS.join(', ')}`);
  const t = clip(title, LIMITS.title).trim(), r = clip(request, LIMITS.request).trim();
  if (!t) throw bad('Give the design a title'); if (r.length < 15) throw bad('Describe what to design (a sentence or two at least)');
  if (listDesigns(packDir).length >= LIMITS.designs) throw bad(`A project can have ${LIMITS.designs} designs. Delete one you no longer need.`);
  const d = { id: crypto.randomBytes(4).toString('hex'), kind, title: t, ...(cleanArea(area) ? { area: cleanArea(area) } : {}), request: r, status: 'drafting', versions: [], comments: [], createdAt: new Date().toISOString() };
  return save(packDir, d);
}
export function addVersion(packDir, id, { html, rationale, by = 'designer', feedback }) {
  const d = load(packDir, id); if (d.kind === 'assets') throw bad('This design is a set of assets: save SVG files, not a page'); if (d.versions.length >= LIMITS.versions) throw bad(`A design keeps ${LIMITS.versions} versions at most`);
  const clean = cleanDesignHtml(html); const n = (d.versions.at(-1)?.n ?? 0) + 1;
  write(path.join(dirOf(packDir, id), `v${n}.html`), clean);
  d.versions.push({ n, at: new Date().toISOString(), by, bytes: clean.length, rationale: clip(rationale, LIMITS.rationale).trim(), ...(feedback ? { feedback: clip(feedback, LIMITS.feedback) } : {}) });
  d.status = d.approvedVersion ? 'approved' : 'proposed'; delete d.error; return save(packDir, d);   // a newer version waits for approval; the approved one stays in use meanwhile
}
// Assets: a set of SVG files. Each version is a folder v<n>/ of files plus v<n>.html, the contact sheet shown in the preview frame.
export function addAssetVersion(packDir, id, { files, rationale, by = 'designer', feedback }) {
  const d = load(packDir, id); if (d.kind !== 'assets') throw bad('This design is a screen, not a set of assets'); if (d.versions.length >= LIMITS.versions) throw bad(`A design keeps ${LIMITS.versions} versions at most`);
  const list = Array.isArray(files) ? files : Object.entries(files ?? {}).map(([name, svg]) => ({ name, svg })); if (!list.length) throw bad('There are no files to save'); if (list.length > LIMITS.assetFiles) throw bad(`At most ${LIMITS.assetFiles} files per set`);
  const seen = new Set(); const clean = list.map((f) => { let name = assetName(f.name); while (seen.has(name)) name = `${name}-2`; seen.add(name); return { name, svg: cleanSvg(f.svg) }; });
  const n = (d.versions.at(-1)?.n ?? 0) + 1; for (const f of clean) write(path.join(dirOf(packDir, id), `v${n}`, `${f.name}.svg`), f.svg); write(path.join(dirOf(packDir, id), `v${n}.html`), contactSheet(d.title, clean));
  d.versions.push({ n, at: new Date().toISOString(), by, bytes: clean.reduce((a, f) => a + f.svg.length, 0), files: clean.map((f) => f.name), rationale: clip(rationale, LIMITS.rationale).trim(), ...(feedback ? { feedback: clip(feedback, LIMITS.feedback) } : {}) });
  d.status = d.approvedVersion ? 'approved' : 'proposed'; delete d.error; return save(packDir, d);   // a newer version waits for approval; the approved one stays in use meanwhile
}
export function readAssets(packDir, id, version) {
  const d = load(packDir, id); const n = version ?? d.approvedVersion ?? d.versions.at(-1)?.n; const v = d.versions.find((x) => x.n === n); if (!v?.files) throw bad('No such version', 404);
  return v.files.map((name) => ({ name, svg: fs.readFileSync(path.join(dirOf(packDir, id), `v${Number(n)}`, `${name}.svg`), 'utf8') }));
}
export function setPublished(packDir, id, info) { const d = load(packDir, id); d.published = { ...info, at: new Date().toISOString() }; return save(packDir, d); }
export function readHtml(packDir, id, version) {
  const d = load(packDir, id); const n = version ?? d.approvedVersion ?? d.versions.at(-1)?.n; if (!d.versions.some((v) => v.n === n)) throw bad('No such version', 404);
  return fs.readFileSync(path.join(dirOf(packDir, id), `v${Number(n)}.html`), 'utf8');
}
export function addComment(packDir, id, text, by = 'you') {
  const d = load(packDir, id); const t = clip(text, LIMITS.feedback).trim(); if (!t) throw bad('Write the comment first');
  d.comments.push({ at: new Date().toISOString(), by, text: t }); if (d.comments.length > LIMITS.comments) d.comments.shift(); return save(packDir, d);
}
// Only one approved design per area guides the builder: approving a new one retires the old one (archived, with a pointer to what replaced it).
function supersede(packDir, d) {
  const retired = []; if (!d.area) return retired;
  for (const o of listDesigns(packDir)) if (o.id !== d.id && o.status === 'approved' && o.area && o.area.toLowerCase() === d.area.toLowerCase()) { o.status = 'archived'; o.archivedFrom = 'approved'; o.supersededBy = d.id; delete o.approvedVersion; save(packDir, o); retired.push(o.id); }
  return retired;
}
export function setStatus(packDir, id, status, version) {
  const d = load(packDir, id);
  if (status === 'approved') { const n = version ?? d.versions.at(-1)?.n; if (!d.versions.some((v) => v.n === n)) throw bad('Nothing to approve yet: the designer has not produced a version'); d.status = 'approved'; d.approvedVersion = n; d.approvedAt = new Date().toISOString(); delete d.supersededBy; delete d.archivedFrom; }
  else if (status === 'rejected') { d.status = 'rejected'; delete d.approvedVersion; }
  else if (status === 'proposed') { if (!d.versions.length) throw bad('There is no version to reopen'); d.status = 'proposed'; delete d.approvedVersion; }
  else if (status === 'drafting') { if (!d.approvedVersion) d.status = 'drafting'; delete d.error; }   // revising an approved design does not take it out of use
  else if (status === 'failed') { d.status = d.approvedVersion ? 'approved' : d.versions.length ? 'proposed' : 'failed'; }
  else if (status === 'archived') { if (d.status === 'drafting') throw bad('The designer is still working on this one'); d.archivedFrom = d.status === 'archived' ? d.archivedFrom : d.status; d.status = 'archived'; delete d.approvedVersion; }
  else throw bad(`Unknown status ${status}`);
  const saved = save(packDir, d); if (status === 'approved') { const retired = supersede(packDir, saved); if (retired.length) saved.retired = retired; } return saved;
}
// Back from the archive as "waiting for you": a restored design is never silently in use again.
export function restoreDesign(packDir, id) { const d = load(packDir, id); if (d.status !== 'archived' && d.status !== 'rejected') throw bad('Only an archived or rejected design can be restored'); d.status = d.versions.length ? 'proposed' : 'failed'; delete d.archivedFrom; delete d.supersededBy; return save(packDir, d); }
export function updateMeta(packDir, id, { title, area }) { const d = load(packDir, id); if (title !== undefined) { const t = clip(title, LIMITS.title).trim(); if (!t) throw bad('A design needs a title'); d.title = t; } if (area !== undefined) { const a = cleanArea(area); if (a) d.area = a; else delete d.area; } return save(packDir, d); }
// Remove one version's files and record. The version in use, and the last remaining version, cannot be removed.
export function deleteVersion(packDir, id, n) {
  const d = load(packDir, id); const v = d.versions.find((x) => x.n === n); if (!v) throw bad('No such version', 404);
  if (d.approvedVersion === n) throw bad('That version is in use by the builder. Approve another version first, or withdraw the approval.'); if (d.versions.length <= 1) throw bad('This is the only version. Delete the whole design instead.');
  fs.rmSync(path.join(dirOf(packDir, id), `v${n}.html`), { force: true }); fs.rmSync(path.join(dirOf(packDir, id), `v${n}`), { recursive: true, force: true });
  d.versions = d.versions.filter((x) => x.n !== n); return save(packDir, d);
}
// What is in use, and whether more is approved than the builder can be told about.
export function inUse(packDir) { const ok = listDesigns(packDir).filter((d) => d.status === 'approved' && d.approvedVersion); return { designs: ok.map((d) => ({ id: d.id, title: d.title, kind: d.kind ?? 'screen', area: d.area ?? null, version: d.approvedVersion })), told: Math.min(ok.length, MAX_IN_USE), overLimit: Math.max(0, ok.length - MAX_IN_USE), max: MAX_IN_USE }; }
export const setError = (packDir, id, message) => { const d = load(packDir, id); d.error = clip(message, 400); if (!d.versions.length) d.status = 'failed'; else if (d.status === 'drafting') d.status = 'proposed'; return save(packDir, d); };
export function removeDesign(packDir, id) { dirOf(packDir, id); fs.rmSync(dirOf(packDir, id), { recursive: true, force: true }); return { removed: true }; }

const styleOf = (html) => [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1].trim()).join('\n');
// What the builder is told about approved designs: a short brief per design plus the stylesheet (colours, type, spacing live there), and where the full file is.
// slim: when a ticket is told exactly which screen it builds, the other screens are listed (title, path) and only ONE stylesheet is included (the shared tokens), not every screen's.
export function designContext(packDir, { slim = false } = {}) {
  const approved = listDesigns(packDir).filter((d) => d.status === 'approved' && d.approvedVersion).slice(0, MAX_IN_USE); if (!approved.length) return '';   // most recently updated first; inUse() reports anything beyond the cap
  const screens = approved.filter((d) => d.kind !== 'assets'); const sets = approved.filter((d) => d.kind === 'assets'); const out = []; const shared = (screens.find((d) => d.area === 'index' || d.area === 'home') ?? screens[0])?.id;
  if (screens.length) out.push(`### Approved designs (follow these: same look, same patterns. They are the owner's decision, not a suggestion)\n${screens.slice(0, MAX_IN_USE).map((d) => { let css = ''; if (!slim || d.id === shared) try { css = styleOf(readHtml(packDir, d.id, d.approvedVersion)).slice(0, 2500); } catch { /* skip */ }
    const v = d.versions.find((x) => x.n === d.approvedVersion);
    return `#### ${d.title}\nWhat it is: ${d.request.slice(0, slim ? 160 : 400)}\n${v?.rationale && !slim ? `Designer's notes: ${v.rationale}\n` : ''}Full mockup: .factory-context/designs/${d.id}.html\n${css ? `Its stylesheet (the colours, type and spacing to reuse):\n\`\`\`css\n${css}\n\`\`\`` : ''}`; }).join('\n\n')}`);
  if (sets.length) out.push(`### Approved artwork (use these files; do not draw your own logo, icons or illustrations)\n${sets.slice(0, MAX_IN_USE).map((d) => { const v = d.versions.find((x) => x.n === d.approvedVersion); const where = d.published?.dir ? `already in the repository at ${d.published.dir}/` : `in .factory-context/designs/${d.id}/ (copy into the project where it belongs, for example public/ or src/assets/)`;
    return `#### ${d.title}\nWhat it is: ${d.request.slice(0, 300)}\nFiles (${where}): ${(v?.files ?? []).map((f) => `${f}.svg`).join(', ')}`; }).join('\n\n')}`);
  return out.join('\n\n');
}
export function materializeDesigns(packDir, wsDir) {
  const approved = listDesigns(packDir).filter((d) => d.status === 'approved' && d.approvedVersion); if (!approved.length) return;
  const out = path.join(wsDir, '.factory-context', 'designs'); fs.mkdirSync(out, { recursive: true });
  for (const d of approved) { try { if (d.kind === 'assets') { for (const f of readAssets(packDir, d.id, d.approvedVersion)) { fs.mkdirSync(path.join(out, d.id), { recursive: true }); fs.writeFileSync(path.join(out, d.id, `${f.name}.svg`), f.svg); } } else fs.writeFileSync(path.join(out, `${d.id}.html`), readHtml(packDir, d.id, d.approvedVersion)); } catch { /* skip */ } }
}
