import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as lib from '../src/library.mjs';
import { analyzeRepo } from '../src/analyze.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lib-'));
const FORMAT = `export function formatMoney(amount, currency = 'USD') {
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
const renamed = FORMAT.replaceAll('formatMoney', 'fmtPrice').replaceAll('amount', 'value').replaceAll('grouped', 'withCommas');
const OTHER = Array.from({ length: 20 }, (_, i) => `export const unrelated${i} = (x) => x * ${i} + ${i * 7} - Math.sqrt(${i + 3});`).join('\n');

test('fingerprints: identical and lightly edited files are very similar, unrelated files are not, tiny files say nothing', () => {
  const a = lib.minhash(FORMAT), b = lib.minhash(FORMAT + '// a comment\n\n'), c = lib.minhash(renamed), d = lib.minhash(OTHER);
  assert.equal(a.length, 24); assert.equal(lib.similarity(a, b), 1); assert.ok(lib.similarity(a, c) >= 0.9, 'renamed copy still matches'); assert.ok(lib.similarity(a, d) < 0.15); assert.deepEqual(lib.minhash('x = 1'), []); assert.equal(lib.similarity([], []), 0);
});

test('exports are read from JS, TS, Python and Go with signatures; parts are classified', () => {
  const e = lib.exportsOf(FORMAT, 'js'); assert.deepEqual(e.map((x) => x.name), ['formatMoney', 'parseMoney']); assert.equal(e[0].signature, "formatMoney(amount, currency = 'USD')");
  assert.deepEqual(lib.exportsOf('export default function Button({ label, onClick }) {}\nexport const useToggle = (initial) => {}\nexport class Store {}\nexport type Id = string', 'tsx').map((x) => [x.name, x.kind]), [['Button', 'function'], ['useToggle', 'function'], ['Store', 'class'], ['Id', 'type']]);
  assert.deepEqual(lib.exportsOf('def slugify(text, sep="-"):\n  pass\ndef _private(): pass\nclass Cache:\n  pass', 'py').map((x) => x.name), ['slugify', 'Cache']); assert.deepEqual(lib.exportsOf('func Parse(s string) int {}\nfunc helper() {}', 'go').map((x) => x.name), ['Parse']);
  assert.equal(lib.classify(['Button.tsx'], [{ name: 'Button', kind: 'function' }]), 'component'); assert.equal(lib.classify(['x.js'], [{ name: 'useToggle', kind: 'function' }]), 'hook'); assert.equal(lib.classify(['a.css'], []), 'style'); assert.equal(lib.classify(['api-client.js'], []), 'service'); assert.equal(lib.classify(['money.js'], [{ name: 'formatMoney', kind: 'function' }]), 'util');
});

test('buildPart makes a part folder: validated metadata, src/test split, README, collision-safe paths; update bumps the minor version', () => {
  const { meta, files } = lib.buildPart({ name: 'Money Format', summary: 'Format and parse money', tags: ['Money', 'money', 'currency'], files: [{ rel: 'src/money.js', content: FORMAT }, { rel: 'lib/money.js', content: renamed }, { rel: 'test/money.test.js', content: 'import test from "node:test";\n' }], origin: { project: 'shop', repo: 'me/shop', base: 'main', files: ['src/money.js'] } });
  assert.equal(meta.slug, 'money-format'); assert.equal(meta.version, '0.1.0'); assert.deepEqual(meta.tags, ['money', 'currency']); assert.deepEqual(meta.stack, ['JavaScript']); assert.deepEqual(meta.files.map((f) => [f.path, f.role]), [['src/money.js', 'source'], ['src/2-money.js', 'source'], ['test/money.test.js', 'test']]);
  assert.deepEqual([...files.keys()].sort(), ['parts/money-format/README.md', 'parts/money-format/part.json', 'parts/money-format/src/2-money.js', 'parts/money-format/src/money.js', 'parts/money-format/test/money.test.js']); assert.match(files.get('parts/money-format/README.md'), /formatMoney\(amount, currency = 'USD'\)/);
  const up = lib.buildPart({ name: 'Money Format', files: [{ rel: 'src/money.js', content: FORMAT }], existing: meta, note: 'Added parseMoney' }); assert.equal(up.meta.version, '0.2.0'); assert.equal(up.meta.changelog.length, 2); assert.equal(up.meta.createdAt, meta.createdAt);
  assert.throws(() => lib.buildPart({ name: 'x', files: [] }), /at least one file/); assert.throws(() => lib.buildPart({ name: 'x', files: [{ rel: 'a.test.js', content: 'x' }] }), /source file/); assert.throws(() => lib.buildPart({ name: '!!!', files: [{ rel: 'a.js', content: 'x' }] }), /needs a name/);
  assert.equal(lib.bump('1.2.3', 'major'), '2.0.0'); assert.ok(lib.cmpVersion('1.10.0', '1.9.0') > 0);
});

function library(...parts) { const dir = tmp(); for (const p of parts) for (const [rel, content] of lib.buildPart(p).files) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), content); } return dir; }

test('catalog: reads parts, survives junk, never escapes the part folder; search explains itself and respects your stack and deprecation', () => {
  const dir = library({ name: 'Money Format', summary: 'Format and parse money amounts', tags: ['currency'], files: [{ rel: 'money.js', content: FORMAT }, { rel: 'money.test.js', content: 'x' }] }, { name: 'Date Helpers', summary: 'Parse and format dates', files: [{ rel: 'dates.py', content: Array.from({ length: 12 }, (_, i) => `def f${i}(x):\n  return x + ${i}`).join('\n') }] });
  fs.mkdirSync(path.join(dir, 'parts/broken')); fs.writeFileSync(path.join(dir, 'parts/broken/part.json'), '{nope'); fs.mkdirSync(path.join(dir, 'parts/evil')); fs.writeFileSync(path.join(dir, 'parts/evil/part.json'), JSON.stringify({ name: 'Evil', files: [{ path: '../../../etc/passwd', role: 'source' }] }));
  const cat = lib.readCatalog(dir); assert.deepEqual(cat.map((p) => p.slug), ['date-helpers', 'evil', 'money-format']); assert.equal(cat.find((p) => p.slug === 'money-format').tested, true); assert.equal(cat.find((p) => p.slug === 'evil').prints.length, 0);
  assert.throws(() => lib.readPart(dir, '../../etc'), /No such part/); assert.equal(lib.readPart(dir, 'money-format').files[0].content, FORMAT);
  const r = lib.searchCatalog(cat, 'format currency amounts as money'); assert.equal(r[0].part.slug, 'money-format'); assert.ok(r[0].why.some((w) => /currency/.test(w))); assert.deepEqual(lib.searchCatalog(cat, 'the and for'), []); assert.deepEqual(lib.searchCatalog(cat, 'quantum entanglement'), []);
  assert.equal(lib.searchCatalog(cat, 'parse dates', { stack: ['JavaScript'] }).length, 0, 'wrong stack is penalised below the threshold'); assert.equal(lib.searchCatalog(cat, 'parse dates', { stack: ['Python'] })[0].part.slug, 'date-helpers');
  cat.find((p) => p.slug === 'money-format').deprecated = true; assert.deepEqual(lib.searchCatalog(cat, 'format currency amounts as money'), []);
  assert.equal(lib.publicPart(cat[0]).prints, undefined);
});

test('usage: provenance header or an exact copy counts as using a part; a renamed copy without the header is flagged as reinvented; the lock merges', () => {
  const dir = library({ name: 'Money Format', files: [{ rel: 'money.js', content: FORMAT }] }); const cat = lib.readCatalog(dir); const meta = cat[0];
  const used = lib.detectUsage([{ rel: 'src/a.js', content: lib.provenanceHeader(meta, 'js') + FORMAT.replace('USD', 'GBP') }, { rel: 'src/b.js', content: FORMAT }, { rel: 'src/c.js', content: OTHER }], cat);
  assert.deepEqual(used.map((u) => [u.slug, u.version, u.file, u.via]), [['money-format', '0.1.0', 'src/a.js', 'header'], ['money-format', '0.1.0', 'src/b.js', 'copy']]);
  assert.match(lib.provenanceHeader(meta, 'py'), /^# factory-part: money-format@0\.1\.0/); assert.match(lib.provenanceHeader(meta, 'css'), /^\/\*/);
  const re = lib.reinvented([{ rel: 'src/mine.js', content: renamed + '\nexport const extra = 1;\n' }, { rel: 'src/ok.js', content: lib.provenanceHeader(meta, 'js') + FORMAT }, { rel: 'src/other.js', content: OTHER }], cat, { threshold: 0.2 }); assert.deepEqual(re.map((x) => [x.file, x.slug]), [['src/mine.js', 'money-format']]);
  const lock = lib.updateLock({ library: 'me/lib', parts: { old: { version: '1.0.0', files: ['x.js'] } } }, used); assert.deepEqual(Object.keys(lock.parts).sort(), ['money-format', 'old']); assert.deepEqual(lock.parts['money-format'].files.sort(), ['src/a.js', 'src/b.js']); assert.equal(lock.library, 'me/lib');
});

test('candidates: the same code across projects (even renamed) forms one candidate; unrelated code does not; analysis records the fingerprints', () => {
  const fp = (file, text) => ({ file, lines: text.split('\n').length, exports: lib.exportsOf(text, 'js').map((e) => e.name), sig: lib.minhash(text) });
  const cs = lib.candidates({ shop: [fp('src/money.js', FORMAT), fp('src/other.js', OTHER)], blog: [fp('lib/price.js', FORMAT.replace('USD', 'EUR')), fp('lib/x.js', OTHER.replaceAll('unrelated', 'zzz').replaceAll('Math.sqrt', 'Math.cbrt'))], admin: [fp('util/fmt.js', renamed)] });
  const money = cs.find((c) => c.locations.some((l) => l.file === 'src/money.js')); assert.ok(money); assert.deepEqual(money.projects.sort(), ['admin', 'blog', 'shop']); assert.equal(money.locations.length, 3); assert.ok(['formatMoney', 'parseMoney'].includes(money.name)); assert.ok(!money.locations.some((l) => /other|x\.js/.test(l.file)));
  assert.deepEqual(lib.candidates({ a: [fp('a.js', FORMAT)], b: [fp('b.js', OTHER)] }), []);
  const dir = tmp(); fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src/money.js'), FORMAT); fs.writeFileSync(path.join(dir, 'src/tiny.js'), 'export const a = 1;\n'); fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  const p = analyzeRepo(dir); assert.deepEqual(p.fingerprints.map((f) => f.file), ['src/money.js']); assert.deepEqual(p.fingerprints[0].exports, ['formatMoney', 'parseMoney']); assert.equal(p.fingerprints[0].sig.length, 24);
});
