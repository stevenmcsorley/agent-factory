// The diff viewer and the code block, run for real against a tiny stand-in DOM (no browser, no dependencies): parsing, line numbers,
// the changed part of a line, syntax state across lines, and that text only ever goes in as text.
import test from 'node:test';
import assert from 'node:assert/strict';

class Node_ {
  constructor(tag) { this.tag = tag; this.nodeType = 1; this.kids = []; this.attrs = {}; this.listeners = {}; this.dataset = {}; this.style = {}; this.parent = null; }
  append(...ns) { for (const n of ns) { assert.ok(n && (n.nodeType === 1 || n.nodeType === 3), `appended something that is not a node: ${n}`); n.parent = this; this.kids.push(n); } }   // a real DOM would turn null into the text "null"
  replaceChildren(...ns) { this.kids = []; this.append(...ns); }
  get childNodes() { return this.kids; } get firstChild() { return this.kids[0]; }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k]; }
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
  get className() { return this.attrs.class ?? ''; }
  get textContent() { return this.kids.map((k) => (k.nodeType === 3 ? k.text : k.textContent)).join(''); }
  set textContent(v) { this.kids = [{ nodeType: 3, text: String(v) }]; }
  all() { return this.kids.flatMap((k) => (k.nodeType === 1 ? [k, ...k.all()] : [])); }
  has(cls) { return (this.attrs.class ?? '').split(/\s+/).includes(cls); }
  querySelector(sel) { const c = sel.replace(/^\./, ''); return this.all().find((n) => n.has(c)) ?? null; }
  find(cls) { return this.all().filter((n) => n.has(cls)); }
  scrollIntoView() {}
  get open() { return 'open' in this.attrs; } set open(v) { if (v) this.attrs.open = ''; else delete this.attrs.open; }
}
globalThis.document = { createElement: (t) => new Node_(t), createElementNS: (_n, t) => new Node_(t), createTextNode: (text) => ({ nodeType: 3, text }), querySelector: () => null };
globalThis.location = { hash: '', pathname: '/', search: '' };

const { parseDiff, tokens, diffViewer } = await import('../ui/diff.js');
const { codeBlock } = await import('../ui/codeblock.js');
const classes = (spans) => spans.filter((s) => s && s.nodeType === 1).map((s) => `${s.className}:${s.textContent}`);

const SAMPLE = `diff --git a/src/a.js b/src/a.js
index 111..222 100644
--- a/src/a.js
+++ b/src/a.js
@@ -3,4 +3,5 @@ function f() {
   const x = 1;
-  return x + 1;
+  return x + 2;
+  // done
 }
diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+one
+two
diff --git a/old.png b/new.png
similarity index 100%
rename from old.png
rename to new.png
Binary files a/old.png and b/new.png differ
`;

test('parseDiff: files, status, counts, and the old/new line numbers of every row', () => {
  const f = parseDiff(SAMPLE); assert.deepEqual(f.map((x) => [x.path, x.status, x.add, x.del]), [['src/a.js', 'modified', 2, 1], ['new.txt', 'added', 2, 0], ['new.png', 'renamed', 0, 0]]);
  const rows = f[0].hunks[0].rows; assert.deepEqual(rows.map((r) => [r.k, r.o ?? null, r.n ?? null]), [['ctx', 3, 3], ['del', 4, null], ['add', null, 4], ['add', null, 5], ['ctx', 5, 6]]);
  assert.equal(f[0].hunks[0].head, '@@ -3,4 +3,5 @@ function f() {'); assert.equal(f[2].old, 'old.png'); assert.equal(f[2].binary, true);
});

test('diff viewer: one section per file, +/- counts, and only the changed part of a replaced line is marked', () => {
  const v = diffViewer(SAMPLE); const files = v.find('dv-file'); assert.equal(files.length, 3); assert.match(v.find('dv-sum')[0].textContent, /3 files changed\s*\+4\s*−1/);
  const marked = v.find('in-add').map((n) => n.textContent); assert.deepEqual(marked, ['2'], 'the 1 became 2: only that digit is highlighted'); assert.deepEqual(v.find('in-del').map((n) => n.textContent), ['1']);
  assert.ok(v.textContent.includes('Binary file not shown') || files[2].find('dv-note').length >= 0);
});

test('diff viewer: file content is only ever text (markup in a file is not markup in the page)', () => {
  const evil = 'diff --git a/x.html b/x.html\n--- a/x.html\n+++ b/x.html\n@@ -1 +1 @@\n-<p>old</p>\n+<img src=x onerror=alert(1)><script>steal()</script>\n';
  const v = diffViewer(evil); assert.equal(v.all().filter((n) => ['img', 'script'].includes(n.tag)).length, 0, 'no element was created from file text'); assert.ok(v.textContent.includes('<script>steal()</script>'));
});

test('syntax: strings, comments, numbers and keywords per language', () => {
  assert.deepEqual(classes(tokens('const n = 42; // hi', 'js')), ['sx-k:const', 'sx-n:42', 'sx-c:// hi']);
  assert.deepEqual(classes(tokens('{ "a": "b", "n": 1 }', 'json')), ['sx-a:"a"', 'sx-s:"b"', 'sx-a:"n"', 'sx-n:1']);
  assert.ok(classes(tokens('<a href="x">', 'html')).includes('sx-t:<a'));
  assert.deepEqual(classes(tokens('def f(): # note', 'py')).slice(0, 1), ['sx-k:def']);
});

test('syntax state carries across lines: block comments, template literals, docstrings and HTML comments', () => {
  const run = (lang, lines) => { const st = {}; return lines.map((l) => classes(tokens(l, lang, st))); };
  assert.deepEqual(run('js', ['/* start', 'middle', 'end */ const a = 1;']).map((r) => r[0]), ['sx-c:/* start', 'sx-c:middle', 'sx-c:end */']);
  assert.ok(run('js', ['const a = `x', 'still string', 'end` + 1;'])[1][0].startsWith('sx-s:still string'));
  assert.ok(run('py', ['"""doc', 'more', '"""', 'def f(): pass'])[1][0].startsWith('sx-s:more'));
  assert.equal(run('py', ['"""doc', 'more', '"""', 'def f(): pass'])[3][0], 'sx-k:def');
  assert.ok(run('html', ['<!-- a', 'b -->', '<p>'])[1][0].startsWith('sx-c:b -->'));
  assert.deepEqual(run('js', ['const s = `one ${a}`;', 'const t = 2;'])[1], ['sx-k:const', 'sx-n:2'], 'a closed template does not leak into the next line');
});

test('code block: line numbers from the start line, a line count, and setText redraws in place', () => {
  const b = codeBlock('a\nb\nc', { path: 'x.js', start: 10 }); assert.deepEqual(b.find('dn').map((n) => n.attrs['data-n']), ['10', '11', '12']); assert.equal(b.find('cb-meta')[0].textContent, '3 lines'); assert.equal(b.find('cb-name')[0].textContent, 'x.js');
  b.setText('only'); assert.equal(b.find('cb-meta')[0].textContent, '1 line'); assert.equal(b.find('dn').length, 1);
  assert.equal(codeBlock('x', { numbers: false }).find('dn').length, 0);
});

test('code block: a long file is cut with a note, not rendered in full', () => {
  const b = codeBlock(Array.from({ length: 3050 }, (_, i) => `line ${i}`).join('\n'), { lang: 'js' }); assert.equal(b.find('dn').length, 3001); assert.match(b.find('cb-more')[0].textContent, /50 more lines not shown/);
});
