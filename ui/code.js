// The Code tab: an explorer for what the analysis found. Overview, Findings (with the code line, why it matters and how to fix it),
// Files, Repeated code, Tests and Ignored. Filters and sorting update the list in place, so typing never loses focus.
import { h, icon, api, toast, ago, num, ext, act } from './lib.js';

const SEV = ['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'INFO'];
const SEV_LABEL = { BLOCKER: 'Blocker', CRITICAL: 'Critical', MAJOR: 'Major', MINOR: 'Minor', INFO: 'Info' };
const TYPE_LABEL = { vulnerability: 'Vulnerabilities', bug: 'Bugs', code_smell: 'Code smells' };
const SERIOUS = new Set(['BLOCKER', 'CRITICAL']);

// Plain-English help for every rule: what it means, why it matters, how to fix it.
const RULES = {
  secret: { title: 'Hard-coded secret', why: 'Anyone who can read the repository can use this key or password. Leaked keys are found and abused by bots within minutes.', fix: 'Remove it from the code, rotate the key (assume it is compromised), and read it from an environment variable or a secrets manager.' },
  'secret-in-test': { title: 'Key-shaped string in a test', why: 'Usually a harmless fake, but a real key left in a test file is still a leak.', fix: 'Check it is a dummy value. Mark deliberate fixtures with a quality-ignore comment at the end of the line.' },
  eval: { title: 'eval() or new Function()', why: 'It runs text as code. If any part of that text can come from a user, an attacker can run their own code.', fix: 'Use JSON.parse for data, a lookup table for choices, or a real parser for expressions.' },
  'inner-html': { title: 'HTML set from a string', why: 'Putting untrusted text into innerHTML allows cross-site scripting (XSS).', fix: 'Use textContent, or build elements with the DOM API.' },
  'shell-true': { title: 'Shell command built from a string', why: 'With shell=True, anything in the string is interpreted by the shell, which allows command injection.', fix: 'Pass the command as a list of arguments and leave shell off.' },
  'tls-off': { title: 'Certificate checks switched off', why: 'Without certificate verification anyone on the network can impersonate the server and read or change the traffic.', fix: 'Remove the setting. If a private certificate is the reason, trust that certificate instead.' },
  'empty-catch': { title: 'Empty error handler', why: 'Failures disappear silently, so bugs show up later and far away from their cause.', fix: 'Handle the error, log it, or say in a comment why ignoring it is safe.' },
  'empty-except': { title: 'except … pass', why: 'Failures disappear silently, so bugs show up later and far away from their cause.', fix: 'Catch the specific error you expect, and log or handle it.' },
  debugger: { title: 'Leftover debugger statement', why: 'It pauses execution for anyone who opens developer tools.', fix: 'Delete the line.' },
  'py-debug': { title: 'Leftover debugger call', why: 'It stops the program and waits for a person at a terminal.', fix: 'Delete the line.' },
  console: { title: 'Leftover console.log', why: 'Debug output clutters logs and can leak data.', fix: 'Remove it, or use the project’s logger.' },
  'long-function': { title: 'Very long function', why: 'Long functions are hard to read, test and change safely, and are where bugs hide.', fix: 'Split it into smaller functions with clear names.' },
  'deep-nesting': { title: 'Deeply nested code', why: 'Many levels of if/for make the logic hard to follow.', fix: 'Use early returns and move inner blocks into helper functions.' },
  'long-file': { title: 'Very long file', why: 'Big files mix many responsibilities and are slow to understand and review.', fix: 'Split it along its natural boundaries into smaller modules.' },
};
RULES['test-weakened'] = { title: 'Existing test weakened', why: 'The change removed assertions, deleted a test file or switched a test off. When the code and its test are written by the same agent, a green run can just mean the test was loosened to match.', fix: 'Restore the test and fix the code. If an expectation is genuinely wrong, change it deliberately and explain why in the PR so the owner can confirm.' };
RULES['reinvented-part'] = { title: 'Rewrites a library part', why: 'This new file is almost the same as a part already in the reuse library, so a fix or improvement would now have to be made in two places.', fix: 'Copy the library part (keeping its factory-part header) instead, or improve the part in the library and use that.' };
const ruleOf = (id) => RULES[id] ?? { title: id, why: '', fix: '' };

const view = { sub: 'overview', sev: new Set(), type: new Set(), q: '', group: 'file', shown: 15, fsort: 'lines', fq: '', fonly: 'all' };

const card = (cls, ...kids) => h('section', { class: `card ${cls ?? ''}` }, ...kids);
const meter = (frac, cls = '') => { const e = h('i', { class: 'mfill' }); e.style.width = `${Math.max(1, Math.min(100, Math.round(frac * 100)))}%`; return h('span', { class: `mtrack ${cls}` }, e); };
const pill = (text, cls = '') => h('span', { class: `pill2 ${cls}` }, text);
const sevPill = (s) => h('span', { class: `sev sev-${s}` }, SEV_LABEL[s] ?? s);
const copy = async (text, label) => { try { await navigator.clipboard.writeText(text); toast(`${label} copied`, 'ok'); } catch { toast('Copy failed', 'bad'); } };

// Link to a file (and line) in the repository on the code host.
export const fileUrl = (p, file, line) => {
  if (!p?.repoUrl || !file) return null;
  const base = String(p.base ?? 'main').split('/').map(encodeURIComponent).join('/'); const path = String(file).split('/').map(encodeURIComponent).join('/');
  if (p.host === 'github') return `${p.repoUrl}/blob/${base}/${path}${line ? `#L${line}` : ''}`;
  if (p.host === 'gitlab') return `${p.repoUrl}/-/blob/${base}/${path}${line ? `#L${line}` : ''}`;
  if (p.host === 'bitbucket') return `${p.repoUrl}/src/${base}/${path}${line ? `#lines-${line}` : ''}`;
  return null;
};
const where = (p, file, line, cls = 'loc') => { const url = fileUrl(p, file, line); const txt = `${file}${line ? `:${line}` : ''}`; return (url && ext(url, txt, cls)) || h('span', { class: cls }, txt); };
// Jump straight to a sub-tab (used by the Board card's "see all" buttons).
export const openCode = (sub = 'overview', patch) => { view.sub = sub; if (patch) Object.assign(view, patch); };
const splitPath = (f) => { const i = f.lastIndexOf('/'); return i < 0 ? ['', f] : [f.slice(0, i + 1), f.slice(i + 1)]; };

export function codeTab(pr, ctx) {
  const { proj, onReanalyze, onFix, onIgnore, job } = ctx;
  const running = job?.state === 'running';
  const reBtn = h('button', { class: 'btn', disabled: running, onclick: onReanalyze }, running ? `Analyzing… ${job.phase ?? ''}` : pr ? 'Re-analyze' : 'Analyze now');
  if (!pr?.metrics) return card('', h('div', { class: 'card-h' }, h('h2', {}, 'Inspect the code'), reBtn), h('p', { class: 'muted' }, pr ? 'Nothing to inspect: the repository has no code yet.' : 'This project has not been inspected yet. Press Analyze to see how the code is laid out, what needs attention, where code is repeated and which files have no test.'), job?.state === 'error' ? h('div', { class: 'note bad' }, icon('alert', 14), ' ', job.error) : null);

  const q = pr.quality, st = pr.structure, du = pr.duplicates, ig = pr.ignored;
  const counts = q?.counts ?? { total: 0 };
  const tabs = [['overview', 'Overview'], ['findings', 'Findings', counts.total], ['files', 'Files', st?.files?.length], ['repeats', 'Repeated code', du?.blocks?.length], ['tests', 'Tests', st ? `${st.testedFiles}/${st.sourceFiles}` : null], ['ignored', 'Ignored', ig ? ig.defaults + ig.yours + (ig.gitignored ?? 0) + ig.folders : null]];
  const body = h('div', { class: 'codebody' });
  const nav = h('div', { class: 'subtabs', role: 'tablist' });
  const go = (sub, patch) => { view.sub = sub; if (patch) Object.assign(view, patch); drawNav(); drawBody(); };
  const drawNav = () => nav.replaceChildren(...tabs.map(([k, label, n]) => h('button', { role: 'tab', 'aria-selected': String(view.sub === k), class: view.sub === k ? 'on' : '', onclick: () => go(k) }, label, n != null && n !== 0 ? h('span', { class: 'badge' }, String(n)) : null)));
  const api2 = { pr, proj, q, st, du, ig, go, onFix, onIgnore, onVerify: ctx.onVerify };
  const drawBody = () => { body.replaceChildren(...({ overview, findings, files, repeats, tests, ignored }[view.sub] ?? overview)(api2)); };
  drawNav(); drawBody();
  return [card('head', h('div', { class: 'card-h' }, h('h2', {}, 'Inspect the code'), h('span', { class: 'muted small mono' }, `${num(pr.metrics.codeLines)} lines · ${pr.metrics.sourceFiles} files · analyzed ${ago(pr.analyzedAt)}`), reBtn),
    job?.state === 'error' ? h('div', { class: 'note bad' }, icon('alert', 14), ' Last analysis failed: ', job.error) : null,
    h('p', { class: 'muted small' }, 'A quick, line-based look at the code: good for orientation, not a full static analyser. Every problem has a button that turns it into a ticket for the agent.'), nav), body];
}

// ---------------------------------------------------------------- overview
function overview({ pr, proj, q, st, du, go, onFix, onVerify }) {
  const m = pr.metrics; const counts = q?.counts ?? { total: 0, secrets: 0, vulnerabilities: 0, bugs: 0 }; const gateOk = q?.gate?.status === 'OK'; const serious = SEV.filter((s) => SERIOUS.has(s)).reduce((a, s) => a + (q?.bySeverity?.[s] ?? 0), 0);
  const tile = (label, value, sub, cls = '') => h('div', { class: `tile ${cls}` }, h('span', { class: 'tile-l' }, label), h('b', {}, value), sub ? h('span', { class: 'tile-s' }, sub) : null);
  const steps = [];
  if (serious) steps.push({ cls: 'bad', title: `${serious} serious finding${serious > 1 ? 's' : ''} to review`, text: 'Blockers and critical issues, such as committed secrets or dangerous calls.', act: ['Review them', () => go('findings', { sev: new Set(['BLOCKER', 'CRITICAL']), type: new Set(), q: '', shown: 15 })] });
  const big = st?.files?.find((f) => f.lines >= 400); if (big) steps.push({ cls: 'warn', title: `${big.file} is ${num(big.lines)} lines`, text: 'Very large files are hard to change safely.', act: ['Queue a split', () => onFix({ key: `big:${big.file}` })] });
  const un = st?.untested?.[0]; if (un) steps.push({ cls: 'warn', title: `${un.file} has no test`, text: `The biggest untested file (${un.lines} lines). Tests make the agent’s changes safer.`, act: ['Queue tests', () => onFix({ key: un.key })] });
  const dup = du?.blocks?.[0]; if (dup) steps.push({ cls: 'warn', title: `${dup.lines} repeated lines`, text: `${dup.a.file} and ${dup.b.file} contain the same code.`, act: ['Queue cleanup', () => onFix({ key: dup.key })] });
  if (!pr.verify && !proj?.verify) steps.push({ cls: 'bad', title: 'No way to run tests was found', text: 'Pull requests will be opened unverified. Set a test command below, or add tests.', act: null });
  const trend = (pr.history ?? []).map((x) => x.findings).filter(Number.isFinite);
  return [
    card('', h('div', { class: 'tiles' },
      tile('Quality gate', gateOk ? 'Passed' : 'Failed', gateOk ? 'no secrets, nothing critical' : (q?.gate?.failed ?? []).join(' · '), gateOk ? 'ok' : 'bad'),
      tile('Findings', num(counts.total), `${counts.secrets} secrets · ${counts.vulnerabilities} vulnerabilities · ${counts.bugs} bugs`),
      tile('Tests', `${m.testRatioPct}%`, st ? `${st.testedFiles} of ${st.sourceFiles} files covered` : `${m.testFiles} test files`),
      tile('Repeated code', `${du?.pct ?? 0}%`, `${du?.blocks?.length ?? 0} blocks`), tile('Size', num(m.codeLines), `${m.sourceFiles} files`)),
      h('div', { class: 'ratings' }, Object.entries(m.ratings).map(([k, v]) => h('div', { class: 'rating' }, h('b', { class: `grade r-${v}` }, v), h('span', {}, { size: 'Size', tests: 'Tests', duplication: 'Duplication', maintainability: 'Upkeep', security: 'Secrets' }[k] ?? k))))),
    card('', h('div', { class: 'card-h' }, h('h2', {}, 'What to look at first')),
      steps.length ? h('ul', { class: 'steps' }, steps.map((s) => h('li', { class: s.cls }, h('i', { class: 'dot' }), h('div', {}, h('b', {}, s.title), h('p', { class: 'muted small' }, s.text)), s.act ? h('button', { class: 'btn small', onclick: s.act[1] }, s.act[0]) : null)))
        : h('p', { class: 'ok-note' }, icon('check', 16), ' Nothing urgent. No serious findings, no huge files, tests and repeats look fine.')),
    card('', h('div', { class: 'card-h' }, h('h2', {}, 'How the agent\u2019s work is checked'), proj?.verify || pr.verify ? h('span', { class: 'stamp ok' }, 'set') : h('span', { class: 'stamp warn' }, 'not set')),
      h('p', { class: 'muted small' }, proj?.verify ? 'Using the command you set. The repository\u2019s own .agent-factory.json still wins over it.' : pr.verify ? `Detected: ${pr.verify}. Set your own to override it.` : 'Nothing was found. One command that installs what it needs and runs the tests, for example: npm ci && npm test'),
      (() => { const v = h('input', { value: proj?.verify ?? '', placeholder: pr.verify || 'npm ci && npm test', 'aria-label': 'Test command' }); const i = h('input', { value: proj?.image ?? '', placeholder: pr.image || 'container image, e.g. python:3.12-bookworm (optional)', 'aria-label': 'Container image' });
        return h('div', {}, h('div', { class: 'two' }, h('div', {}, h('label', {}, 'Test command'), v), h('div', {}, h('label', {}, 'Image'), i)), h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', onclick: () => onVerify({ verify: v.value, image: i.value }) }, 'Save'), h('span', { class: 'small muted' }, 'Empty clears it and detection applies again.'))); })()),
    st?.dirs?.length ? card('', h('div', { class: 'card-h' }, h('h2', {}, 'Where the code lives')), h('div', { class: 'rows' }, st.dirs.map((d) => h('div', { class: 'row-bar' }, h('code', {}, d.path), meter(d.lines / st.dirs[0].lines), h('span', { class: 'mono small' }, `${num(d.lines)} lines · ${d.files} files`, d.testLines ? ` · ${d.testLines === d.lines ? 'all tests' : `${num(d.testLines)} test`}` : ''))))) : null,
    trend.length > 1 ? card('', h('div', { class: 'card-h' }, h('h2', {}, 'Trend'), h('span', { class: 'muted small' }, `findings over the last ${Math.min(trend.length, 30)} analyses`)), h('div', { class: 'spark' }, trend.slice(-30).map((v) => { const e = h('i', {}); e.style.height = `${Math.max(4, (v / Math.max(1, ...trend)) * 100)}%`; return e; }))) : null,
  ];
}

// ---------------------------------------------------------------- findings
function findings({ pr, proj, q, go, onFix, onIgnore }) {
  const all = q?.findings ?? []; const total = q?.counts?.total ?? 0;
  if (!total) return [card('', h('p', { class: 'ok-note big' }, icon('check', 20), ' No findings. The rules found nothing to flag in this code.'))];
  const list = h('div', { class: 'flist' }); const summary = h('span', { class: 'muted small' });
  const search = h('input', { type: 'search', placeholder: 'Search file, rule or code…', value: view.q, 'aria-label': 'Search findings', oninput: (e) => { view.q = e.target.value; view.shown = 15; paint(); } });
  const chip = (label, set, key, n, cls = '') => h('button', { class: `chip ${cls} ${set.has(key) ? 'on' : ''}`, onclick: (e) => { set.has(key) ? set.delete(key) : set.add(key); e.currentTarget.classList.toggle('on', set.has(key)); view.shown = 15; paint(); } }, label, h('span', { class: 'badge' }, String(n)));
  const bySev = q.bySeverity ?? {}; const byType = all.reduce((m, f) => { m[f.type] = (m[f.type] ?? 0) + 1; return m; }, {});
  const bar = h('div', { class: 'segbar' }); for (const s of SEV) { const n = bySev[s] ?? 0; if (!n) continue; const seg = h('i', { class: `seg sev-${s}`, title: `${n} ${SEV_LABEL[s].toLowerCase()}` }); seg.style.flexGrow = String(n); bar.append(seg); }
  const groupSel = h('select', { 'aria-label': 'Group by', onchange: (e) => { view.group = e.target.value; paint(); } }, [['file', 'Group by file'], ['rule', 'Group by rule'], ['severity', 'Group by severity'], ['flat', 'No grouping']].map(([v, l]) => { const o = h('option', { value: v }, l); o.selected = view.group === v; return o; }));

  const row = (f) => { const r = ruleOf(f.rule);
    const fixB = h('button', { class: 'btn small', onclick: (e) => act(() => onFix({ key: f.key }), '')(e) }, icon('plus', 12), 'Queue fix');
    const ignB = h('button', { class: 'btn small ghost', title: 'Skip this whole file in future analysis', onclick: act(() => onIgnore({ patterns: [...(pr.ignored?.patterns ?? []), `/${f.file}`], useDefaults: pr.ignored?.useDefaults !== false }), 'File ignored. Re-analyzing…') }, 'Ignore file');
    const cpB = h('button', { class: 'btn small ghost', title: 'Copy file:line', onclick: () => copy(`${f.file}:${f.line}`, 'Location') }, icon('copy', 12));
    return h('article', { class: `finding sev-${f.severity}` },
      h('div', { class: 'f-head' }, sevPill(f.severity), h('b', { class: 'f-title' }, r.title), pill(TYPE_LABEL[f.type]?.replace(/s$/, '') ?? f.type, 'muted'), where(proj, f.file, f.line, 'loc')),
      f.message && f.message !== r.title ? h('p', { class: 'f-msg' }, f.message) : null,
      f.snippet ? h('pre', { class: 'code' }, h('span', { class: 'ln' }, String(f.line)), h('code', {}, f.snippet)) : null,
      h('div', { class: 'f-foot' }, r.why ? h('details', { class: 'why' }, h('summary', {}, 'Why it matters & how to fix'), h('p', {}, h('b', {}, 'Why: '), r.why), h('p', {}, h('b', {}, 'Fix: '), r.fix)) : h('span', {}), h('div', { class: 'row' }, cpB, ignB, fixB)));
  };
  const paint = () => {
    const ql = view.q.trim().toLowerCase();
    const rows = all.filter((f) => (!view.sev.size || view.sev.has(f.severity)) && (!view.type.size || view.type.has(f.type)) && (!ql || `${f.file} ${f.rule} ${ruleOf(f.rule).title} ${f.message} ${f.snippet}`.toLowerCase().includes(ql)));
    const shown = rows.slice(0, view.shown); const hidden = view.sev.size || view.type.size || ql;
    summary.textContent = `${rows.length}${hidden ? ` match${rows.length === 1 ? '' : 'es'}` : ''} of ${total} finding${total === 1 ? '' : 's'}${total > all.length ? ` (the ${all.length} most serious are listed)` : ''}`;
    if (!rows.length) { list.replaceChildren(h('div', { class: 'empty-s' }, icon('search', 22), h('b', {}, 'No findings match'), h('p', { class: 'muted small' }, 'Try clearing the filters or the search.'), h('button', { class: 'btn small', onclick: () => { view.sev.clear(); view.type.clear(); view.q = ''; search.value = ''; go('findings'); } }, 'Clear filters'))); return; }
    const groups = new Map(); const keyOf = { file: (f) => f.file, rule: (f) => ruleOf(f.rule).title, severity: (f) => SEV_LABEL[f.severity], flat: () => '' }[view.group];
    for (const f of shown) { const k = keyOf(f); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(f); }
    const out = [];
    for (const [k, fs] of groups) out.push(view.group === 'flat' ? h('div', { class: 'fgroup flat' }, fs.map(row)) : h('details', { class: 'fgroup', open: true }, h('summary', {}, h('b', {}, view.group === 'file' ? splitPath(k)[1] : k), view.group === 'file' ? h('span', { class: 'muted small mono' }, splitPath(k)[0]) : null, h('span', { class: 'badge' }, String(fs.length)), view.group === 'severity' ? null : sevPill(fs[0].severity)), fs.map(row)));
    if (rows.length > shown.length) out.push(h('button', { class: 'btn more', onclick: () => { view.shown += 15; paint(); } }, `Show ${Math.min(15, rows.length - shown.length)} more (${rows.length - shown.length} hidden)`));
    list.replaceChildren(...out);
  };
  paint();
  return [card('', h('div', { class: 'card-h' }, h('h2', {}, 'Findings'), summary), bar,
    h('div', { class: 'toolbar' }, search, groupSel), h('div', { class: 'chips' }, SEV.filter((s) => bySev[s]).map((s) => chip(SEV_LABEL[s], view.sev, s, bySev[s], `sev-${s}`)), h('span', { class: 'sep' }), Object.keys(TYPE_LABEL).filter((t) => byType[t]).map((t) => chip(TYPE_LABEL[t], view.type, t, byType[t]))), list)];
}

// ---------------------------------------------------------------- files
function files({ pr, proj, st, go, onFix }) {
  const all = st?.files ?? []; if (!all.length) return [card('', h('p', { class: 'muted' }, 'No source files to list.'))];
  const max = Math.max(...all.map((f) => f.lines)); const list = h('div', { class: 'ftable' }); const count = h('span', { class: 'muted small' });
  const search = h('input', { type: 'search', placeholder: 'Filter files…', value: view.fq, 'aria-label': 'Filter files', oninput: (e) => { view.fq = e.target.value; paint(); } });
  const sort = h('select', { 'aria-label': 'Sort files', onchange: (e) => { view.fsort = e.target.value; paint(); } }, [['lines', 'Largest first'], ['findings', 'Most findings'], ['untested', 'Untested first'], ['name', 'Name']].map(([v, l]) => { const o = h('option', { value: v }, l); o.selected = view.fsort === v; return o; }));
  const only = h('div', { class: 'chips' }, [['all', 'All'], ['untested', 'No test'], ['findings', 'Has findings'], ['large', 'Over 300 lines']].map(([k, l]) => h('button', { class: `chip ${view.fonly === k ? 'on' : ''}`, onclick: (e) => { view.fonly = k; only.querySelectorAll('.chip').forEach((c) => c.classList.remove('on')); e.currentTarget.classList.add('on'); paint(); } }, l)));
  const paint = () => {
    const ql = view.fq.trim().toLowerCase();
    let rows = all.filter((f) => (!ql || f.file.toLowerCase().includes(ql)) && ({ all: true, untested: f.tested === false, findings: f.findings > 0, large: f.lines > 300 }[view.fonly]));
    rows = rows.sort({ lines: (a, b) => b.lines - a.lines, findings: (a, b) => b.findings - a.findings || b.lines - a.lines, untested: (a, b) => (b.tested === false) - (a.tested === false) || b.lines - a.lines, name: (a, b) => a.file.localeCompare(b.file) }[view.fsort]);
    count.textContent = `${rows.length} of ${all.length} largest source files`;
    if (!rows.length) { list.replaceChildren(h('div', { class: 'empty-s' }, icon('search', 22), h('b', {}, 'No files match'))); return; }
    list.replaceChildren(...rows.map((f) => { const [dir, name] = splitPath(f.file);
      return h('div', { class: 'frow' },
        h('div', { class: 'fname' }, where(proj, f.file, 0, 'floc'), h('span', { class: 'muted small mono' }, dir || '(root)')),
        h('div', { class: 'fbar' }, meter(f.lines / max, f.lines > 300 ? 'warn' : ''), h('span', { class: 'mono small' }, `${num(f.lines)} lines`)),
        h('div', { class: 'fbadges' }, f.tested === true ? pill('tested', 'ok') : f.tested === false ? pill('no test', 'warn') : null, f.findings ? h('button', { class: 'pill2 bad link', title: 'Show these findings', onclick: () => go('findings', { q: f.file, sev: new Set(), type: new Set(), shown: 15 }) }, `${f.findings} finding${f.findings > 1 ? 's' : ''}`) : null),
        h('div', { class: 'row' }, f.tested === false ? h('button', { class: 'btn small', onclick: () => onFix({ key: `untested:${f.file}:1` }) }, 'Queue tests') : null, f.lines > 400 ? h('button', { class: 'btn small ghost', onclick: () => onFix({ key: `big:${f.file}` }) }, 'Queue split') : null));
    }));
  };
  paint();
  return [card('', h('div', { class: 'card-h' }, h('h2', {}, 'Files'), count), h('div', { class: 'toolbar' }, search, sort), only, list)];
}

// ---------------------------------------------------------------- repeated code
function repeats({ du, proj, onFix }) {
  if (!du?.blocks?.length) return [card('', h('p', { class: 'ok-note big' }, icon('check', 20), ' No repeated code found (6 or more identical lines in two places).'))];
  return [card('', h('div', { class: 'card-h' }, h('h2', {}, 'Repeated code'), pill(`${du.pct}% of the code is copied`, du.pct >= 10 ? 'bad' : 'warn')),
    h('p', { class: 'muted small' }, 'The same lines of code appear in two places. Fixing one copy and forgetting the other is a classic source of bugs. Move the shared code into one function.'),
    h('div', { class: 'dups' }, du.blocks.map((b) => h('article', { class: 'dup' }, h('div', { class: 'dup-h' }, pill(`${b.lines} identical lines`, 'warn'), h('button', { class: 'btn small', onclick: () => onFix({ key: b.key }) }, icon('plus', 12), 'Queue cleanup')),
      h('div', { class: 'dup-pair' }, h('div', {}, h('span', { class: 'tile-l' }, 'Original'), where(proj, b.a.file, b.a.start, 'loc'), h('span', { class: 'muted small mono' }, `lines ${b.a.start}–${b.a.end}`)), h('span', { class: 'eq' }, '='), h('div', {}, h('span', { class: 'tile-l' }, 'Copy'), where(proj, b.b.file, b.b.start, 'loc'), h('span', { class: 'muted small mono' }, `lines ${b.b.start}–${b.b.end}`)))))))];
}

// ---------------------------------------------------------------- tests
function tests({ st, proj, onFix }) {
  if (!st) return [card('', h('p', { class: 'muted' }, 'No source files to check.'))];
  const frac = st.sourceFiles ? st.testedFiles / st.sourceFiles : 1;
  return [card('', h('div', { class: 'card-h' }, h('h2', {}, 'Test coverage by file'), pill(`${st.testedFiles} of ${st.sourceFiles} files covered`, frac === 1 ? 'ok' : 'warn')), meter(frac, frac < 0.5 ? 'warn' : ''),
    h('p', { class: 'muted small' }, 'A source file counts as covered when a test has the same name or imports it. This is not line coverage, but files with no test at all are the riskiest for the agent to change.'),
    st.untested.length ? h('ul', { class: 'plain issues dup' }, st.untested.map((u) => h('li', {}, pill(`${u.lines} lines`), where(proj, u.file, 0, 'loc'), h('span', {}), h('button', { class: 'btn small', onclick: () => onFix({ key: u.key }) }, icon('plus', 12), 'Queue tests')))) : h('p', { class: 'ok-note' }, icon('check', 16), ' Every source file has a matching test.'))];
}

// ---------------------------------------------------------------- ignored
function ignored({ ig, onIgnore }) {
  const g = ig ?? { defaults: 0, yours: 0, folders: 0, examples: [], patterns: [], useDefaults: true };
  const box = h('textarea', { rows: 5, placeholder: 'one pattern per line, e.g.\n*.sql\ndocs/api/*.md\ngenerated/', spellcheck: 'false' }, (g.patterns ?? []).join('\n'));
  const dflt = h('input', { type: 'checkbox' }); dflt.checked = g.useDefaults !== false;
  return [card('', h('div', { class: 'card-h' }, h('h2', {}, 'Ignored from analysis'), h('span', { class: 'muted small mono' }, `${g.defaults} by built-in rules · ${g.yours} by yours${g.gitignored ? ` · ${g.gitignored} by .gitignore` : ''} · ${g.folders} folders`)),
    h('p', { class: 'muted small' }, 'Skipped completely: not counted, not scanned, not checked on the agent’s changes. Built-in rules cover lock files (package-lock.json, yarn.lock, …), minified, generated and snapshot files, build output (dist/, build/, coverage/) and images or fonts.'),
    g.examples?.length ? h('div', { class: 'chips ex' }, g.examples.map((x) => pill(`${x.path}${x.why === 'yours' ? ' · yours' : ''}`, 'muted mono'))) : null,
    h('label', {}, 'Your own patterns'), box, h('label', { class: 'check' }, dflt, ' Also skip the built-in list (recommended)'),
    h('p', { class: 'muted small' }, 'name.ext matches anywhere · dir/ matches a folder anywhere · a/b/c or /a is from the repository root · * ? ** wildcards. The repo can add its own under "analysis": { "ignore": [...] } in .agent-factory.json.'),
    h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', onclick: () => onIgnore({ patterns: box.value.split('\n').map((x) => x.trim()).filter(Boolean), useDefaults: dflt.checked }) }, 'Save and re-analyze')))];
}
