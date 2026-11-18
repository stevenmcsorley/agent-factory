import test from 'node:test';
for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' })) process.env[k] ??= v;
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { tick } from '../src/factory.mjs';
import { gitVcs } from '../src/adapters/vcs.mjs';
import { callOp } from '../src/ops.mjs';
import * as lb from '../src/library.mjs';

const tmp = (p = 'le-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' }).toString();
const MONEY = `export function formatMoney(amount, currency = 'USD') {
  const n = Number(amount);
  if (!Number.isFinite(n)) throw new Error('amount must be a number');
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n).toFixed(2);
  const [whole, cents] = abs.split('.');
  const grouped = whole.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
  const symbol = { USD: '$', EUR: '€', GBP: '£' }[currency] ?? '';
  return sign + symbol + grouped + '.' + cents;
}
export const parseMoney = (text) => Number(String(text).replace(/[^0-9.-]/g, ''));
`;
const MONEY_TEST = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { formatMoney } from '../src/money.js';\ntest('formats', () => assert.equal(formatMoney(1234.5), '$1,234.50'));\n`;
const OTHER = Array.from({ length: 20 }, (_, i) => `export const unrelated${i} = (x) => x * ${i} + ${i * 7} - Math.sqrt(${i + 3});`).join('\n') + '\n';

// A bare "remote" with some files on main.
function remoteWith(files, root) {
  const bare = path.join(root, `r-${Math.random().toString(36).slice(2, 8)}.git`); execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const seed = tmp('seed-'); execFileSync('git', ['init', '-q', '-b', 'main', seed]); for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(seed, f)), { recursive: true }); fs.writeFileSync(path.join(seed, f), c); }
  git(seed, 'add', '-A'); git(seed, 'commit', '-qm', 'i'); git(seed, 'push', '-q', bare, 'main'); return bare;
}
function world() {
  const root = tmp('lw-'); const remotes = { shop: remoteWith({ 'package.json': '{"scripts":{"test":"node --test"}}', 'src/money.js': MONEY, 'test/money.test.js': MONEY_TEST, 'src/other.js': OTHER }, root), blog: remoteWith({ 'package.json': '{}', 'lib/price.js': MONEY.replace('USD', 'EUR').replaceAll('formatMoney', 'fmtPrice').replaceAll('amount', 'value'), 'lib/x.js': OTHER.replaceAll('unrelated', 'zzz').replaceAll('Math.sqrt', 'Math.cbrt') }, root), app: remoteWith({ 'README.md': '# app\n' }, root) };
  const sandbox = { kind: 'local', create: async ({ cloneUrl, branch, base, newBranch = true }) => { const dir = fs.mkdtempSync(path.join(root, 'ws-')); execFileSync('git', ['clone', '-q', '--branch', base, cloneUrl, dir]); if (newBranch) execFileSync('git', ['checkout', '-qb', branch], { cwd: dir }); return { dir, cloneUrl, destroy() {} }; }, exec: async () => ({ code: 0, out: '' }) };
  const prs = []; const tickets = {}; const store = (id) => (tickets[id] ??= []);
  const mkTk = (id) => ({ create: async ({ title, body }) => { const n = store(id).length + 1; store(id).push({ id: n, title, body, state: 'OPEN', labels: ['agent-ready'], url: `https://x/${id}/${n}` }); return { url: `https://x/${id}/${n}` }; }, listAgentTickets: async () => store(id).map(({ body, ...t }) => t), poll: async () => [] });
  const e = new Engine(withDefaults({ stateDir: path.join(root, 's'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [] }), { configPath: path.join(root, 'c.json'), env: {}, factories: { sandbox, tickets: (p) => mkTk(p.id), vcs: gitVcs({ openPr: (a) => { prs.push(a); return 'https://x/pr/1'; } }), hostAdapter: (p) => ({ cloneUrl: () => remotes[p.id], gitEnv: () => ({}), prUrl: () => '', openPr: async () => '' }) } });
  e.gh = { whoami: async () => 'me', inspectRepo: async () => ({ defaultBranch: 'main' }), ensureLabels: async () => {} };
  return { e, root, remotes, prs, tickets, store };
}
const settle = async (e, id) => { for (let i = 0; i < 300 && e.analysisJob(id).state === 'running'; i++) await new Promise((r) => setTimeout(r, 10)); return e.analysisJob(id); };
const lsTree = (bare, ref) => execFileSync('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', ref]).toString().split('\n').filter(Boolean);

