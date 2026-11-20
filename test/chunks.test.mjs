import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chunkPrints, tagsOf } from '../src/chunks.mjs';
import { candidates } from '../src/library.mjs';
import { codeMetrics } from '../src/analyze.mjs';

const body = (n, tail = '') => Array.from({ length: n }, (_, i) => `  const v${i} = input.items[${i}] ?? defaults.items[${i}]; total += v${i}.price * v${i}.qty;`).join('\n') + tail;
const names = (rel, text, ext) => chunkPrints(rel, text, ext).map((c) => `${c.type}:${c.name}`);

test('JavaScript/TypeScript: finds functions, arrow functions, classes with their methods, React components and hooks, and Express routes; ignores small ones, types and expression-bodied arrows', () => {
  const src = `import x from 'y';
export function priceOrder(input, defaults) {
  let total = 0;
${body(12)}
  return total;
}
export const fetchUser = async (id) => {
  const res = await fetch(\`/api/users/\${id}\`, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('bad');
${body(9)}
  return res.json();
};
export const short = (a) => a + 1;
export const expr = (a) => someCall(a, b, c);

export class Store extends Base implements Adapter {
  constructor(opts) { this.opts = opts; }
  load(key) {
    let total = 0;
${body(11).replace(/^/gm, '  ')}
    return total;
  }
  save(key, value) { return this.opts.write(key, value); }
}
export function useThing(id) {
  const [v, setV] = useState(null);
  useEffect(() => { setV(id); }, [id]);
${body(10)}
  return v;
}
app.post('/api/orders', async (req, res) => {
  const token = req.headers.authorization;
${body(10)}
  res.json({ ok: true });
});
type Big = {
${body(12)}
};
`;
  assert.deepEqual(names('a.ts', src, 'ts'), ['function:priceOrder', 'function:fetchUser', 'class:Store', 'method:Store.load', 'function:useThing', 'route:app.post /api/orders']);
  const by = Object.fromEntries(chunkPrints('a.ts', src, 'ts').map((c) => [c.name, c])); assert.deepEqual(by.fetchUser.tags, ['api-client', 'auth']); assert.ok(by.useThing.tags.includes('hook')); assert.ok(by.Store.tags.includes('adapter')); assert.deepEqual(by.Store.methods, ['load', 'save']); assert.ok(by['app.post /api/orders'].tags.includes('auth'));
  assert.equal(by.priceOrder.start, 2); assert.equal(by.priceOrder.kind, 'chunk'); assert.equal(by.priceOrder.sig.length, 24);
});

test('React components are tagged; braces inside parameter destructuring do not end the function early', () => {
  const tsx = `export function Card({ title, items }: { title: string; items: Item[] }) {
  const [open, setOpen] = useState(false);
${body(10)}
  return (
    <section onClick={() => setOpen(!open)}>
      <h2>{title}</h2>
    </section>
  );
}
export const useAuth = () => useContext(Ctx)
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState(null);
${body(10)}
  return <Ctx.Provider value={me}>{children}</Ctx.Provider>;
}
`;
  assert.deepEqual(chunkPrints('c.tsx', tsx, 'tsx').map((c) => [c.name, c.tags.includes('component'), c.lines >= 10]), [['Card', true, true], ['AuthProvider', true, true]]);
});

test('Python: functions, classes and methods by indentation; decorators and comments do not count as code', () => {
  const py = `import os

@router.get("/items")
def list_items(db, user):
    # a comment that says retry retry retry
${Array.from({ length: 11 }, (_, i) => `    row${i} = db.execute("SELECT * FROM items WHERE id = %s", (user.id + ${i},))`).join('\n')}
    return rows

class Repo(ABC):
    def __init__(self, db):
        self.db = db
${Array.from({ length: 3 }, (_, k) => `    def method${k}(self, a):\n${Array.from({ length: 10 }, (_, i) => `        x${i} = self.db.query(a + ${i})`).join('\n')}\n        return x0`).join('\n')}

def tiny():
    return 1
`;
  const got = chunkPrints('r.py', py, 'py'); assert.deepEqual(got.map((c) => `${c.type}:${c.name}`), ['function:list_items', 'class:Repo', 'method:Repo.method0', 'method:Repo.method1', 'method:Repo.method2']);
  assert.deepEqual(got[0].tags, ['database'], 'a comment mentioning retry does not make it a retry function'); assert.ok(got[1].tags.includes('adapter')); assert.deepEqual(got[1].methods, ['__init__', 'method0', 'method1', 'method2']);
});

