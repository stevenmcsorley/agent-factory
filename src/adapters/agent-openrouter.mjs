// A coding agent that runs on OpenRouter models. The loop is ours (not a vendor CLI), so a model can be swapped in the MIDDLE of a task when it runs out: the conversation is plain
// OpenAI-style messages that any tool-capable model can continue. The model calls happen on the host (the API key never enters a container); file tools are confined to the checkout; commands
// run inside the project's sandbox, the same place the project's own checks run.
//   run(sandbox, ws, prompt, { timeoutMs, meta }) -> { out, costUsd, tokens: { input, output, cached, reasoning, steps }, model, models, limited?, timedOut? }
import fs from 'node:fs';
import path from 'node:path';

const SYSTEM = `You are an autonomous software engineer working in a git repository checked out in the current directory. Use the tools to look around, read and search files, edit files and run commands (for example the project's tests). Paths are relative to the repository root.
Work step by step and keep each step small. Do not run git commit or git push (the harness does that). Never print or write secrets. When the task is finished, reply with a short plain-text summary and NO tool call. If the task asks for a specific reply format (for example a JSON object), your final reply must be exactly that.`;
const TOOLS = [
  { name: 'list_files', description: 'List files and folders under a directory (default: the repository root), up to 3 levels deep.', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'read_file', description: 'Read a text file. Optionally a line range.', parameters: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['path'] } },
  { name: 'search', description: 'Search text files for a regular expression. Returns matching lines as path:line: text.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
  { name: 'write_file', description: 'Create or overwrite a file with the given full content.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'edit_file', description: 'Replace one exact occurrence of old text with new text in a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } }, required: ['path', 'old', 'new'] } },
  { name: 'run_command', description: 'Run a shell command in the repository (inside the sandbox). Returns its output and exit code.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
].map((f) => ({ type: 'function', function: f }));