test('library: connect seeds an empty repo (structure + CI), bad remotes are refused, status is honest, disconnect leaves the repo alone', async () => {
  const w = world(); assert.deepEqual(await w.e.libraryStatus(), { configured: false }); await assert.rejects(w.e.libraryPull(), /no reuse library yet/); await assert.rejects(w.e.librarySearch('x'), /no reuse library yet/);
  for (const bad of [{ remote: 'file:///etc/passwd' }, { remote: 'https://x.test/a b' }, { remote: 'https://x.test/a;rm' }, {}, { repo: 'nope' }]) await assert.rejects(w.e.libraryConnect(bad), /remote|owner\/name|Give a repository/);
  const bare = path.join(w.root, 'lib.git'); execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const st = await w.e.libraryConnect({ remote: bare }); assert.equal(st.configured, true); assert.equal(st.parts, 0); assert.ok(st.pulledAt);
  const files = lsTree(bare, 'main'); for (const f of ['README.md', '.github/workflows/parts.yml', 'scripts/check-parts.mjs', 'parts/.gitkeep']) assert.ok(files.includes(f), f);
  assert.match(fs.readFileSync(path.join(w.e.cfg.stateDir, '..', 'c.json'), 'utf8'), /"library"/); assert.deepEqual(w.e.libraryDisconnect(), { configured: false }); assert.deepEqual(await w.e.libraryStatus(), { configured: false }); assert.ok(lsTree(bare, 'main').length);
  const unreachable = world(); await assert.rejects(unreachable.e.libraryConnect({ remote: '/definitely/not/a/repo.git' }), /Could not reach that library/); assert.equal(unreachable.e.cfg.library, undefined);
});

test('library: promote makes a part (with its matching test) straight into the library; a second promote updates and bumps the version; PR mode pushes a branch and leaves main alone', async () => {
  const w = world(); await w.e.addProject({ repo: 'o/shop', id: 'shop' }); const bare = path.join(w.root, 'lib.git'); execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]); await w.e.libraryConnect({ remote: bare });
  await assert.rejects(w.e.promotePart({ project: 'shop', files: ['../../etc/passwd'], name: 'X' }), /Not allowed/); await assert.rejects(w.e.promotePart({ project: 'shop', files: ['nope.js'], name: 'X' }), /No such file/); await assert.rejects(w.e.promotePart({ project: 'shop', files: [], name: 'X' }), /between 1 and 12/);
  const r = await w.e.promotePart({ project: 'shop', files: ['src/money.js'], name: 'Money Format', summary: 'Format and parse money amounts', tags: ['currency'], direct: true });
  assert.equal(r.direct, true); assert.equal(r.part.slug, 'money-format'); assert.equal(r.part.version, '0.1.0'); assert.deepEqual(r.part.exports.map((x) => x.name), ['formatMoney', 'parseMoney']); assert.equal(r.part.origin.project, 'shop');
  assert.deepEqual(lsTree(bare, 'main').filter((f) => f.startsWith('parts/money-format/')).sort(), ['parts/money-format/README.md', 'parts/money-format/part.json', 'parts/money-format/src/money.js', 'parts/money-format/test/money.test.js']);
  const cat = await w.e.libraryList(); assert.equal(cat.length, 1); assert.equal(cat[0].tested, true); assert.equal(cat[0].prints, undefined);
  const again = await w.e.promotePart({ project: 'shop', files: ['src/money.js'], name: 'Money Format', direct: true, note: 'second' }); assert.equal(again.changed, false, 'identical content: nothing to do');
  const pr = await w.e.promotePart({ project: 'shop', files: ['src/money.js', 'src/other.js'], name: 'Money Format', summary: 'now with extras', note: 'Added extras' }); assert.equal(pr.part.version, '0.2.0'); assert.match(pr.branch, /^part\/money-format-0\.2\.0-/); assert.equal(pr.pr, null, 'no GitHub repo configured: branch only');
  assert.ok(lsTree(bare, pr.branch).includes('parts/money-format/src/other.js')); assert.ok(!lsTree(bare, 'main').includes('parts/money-format/src/other.js'), 'main is untouched until the PR is merged');
  const got = w.e.libraryPart('money-format'); assert.equal(got.files.find((f) => f.path === 'src/money.js').content, MONEY); assert.equal(got.version, '0.1.0'); assert.throws(() => w.e.libraryPart('../x'), /No such part/);
});