test('the same function in different projects is grouped and ranked above trivial repeats; whole-file groups covered by a chunk group are dropped', () => {
  const fnA = `export async function callApi(path, token) {\n  const res = await fetch(BASE + path, { headers: { Authorization: 'Bearer ' + token } });\n${body(10)}\n  return res.json();\n}\n`; const fnB = fnA.replace('callApi', 'request').replace('BASE', 'API_URL').replace(/total/g, 'sum');
  const small = (n) => `export function helper${n}(a) {\n${body(10).replace(/v/g, 'w')}\n  return a;\n}\n`;
  const prints = { a: [...chunkPrints('api.js', fnA, 'js'), ...chunkPrints('h.js', small(1), 'js')], b: [...chunkPrints('client.js', fnB, 'js'), ...chunkPrints('h2.js', small(2), 'js')] };
  const found = candidates(prints); assert.ok(found.length >= 1); const top = found[0]; assert.equal(top.kind, 'chunk'); assert.deepEqual(top.projects.sort(), ['a', 'b']); assert.ok(top.tags.includes('api-client') && top.tags.includes('auth')); assert.ok(top.value > 10); assert.match(top.reason, /Found in 2 projects · api-client, auth/);
  assert.deepEqual(top.locations.map((l) => [l.project, l.file, l.name]).sort(), [['a', 'api.js', 'callApi'], ['b', 'client.js', 'request']]);
  const trivial = found.find((g) => g.name.startsWith('helper')); if (trivial) assert.ok(trivial.value < top.value, 'untagged code ranks below an API client');
  const whole = { file: 'api.js', lines: 14, exports: ['callApi'], sig: prints.a[0].sig }, whole2 = { file: 'client.js', lines: 14, exports: ['callApi'], sig: prints.a[0].sig };
  assert.equal(candidates({ a: [whole, ...prints.a], b: [whole2, ...prints.b] }).filter((g) => g.kind === 'file').length, 0, 'the file-level duplicate of an already reported chunk is not listed twice');
});

test('adapter detection: classes in different projects with the same methods but different code are reported as a pattern', () => {
  const cls = (name, impl) => `export class ${name} {\n  constructor(o) { this.o = o; }\n  async list(a) {\n${impl(1)}\n    return a;\n  }\n  async get(a) {\n${impl(2)}\n    return a;\n  }\n  async create(a) {\n${impl(3)}\n    return a;\n  }\n  async remove(a) {\n${impl(4)}\n    return a;\n  }\n  async comment(a, t) {\n${impl(5)}\n    return a;\n  }\n}\n`;
  const implA = (n) => Array.from({ length: 10 }, (_, i) => `    const r${i} = await this.http.get('/issues/' + a + ${n * i});`).join('\n'), implB = (n) => Array.from({ length: 10 }, (_, i) => `    if (a.kind === ${n}) { await this.db.rows[${i}].update({ m: ${i * n} }); } else { throw new Error('x${i}'); }`).join('\n');
  const prints = { jira: chunkPrints('jira.js', cls('JiraTickets', implA), 'js'), linear: chunkPrints('linear.js', cls('LinearTickets', implB), 'js'), other: chunkPrints('o.js', cls('Cache', implA).replace(/\b(list|get|create|remove|comment)\(/g, (m) => 'x' + m), 'js') };
  const g = candidates(prints).filter((x) => x.kind === 'pattern'); assert.equal(g.length >= 1, true); assert.deepEqual(g[0].projects.sort(), ['jira', 'linear']); assert.match(g[0].reason, /Same interface, different code: .*list/); assert.deepEqual(g[0].tags, ['adapter']);
});

test('analysis returns chunks (not templates by default), skips test files, and caps them', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-')); fs.mkdirSync(path.join(d, 'src'), { recursive: true }); fs.mkdirSync(path.join(d, 'test'), { recursive: true });
  fs.writeFileSync(path.join(d, 'src/pricing.js'), `export function priceOrder(input, defaults) {\n  let total = 0;\n${body(12)}\n  return total;\n}\n`); fs.writeFileSync(path.join(d, 'test/pricing.test.js'), `export function testHelper(input, defaults) {\n  let total = 0;\n${body(12)}\n  return total;\n}\n`); fs.writeFileSync(path.join(d, 'Dockerfile'), 'FROM node:22\n'.repeat(8));
  const m = codeMetrics(d); assert.deepEqual(m._chunks.map((c) => c.name), ['priceOrder']); assert.equal(m._prints.filter((p) => p.kind === 'boilerplate').length, 0);
  for (let i = 0; i < 700; i++) fs.writeFileSync(path.join(d, `src/f${i}.js`), `export function fn${i}(input, defaults) {\n  let total = 0;\n${body(11)}\n  return total;\n}\n`); assert.ok(codeMetrics(d)._chunks.length <= 500);
});

test('tags describe what the code does, from code and not from comments', () => {
  assert.deepEqual(tagsOf('const r = await fetch(url, { headers: { Authorization: t } });', { ext: 'js' }), ['api-client', 'auth']);
  assert.deepEqual(tagsOf('// we retry here\n// and cache things\nconst x = 1;', { ext: 'js' }), []); assert.ok(tagsOf('for (let attempt = 0; attempt < 3; attempt++) { await sleep(2 ** attempt) }', { ext: 'js' }).includes('retry')); assert.ok(tagsOf('const es = new EventSource(u)', { ext: 'js' }).includes('streaming'));
});
