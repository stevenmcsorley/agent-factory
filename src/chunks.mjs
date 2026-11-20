// Function-level chunks: the unit worth reusing. Whole-file fingerprints miss "this one function is the same in both projects";
// chunks find how a project talks to an API, how it does auth, a React component or hook, a class that implements an adapter.
// Heuristic and dependency-free (no parser): good enough to find candidates for a human to look at, not a source of truth.
import { minhash } from './library.mjs';

const JS_EXT = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx']);
const MIN_LINES = 10, MAX_LINES = 260, MAX_PER_FILE = 40;

// Strip strings, template literals and comments so braces inside them do not confuse the depth count.
const bare = (line) => line.replace(/\/\/.*$/, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, '""');
const FN = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
const ARROW = /^(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:React\.)?(?:memo\(|forwardRef\(|async\s*)?(?:<[^>]*>\s*)?(?:\(|[A-Za-z_$][\w$]*\s*=>|function\b)/;
const CLASS = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;
const METHOD = /^\s{2,4}(?:(?:public|private|protected|static|async|readonly|override)\s+)*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(/;
const NOT_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor', 'else', 'with']);

function braceEnd(lines, start, baseDepth) {          // index of the line where the block opened on/after `start` closes back to baseDepth
  let depth = baseDepth, paren = 0, opened = false;       // braces inside (...) are parameter destructuring or types, not the body
  for (let i = start; i < lines.length && i - start <= MAX_LINES * 4; i++) {
    if (!opened && i > start && /^(?:export\s|function\s|class\s|const\s|let\s|var\s|async\s|@)/.test(lines[i])) return -1;   // reached the next declaration with no body: an expression-bodied arrow
    for (const ch of bare(lines[i])) {
      if (ch === '(') paren++; else if (ch === ')') paren = Math.max(0, paren - 1);
      else if (paren === 0 && ch === '{') { depth++; opened = true; } else if (paren === 0 && ch === '}') { depth--; if (opened && depth <= baseDepth) return i; }
    }
    if (!opened && i - start >= 6) return -1;            // no body within a few lines: a type or a long expression
  }
  return -1;
}

const ROUTE = /^([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|on|use)\(\s*(?:(['"`][^'"`]*['"`])\s*,)?/;
function parenEnd(lines, start) {
  let paren = 0, opened = false;
  for (let i = start; i < lines.length && i - start <= MAX_LINES * 4; i++) { for (const ch of bare(lines[i])) { if (ch === '(') { paren++; opened = true; } else if (ch === ')') { paren--; if (opened && paren <= 0) return i; } } }
  return -1;
}

function jsChunks(lines) {
  const out = []; let i = 0;
  while (i < lines.length) {
    const l = lines[i]; let m, kind;
    if (!/^\s/.test(l) && (m = ROUTE.exec(l)) && /=>\s*\{?\s*$|function\s*\(|=>\s*\{/.test(lines.slice(i, i + 3).join(' '))) { const e = parenEnd(lines, i); if (e > i) { out.push({ name: `${m[1]}.${m[2]}${m[3] ? ' ' + m[3].slice(1, -1) : ''}`, kind: 'route', start: i, end: e }); i = e + 1; continue; } }
    if ((m = FN.exec(l))) kind = 'function'; else if ((m = CLASS.exec(l))) kind = 'class'; else if ((m = ARROW.exec(l))) kind = 'function';
    if (!m || /^\s/.test(l)) { i++; continue; }
    const end = braceEnd(lines, i, 0); if (end < 0) { i++; continue; }
    const name = m[1]; const body = lines.slice(i, end + 1);
    if (kind === 'class') {
      const methods = []; let j = i + 1;
      while (j < end) { const mm = METHOD.exec(lines[j]); if (mm && !NOT_METHOD.has(mm[1]) && /\{\s*$|\)\s*(?::[^{]+)?\{/.test(lines[j])) { const e = braceEnd(lines, j, 1); if (e > 0 && e <= end) { methods.push({ name: mm[1], start: j, end: e }); j = e + 1; continue; } } j++; }
      out.push({ name, kind, start: i, end, methods: methods.map((x) => x.name) });
      for (const x of methods) if (x.name !== 'constructor') out.push({ name: `${name}.${x.name}`, kind: 'method', start: x.start, end: x.end });
    } else out.push({ name, kind, start: i, end });
    i = end + 1; void body;
  }
  return out;
}

function pyChunks(lines) {
  const out = []; const indentOf = (s) => s.match(/^\s*/)[0].length;
  const endOf = (i, ind) => { let last = i; for (let j = i + 1; j < lines.length; j++) { if (!lines[j].trim()) continue; if (indentOf(lines[j]) <= ind) break; last = j; } return last; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]; let m;
    if ((m = /^(?:async\s+)?def\s+(\w+)/.exec(l))) out.push({ name: m[1], kind: 'function', start: i, end: endOf(i, 0) });
    else if ((m = /^class\s+(\w+)/.exec(l))) {
      const end = endOf(i, 0); const methods = [];
      for (let j = i + 1; j <= end; j++) { const mm = /^(\s+)(?:async\s+)?def\s+(\w+)/.exec(lines[j]); if (mm && mm[1].length <= 8) { const e = endOf(j, mm[1].length); methods.push({ name: mm[2], start: j, end: e }); j = e; } }
      out.push({ name: m[1], kind: 'class', start: i, end, methods: methods.map((x) => x.name) });
      for (const x of methods) if (x.name !== '__init__') out.push({ name: `${m[1]}.${x.name}`, kind: 'method', start: x.start, end: x.end });
    }
  }
  return out;
}

// What the chunk is about, from what it does. Used to rank: a function that calls an API is worth more than a getter.
const TAGS = [
  ['api-client', /\bfetch\s*\(|\baxios\b|\brequests\.(?:get|post|put|patch|delete|request|Session)|\bhttpx\b|\baiohttp\b|\burllib\b|http\.request|XMLHttpRequest|\bgot\(|\bky\(/],
  ['auth', /\bjwt\b|bearer|oauth|bcrypt|password|csrf|hmac|\bsession\b|api[_-]?key|authorization/i],
  ['database', /\bSELECT\s|\bINSERT\s|\bUPDATE\s.+\bSET\b|sqlalchemy|\.query\(|prisma|knex|\.execute\(|cursor\(|\.commit\(\)/i],
  ['retry', /\bretr(?:y|ies)\b|backoff|exponential|attempt\s*(?:<|>|\+\+|\+=)/i],
  ['cache', /\bcache\b|\blru\b|memoi[sz]e|\bttl\b|\bexpires?\b/i],
  ['streaming', /EventSource|WebSocket|\bstream(?:ing)?\b|asyncio\.Queue|\.pipe\(|async\s+for\b|text\/event-stream/i],
  ['validation', /\bzod\b|\bschema\b|\bvalidat(?:e|or)\b|pydantic|BaseModel|\bparse[A-Z_]|jsonschema/i],
  ['llm', /openai|anthropic|chat\.completions|messages\.create|\bprompt\b.*\bmodel\b|embedding/i],
  ['scheduling', /setInterval|cron|schedule|apscheduler|celery|\bqueue\b/i],
  ['adapter', /\bimplements\s|\(ABC\)|Protocol\)|abstractmethod|\badapter\b|interface\s+\w+/i],
];
export function tagsOf(raw, { ext, name, kind } = {}) {
  const text = String(raw).split('\n').filter((l) => !/^\s*(\/\/|#|\*|\/\*)/.test(l)).map((l) => l.replace(/\s\/\/\s.*$/, '')).join('\n');   // comments describe, they do not do
  const tags = TAGS.filter(([, re]) => re.test(text)).map(([t]) => t);
  if (['tsx', 'jsx'].includes(ext) && /<[A-Za-z][\w.]*[\s>/]|<>/.test(text) && /return\s*\(?\s*(?:<|\()|=>\s*\(?\s*</.test(text)) tags.push(/^use[A-Z]/.test(name ?? '') ? 'hook' : 'component');
  else if (/^use[A-Z]/.test(name ?? '') && JS_EXT.has(ext) && /\buse(?:State|Effect|Ref|Memo|Callback|Context|Reducer)\b/.test(text)) tags.push('hook');
  if (kind === 'class' && !tags.includes('adapter') && /\bextends\s+\w+/.test(text.split('\n', 3).join(' '))) tags.push('subclass');
  return tags;
}

// One entry per chunk, shaped like a file fingerprint plus what it is. Too small or too short to say anything -> skipped.
export function chunkPrints(rel, text, ext) {
  const lang = String(ext).toLowerCase(); const lines = String(text).split('\n'); if (lines.length > 6000) return [];
  const found = JS_EXT.has(lang) ? jsChunks(lines) : lang === 'py' ? pyChunks(lines) : []; const prints = [];
  for (const c of found) {
    const body = lines.slice(c.start, c.end + 1).join('\n'); const real = body.split('\n').filter((l) => l.trim() && !/^\s*(\/\/|#|\*|\/\*)/.test(l)).length;
    const code = Math.max(real, Math.round(body.replace(/\s+/g, ' ').length / 70));                // dense one-line-per-statement code counts by size, not lines
    if (code < MIN_LINES || code > MAX_LINES) continue; const sig = minhash(body); if (!sig.length) continue;
    const tags = tagsOf(body, { ext: lang, name: c.name.split('.').pop(), kind: c.kind });
    prints.push({ kind: 'chunk', type: c.kind, file: rel, name: c.name, start: c.start + 1, lines: code, tags, ...(c.methods?.length ? { methods: c.methods.slice(0, 40) } : {}), exports: [], sig });
    if (prints.length >= MAX_PER_FILE) break;
  }
  return prints;
}