test('library: repeated code across projects is found as a candidate (renamed copies too), unrelated code is not, and a promoted part is recognised as already in the library', async () => {
  const w = world(); await w.e.addProject({ repo: 'o/shop', id: 'shop' }); await w.e.addProject({ repo: 'o/blog', id: 'blog' });
  for (const id of ['shop', 'blog']) { w.e.startAnalysis(id); assert.equal((await settle(w.e, id)).state, 'done'); }
  const bare = path.join(w.root, 'lib.git'); execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]); await w.e.libraryConnect({ remote: bare });
  const cs = w.e.libraryCandidates(); const money = cs.find((c) => c.locations.some((l) => l.file === 'src/money.js')); assert.ok(money, JSON.stringify(cs)); assert.deepEqual(money.projects.sort(), ['blog', 'shop']); assert.equal(money.inLibrary, null);
  assert.ok(cs.every((c) => !c.locations.some((l) => /other\.js|x\.js/.test(l.file) && c.locations.some((m) => /money|price/.test(m.file)))), 'unrelated files are not grouped with the money code');
  await w.e.promotePart({ project: 'shop', files: ['src/money.js'], name: 'Money Format', summary: 'Format money', direct: true }); assert.equal(w.e.libraryCandidates().find((c) => c.locations.some((l) => l.file === 'src/money.js')).inLibrary, 'money-format');
});