const SKIP = new Set(['.git', 'node_modules', '.venv', '__pycache__']);
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}\n…[truncated ${String(s).length - n} characters]` : String(s));
const stripThink = (t) => String(t ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
const text = (c) => (Array.isArray(c) ? c.map((p) => p?.text ?? '').join('') : String(c ?? ''));
const clockOf = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }).toUpperCase();
let lastCallAt = 0;   // free models allow about 20 requests a minute in total: keep our own calls a little apart

export function confine(root, p) { const abs = path.resolve(root, String(p ?? '.').replace(/^\/+/, '')); const rel = path.relative(root, abs); if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('That path is outside the repository'); return { abs, rel: rel || '.' }; }
const denied = (rel) => rel === '.git' || rel.startsWith('.git/') || rel.split('/').includes('.git');

export async function runTool(name, args, { root, sandbox, ws, timeoutMs, image }) {
  if (name === 'list_files') { const { abs, rel } = confine(root, args.path); const out = []; const walk = (d, depth) => { if (out.length >= 400) return; for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { if (SKIP.has(e.name)) continue; const full = path.join(d, e.name); out.push(`${path.relative(root, full)}${e.isDirectory() ? '/' : ''}`); if (e.isDirectory() && depth < 3) walk(full, depth + 1); } }; if (!fs.existsSync(abs)) return `No such directory: ${rel}`; walk(abs, 1); return out.join('\n') || '(empty)'; }
  if (name === 'read_file') { const { abs, rel } = confine(root, args.path); if (denied(rel)) return 'That path is not readable.'; if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return `No such file: ${rel}`; const lines = fs.readFileSync(abs, 'utf8').split('\n'); const a = Math.max(1, Number(args.start_line) || 1), b = Math.min(lines.length, Number(args.end_line) || lines.length); return clip(lines.slice(a - 1, b).map((l, i) => `${a + i}: ${l}`).join('\n'), 24_000); }
  if (name === 'search') { let re; try { re = new RegExp(String(args.pattern), 'i'); } catch { return 'That is not a valid regular expression.'; } const { abs } = confine(root, args.path); const hits = []; const walk = (d) => { if (hits.length >= 60) return; let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of ents) { if (SKIP.has(e.name)) continue; const full = path.join(d, e.name); if (e.isDirectory()) walk(full); else { let t; try { if (fs.statSync(full).size > 400_000) continue; t = fs.readFileSync(full, 'utf8'); } catch { continue; } if (t.includes('\u0000')) continue; t.split('\n').forEach((l, i) => { if (hits.length < 60 && re.test(l)) hits.push(`${path.relative(root, full)}:${i + 1}: ${clip(l, 160)}`); }); } } }; if (fs.statSync(abs).isDirectory()) walk(abs); else { const t = fs.readFileSync(abs, 'utf8'); t.split('\n').forEach((l, i) => { if (re.test(l) && hits.length < 60) hits.push(`${path.relative(root, abs)}:${i + 1}: ${clip(l, 160)}`); }); } return hits.join('\n') || 'No matches.'; }
  if (name === 'write_file') { const { abs, rel } = confine(root, args.path); if (denied(rel)) return 'That path cannot be written.'; const c = String(args.content ?? ''); if (c.length > 400_000) return 'That file is too large to write.'; fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, c); return `Wrote ${rel} (${c.length} characters).`; }
  if (name === 'edit_file') { const { abs, rel } = confine(root, args.path); if (denied(rel)) return 'That path cannot be written.'; if (!fs.existsSync(abs)) return `No such file: ${rel}`; const t = fs.readFileSync(abs, 'utf8'); const old = String(args.old ?? ''); if (!old) return 'The old text is empty.'; const n = t.split(old).length - 1; if (n === 0) return 'The old text was not found. Read the file and copy it exactly.'; if (n > 1) return `The old text appears ${n} times. Include more surrounding text so it is unique.`; fs.writeFileSync(abs, t.replace(old, () => String(args.new ?? ''))); return `Edited ${rel}.`; }
  if (name === 'run_command') { const cmd = String(args.command ?? '').trim(); if (!cmd) return 'No command given.'; const r = await sandbox.exec(ws, 'sh', ['-c', cmd], { timeoutMs: Math.min(300_000, timeoutMs), image }); return `exit code ${r.code ?? '?'}${r.timedOut ? ' (timed out)' : ''}\n${clip(String(r.out ?? '').slice(-8000), 8000)}`; }
  return `Unknown tool: ${name}`;
}

export function openrouterAgent({ router, client, role = 'builder', project = null, maxSteps = 40, minGapMs = 3200, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), onEvent } = {}) {
  return { name: 'openrouter', info: { model: 'auto (OpenRouter free models)', reasoningEffort: null },
    async run(sandbox, ws, prompt, { timeoutMs = 900_000, meta = {} } = {}) {
      const deadline = now() + timeoutMs; const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: String(prompt) }]; const tok = { input: 0, output: 0, cached: 0, reasoning: 0, steps: 0 }; const used = []; const tried = new Set(); let lastModel = null; let badRun = 0; let nudged = false;
      const need = { tools: true }; const limitedResult = (until) => ({ out: `You've hit your usage limit: every OpenRouter free model is resting right now. Try again at ${clockOf(until ?? now() + 10 * 60_000)}.`, costUsd: 0, tokens: tok, model: lastModel, models: used, limited: true });
      for (let step = 0; step < maxSteps + 5; step++) {
        if (now() > deadline) return { out: 'Stopped: the time limit was reached.', costUsd: 0, tokens: tok, model: lastModel, models: used, timedOut: true };
        // a model for this step: the best one that is ready; on a failure the next one, until one answers or none is left
        let res = null; let model = null; const skip = new Set(); for (;;) {
          const pick = router.pick({ role, need, exclude: [...skip] }); if (!pick) { const next = router.nextReady({ role, need }); if (next && next - now() <= 45_000 && now() + (next - now()) < deadline) { await sleep(Math.max(500, next - now())); continue; } return limitedResult(next); }
          const gap = lastCallAt + minGapMs - now(); if (gap > 0) await sleep(gap); lastCallAt = now(); model = pick.id; onEvent?.({ type: 'model', model, role, step });
          res = await client.chat({ model, messages, tools: TOOLS, maxTokens: 4096 }); if (res.ok) break;
          router.noteFail(model, res.error, { ms: res.ms, role, project, ref: meta.ref }); onEvent?.({ type: 'fail', model, kind: res.error.kind, message: res.error.message }); skip.add(model); if (res.error.kind === 'auth') return { out: 'The OpenRouter API key was refused.', costUsd: 0, tokens: tok, model: lastModel, models: used, error: 'auth' }; }
        const u = res.usage; tok.input += u.input; tok.output += u.output; tok.cached += u.cached; tok.reasoning += u.reasoning; if (!used.includes(model)) used.push(model); lastModel = model; router.noteOk(model, { ms: res.ms, usage: u, role, project, steps: tok.steps, ref: meta.ref });
        const msg = res.message; const calls = (msg.tool_calls ?? []).filter((c) => c?.function?.name);
        if (!calls.length) { const t = stripThink(text(msg.content)); if (!t && !nudged) { nudged = true; messages.push({ role: 'assistant', content: text(msg.content) || '' }, { role: 'user', content: 'Reply with your final answer now, as plain text.' }); continue; } return { out: t, costUsd: 0, tokens: tok, model: lastModel, models: used }; }
        messages.push({ role: 'assistant', content: text(msg.content) || null, tool_calls: calls.map((c, i) => ({ id: c.id || `call_${step}_${i}`, type: 'function', function: { name: c.function.name, arguments: c.function.arguments ?? '{}' } })) });
        for (const [i, c] of calls.entries()) { const id = c.id || `call_${step}_${i}`; let args; let result;
          try { args = typeof c.function.arguments === 'string' ? JSON.parse(c.function.arguments || '{}') : (c.function.arguments ?? {}); } catch { args = null; }
          if (args === null || typeof args !== 'object') { result = 'Your tool call arguments were not valid JSON. Call the tool again with a valid JSON object.'; router.noteBadTool(model, { role }); badRun++; if (badRun >= 3) { router.noteFail(model, { kind: 'bad-request', message: 'repeated invalid tool calls' }, { role, project, ref: meta.ref }); badRun = 0; } }
          else { badRun = 0; tok.steps++; try { result = await runTool(c.function.name, args, { root: ws.dir, sandbox, ws, timeoutMs: deadline - now(), image: meta.image }); } catch (e) { result = `Error: ${String(e.message ?? e).slice(0, 300)}`; } }
          messages.push({ role: 'tool', tool_call_id: id, content: clip(result, 12_000) }); }
        // keep a long conversation affordable: old tool results shrink to a stub
        let total = messages.reduce((n, m) => n + String(m.content ?? '').length, 0); if (total > 240_000) for (const m of messages) { if (total < 160_000) break; if (m.role === 'tool' && m.content.length > 400) { total -= m.content.length - 400; m.content = `${m.content.slice(0, 400)}\n…[older output trimmed]`; } }
      }
      return { out: 'Stopped: the step limit was reached before the task was finished.', costUsd: 0, tokens: tok, model: lastModel, models: used };
    } };
}