test('using parts: the agent is told what exists and given the files (with a provenance header), reuse is recorded in the PR and a lock file, and a rewrite is flagged', async () => {
  const w = world(); await w.e.addProject({ repo: 'o/shop', id: 'shop' }); await w.e.addProject({ repo: 'o/app', id: 'app' }); const bare = path.join(w.root, 'lib.git'); execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]); await w.e.libraryConnect({ remote: bare });
  await w.e.promotePart({ project: 'shop', files: ['src/money.js'], name: 'Money Format', summary: 'Format and parse money amounts', tags: ['currency', 'money'], direct: true });
  const app = w.e.cfg.projects.find((p) => p.id === 'app'); const cfgFor = () => w.e.deps(app);
  // 1. a matching ticket: context + files
  const d = cfgFor(); let prompt = '', header = '', hasFile = false;
  d.agent = { run: async (_sb, ws, p) => { prompt = p; const f = path.join(ws.dir, '.factory-context/library/money-format/src/money.js'); hasFile = fs.existsSync(f); header = hasFile ? fs.readFileSync(f, 'utf8').split('\n')[0] : ''; fs.mkdirSync(path.join(ws.dir, 'src'), { recursive: true }); fs.writeFileSync(path.join(ws.dir, 'src/money.js'), fs.readFileSync(f, 'utf8')); fs.writeFileSync(path.join(ws.dir, 'src/cart.js'), "import { formatMoney } from './money.js';\nexport const total = (items) => formatMoney(items.reduce((s, i) => s + i.price, 0));\n"); return { out: 'done', costUsd: 0 }; } };
  d.tickets = { listWorking: async () => [], poll: async () => [{ id: 5, title: 'Show the cart total formatted as money', body: 'Add src/cart.js with total(items) that formats currency amounts as money for the checkout page', labels: ['agent-ready'] }], comment: async () => {}, label: async () => {} }; d.config.verify = false; const prs = []; d.vcs = gitVcs({ openPr: (a) => { prs.push(a); return 'https://x/pr/9'; } });
  const [rec] = await tick(d); assert.equal(rec.status, 'ok'); assert.match(prompt, /Reusable parts you already have[\s\S]*money-format@0\.1\.0 \[util[\s\S]*formatMoney\(amount, currency = 'USD'\)/); assert.ok(hasFile); assert.match(header, /^\/\/ factory-part: money-format@0\.1\.0/);
  assert.deepEqual(rec.parts, [{ slug: 'money-format', version: '0.1.0' }]); assert.match(prs[0].body, /### Reused library parts\n- money-format@0\.1\.0/); assert.equal(rec.quality.status, 'OK');
  const branch = rec.pr ? 'agent/5-show-the-cart-total-formatted-as-money' : ''; const lock = JSON.parse(execFileSync('git', ['--git-dir', w.remotes.app, 'show', `${branch}:.factory/parts.lock.json`]).toString()); assert.equal(lock.parts['money-format'].version, '0.1.0'); assert.deepEqual(lock.parts['money-format'].files, ['src/money.js']);
  assert.deepEqual(w.e._usage().entries.map((u) => [u.slug, u.version, u.project, u.ticket]), [['money-format', '0.1.0', 'app', 5]]); assert.ok(!lsTree(w.remotes.app, branch).some((f) => f.includes('factory-context')));
  // 2. an unrelated ticket gets no library section
  let prompt2 = ''; const d2 = cfgFor(); d2.agent = { run: async (_sb, ws, p) => { prompt2 = p; fs.writeFileSync(path.join(ws.dir, 'readme2.md'), 'x'); return { out: 'ok', costUsd: 0 }; } }; d2.tickets = { listWorking: async () => [], poll: async () => [{ id: 6, title: 'Write a contributing guide', body: 'Add CONTRIBUTING.md with how to run the tests', labels: ['agent-ready'] }], comment: async () => {}, label: async () => {} }; d2.config.verify = false; d2.vcs = gitVcs({ openPr: () => 'u' }); await tick(d2); assert.doesNotMatch(prompt2, /Reusable parts/);
  // 3. the agent rewrites the part instead of using it: flagged, and told to use the part on the retry
  const prompts = []; const d3 = cfgFor(); d3.agent = { run: async (_sb, ws, p) => { prompts.push(p); fs.mkdirSync(path.join(ws.dir, 'src'), { recursive: true }); fs.writeFileSync(path.join(ws.dir, 'src/price.js'), MONEY.replaceAll('formatMoney', 'fmtPrice').replaceAll('amount', 'value').replaceAll('grouped', 'withCommas')); return { out: 'done', costUsd: 0 }; } };
  d3.tickets = { listWorking: async () => [], poll: async () => [{ id: 7, title: 'Add a price formatter', body: 'Add src/price.js with fmtPrice(value) that formats money amounts with a currency symbol', labels: ['agent-ready'] }], comment: async () => {}, label: async () => {} }; d3.config.verify = false; d3.vcs = gitVcs({ openPr: () => 'u' });
  const [r3] = await tick(d3); assert.equal(r3.attempts, 2); assert.match(prompts[1], /quality gate on your change failed[\s\S]*reinvented-part[\s\S]*money-format@0\.1\.0/); assert.equal(r3.quality.status, 'WARN'); assert.ok(r3.quality.findings.some((f) => f.rule === 'reinvented-part' && f.file === 'src/price.js')); assert.equal(r3.status, 'ok', 'flagged, not blocked');
});

test('upgrades: bumping a part finds the projects on the old version, opens one ticket each (never twice), and "use this part" is just a ticket', async () => {
  const w = world(); await w.e.addProject({ repo: 'o/shop', id: 'shop' }); await w.e.addProject({ repo: 'o/app', id: 'app' }); const bare = path.join(w.root, 'lib.git'); execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]); await w.e.libraryConnect({ remote: bare });
  await w.e.promotePart({ project: 'shop', files: ['src/money.js'], name: 'Money Format', summary: 'Format money', direct: true });
  const u = w.e._usage(); u.entries.push({ slug: 'money-format', version: '0.1.0', project: 'app', ticket: 1, file: 'src/money.js', at: new Date().toISOString() }); w.e._saveUsage(u); assert.deepEqual(w.e.libraryUpgrades(), []);
  await w.e.promotePart({ project: 'shop', files: ['src/money.js', 'src/other.js'], name: 'Money Format', direct: true, note: 'Added helpers' });
  assert.deepEqual(w.e.libraryUpgrades(), [{ slug: 'money-format', project: 'app', from: '0.1.0', to: '0.2.0', ticketed: false, deprecated: false, replacedBy: null }]);
  const r = await w.e.upgradeUsers('money-format'); assert.equal(r.upgraded.length, 1); assert.match(w.store('app')[0].title, /Upgrade library part money-format from 0\.1\.0 to 0\.2\.0/); assert.match(w.store('app')[0].body, /0\.2\.0: Added helpers/); assert.equal((await w.e.upgradeUsers('money-format')).upgraded.length, 0); assert.equal(w.e.libraryUpgrades()[0].ticketed, true);
  await w.e.usePart({ part: 'money-format', project: 'app', note: 'for the cart' }); assert.match(w.store('app')[1].title, /Use the money-format library part: for the cart/); assert.match(w.store('app')[1].body, /\.factory-context\/library\/money-format\//); await assert.rejects(w.e.usePart({ part: 'nope', project: 'app' }), /No such part/);
});

test('library create: makes a private GitHub repo (faked), seeds it and connects; a second create is refused; names are validated', async () => {
  const w = world(); const calls = []; w.e.f.gh = async (args) => { calls.push(args.join(' ')); return { code: 0, out: '' }; };
  w.e.f.libraryRemote = (repo) => { const bare = path.join(w.root, `${repo.replace('/', '_')}.git`); execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]); return bare; };
  await assert.rejects(w.e.libraryInit({ name: 'bad name!' }), /Repository name/); const st = await w.e.libraryInit({ name: 'my-parts' });
  assert.equal(st.configured, true); assert.equal(st.repo, 'me/my-parts'); assert.match(calls[0], /^repo create me\/my-parts --private/); assert.ok(lsTree(w.e.cfg.library.remote, 'main').includes('scripts/check-parts.mjs')); await assert.rejects(w.e.libraryInit({}), /already connected/);
});

test('library operations are exposed to MCP/CLI and validated', async () => {
  const w = world(); await w.e.addProject({ repo: 'o/shop', id: 'shop' }); const bare = path.join(w.root, 'lib.git'); execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  assert.equal((await callOp(w.e, 'library_status', {})).configured, false); assert.equal((await callOp(w.e, 'library_setup', { action: 'connect', remote: bare })).configured, true); await assert.rejects(callOp(w.e, 'library_setup', { action: 'explode' }), /one of/);
  const r = await callOp(w.e, 'promote_part', { project: 'shop', files: ['src/money.js'], name: 'Money Format', summary: 'Format money amounts', tags: ['currency'], direct: true }); assert.equal(r.part.slug, 'money-format');
  const found = await callOp(w.e, 'library_search', { query: 'format currency money', project: 'shop' }); assert.equal(found[0].slug, 'money-format'); assert.ok(found[0].why.length); assert.equal((await callOp(w.e, 'library_search', { query: 'quantum physics engine' })).length, 0);
  assert.equal((await callOp(w.e, 'library_get', { part: 'money-format' })).files[0].content, MONEY); assert.ok(Array.isArray(await callOp(w.e, 'library_candidates', {}))); assert.deepEqual(await callOp(w.e, 'library_upgrades', {}), []); assert.equal((await callOp(w.e, 'use_part', { part: 'money-format', project: 'shop' })).url.startsWith('https://x/shop/'), true);
});
