// Local models: Ollama (used through its own API so the context size can be set), or any server that speaks the OpenAI chat API (LM Studio, llama.cpp, vLLM). Nothing leaves the machine the
// server runs on, there is no key, no daily allowance and no cost; the limits are the hardware's: memory decides which models fit, and speed decides which jobs are worth giving them.
// Models Ollama lists as ":cloud" are NOT local (Ollama runs them on its own servers): they are flagged `remote` and kept out unless you allow them.
import os from 'node:os';
export const DEFAULT_URL = 'http://127.0.0.1:11434';
const clip = (s, n) => String(s ?? '').slice(0, n);
export const paramsOf = (m) => { const d = String(m?.details?.parameter_size ?? '').match(/([\d.]+)\s*([BM])/i); if (d) return Number(d[1]) / (d[2].toUpperCase() === 'M' ? 1000 : 1); const n = String(m?.name ?? m?.id ?? '').match(/(\d+(?:\.\d+)?)\s*b\b/i); return n ? Number(n[1]) : null; };
export const defaultMaxGb = () => Math.max(2, Math.floor((os.totalmem() / 1e9) * 0.55));

export function classifyLocalError({ status, body, thrown, error }) {
  const msg = clip(typeof body === 'object' ? (body?.error?.message ?? body?.error ?? JSON.stringify(body)) : body, 300); const low = `${msg} ${error ?? ''}`.toLowerCase();
  if (thrown === 'timeout') return { kind: 'timeout', message: 'The local model took too long to answer', retryAtMs: null };
  if (thrown) return { kind: 'down', message: 'The local model server is not reachable. Is it running?', retryAtMs: null };
  if (status === 404 || /not found|no such model|try pulling/.test(low)) return { kind: 'unavailable', message: msg || 'That model is not installed', retryAtMs: null };
  if (/does not support tools|tool.*not supported/.test(low)) return { kind: 'bad-request', message: 'This model cannot call tools', retryAtMs: null };
  if (/memory|out of memory|oom|requires more system memory/.test(low)) return { kind: 'memory', message: msg || 'Not enough memory to run this model', retryAtMs: null };
  if (status === 400 || status === 422) return { kind: 'bad-request', message: msg || 'The model rejected the request', retryAtMs: null };
  return { kind: status >= 500 ? 'unavailable' : 'other', message: msg || `HTTP ${status || '?'}`, retryAtMs: null };
}

export function localClient({ baseUrl = DEFAULT_URL, fetchImpl = fetch, timeoutMs = 900_000, numCtx = 16384, now = () => Date.now() } = {}) {
  const root = String(baseUrl || DEFAULT_URL).trim().replace(/\/+$/, '').replace(/\/v1$/, ''); let kind = null; const shown = new Map();
  const call = async (method, path, body, timeout = timeoutMs) => {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout); const t0 = now();
    try { const res = await fetchImpl(`${root}${path}`, { method, signal: ctl.signal, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } return { status: res.status, ok: res.ok, json, text, ms: now() - t0 }; }
    catch (e) { return { status: 0, ok: false, json: null, text: '', ms: now() - t0, thrown: e?.name === 'AbortError' ? 'timeout' : 'network', error: clip(e?.message, 200) }; } finally { clearTimeout(t); }
  };
  async function detect() { if (kind) return kind; const a = await call('GET', '/api/tags', null, 5000); if (a.ok && Array.isArray(a.json?.models)) return (kind = 'ollama'); const b = await call('GET', '/v1/models', null, 5000); if (b.ok && Array.isArray(b.json?.data)) return (kind = 'openai'); return null; }
  return {
    root, get kind() { return kind; },
    // What is installed, reduced to what routing needs. Embedding-only models are left out.
    async models() {
      const k = await detect(); if (!k) throw Object.assign(new Error(`Nothing answered at ${root}. Is Ollama (or another local model server) running?`), { kind: 'down' });
      if (k === 'openai') { const r = await call('GET', '/v1/models', null, 10_000); return (r.json?.data ?? []).map((m) => ({ id: m.id, name: m.id, sizeGb: null, params: paramsOf({ name: m.id }), context: null, tools: true, vision: false, thinking: false, remote: false, quant: null, family: null })); }
      const r = await call('GET', '/api/tags', null, 10_000); const list = r.json?.models ?? []; const out = [];
      await Promise.all(list.map(async (m) => { let info = shown.get(m.name); if (!info) { const s = await call('POST', '/api/show', { model: m.name }, 10_000); const caps = s.json?.capabilities ?? []; const mi = s.json?.model_info ?? {}; const ctxKey = Object.keys(mi).find((x) => x.endsWith('.context_length')); info = { caps, context: ctxKey ? Number(mi[ctxKey]) : null }; if (s.ok) shown.set(m.name, info); }
        if (info.caps.length && !info.caps.includes('completion')) return;
        out.push({ id: m.name, name: m.name, sizeGb: m.size ? Math.round(m.size / 1e8) / 10 : 0, params: paramsOf(m), context: info.context, tools: info.caps.length ? info.caps.includes('tools') : null, vision: info.caps.includes('vision'), thinking: info.caps.includes('thinking'),
          remote: !!(m.remote_host || m.remote_model || /:cloud$/.test(m.name) || m.size === 0), quant: m.details?.quantization_level ?? null, family: m.details?.family ?? null }); }));
      return out.sort((a, b) => a.id.localeCompare(b.id));
    },
    // One chat completion with tool calling, in the shape the agent loop uses. Returns { ok:true, message, finish, usage, model, ms } or { ok:false, error:{kind,message,retryAtMs}, ms }.
    async chat({ model, messages, tools, maxTokens = 4096, temperature = 0.2 }) {
      const k = await detect(); if (!k) return { ok: false, ms: 0, error: classifyLocalError({ thrown: 'network' }) };
      if (k === 'openai') {
        const r = await call('POST', '/v1/chat/completions', { model, messages, ...(tools?.length ? { tools } : {}), max_tokens: maxTokens, temperature }); if (r.thrown) return { ok: false, ms: r.ms, error: classifyLocalError(r) }; if (!r.ok) return { ok: false, ms: r.ms, error: classifyLocalError({ status: r.status, body: r.json ?? r.text }) };
        const ch = r.json?.choices?.[0]; if (!ch?.message) return { ok: false, ms: r.ms, error: { kind: 'unavailable', message: 'The model returned no message', retryAtMs: null } }; const u = r.json.usage ?? {};
        return { ok: true, ms: r.ms, message: ch.message, finish: ch.finish_reason ?? null, model, provider: 'local', usage: { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0, cached: 0, reasoning: 0, cost: 0 } };
      }
      // Ollama's own API: tool arguments are objects, and tool results are matched by tool name
      const names = new Map(); const msgs = messages.map((m) => {
        if (m.role === 'assistant' && m.tool_calls?.length) { for (const c of m.tool_calls) names.set(c.id, c.function.name); return { role: 'assistant', content: m.content ?? '', tool_calls: m.tool_calls.map((c) => ({ function: { name: c.function.name, arguments: (() => { try { return typeof c.function.arguments === 'string' ? JSON.parse(c.function.arguments || '{}') : (c.function.arguments ?? {}); } catch { return {}; } })() } })) }; }
        if (m.role === 'tool') return { role: 'tool', content: String(m.content ?? ''), tool_name: names.get(m.tool_call_id) ?? 'tool' };
        return { role: m.role, content: String(m.content ?? '') }; });
      const r = await call('POST', '/api/chat', { model, messages: msgs, ...(tools?.length ? { tools } : {}), stream: false, keep_alive: '10m', options: { num_ctx: numCtx, num_predict: maxTokens, temperature } });
      if (r.thrown) return { ok: false, ms: r.ms, error: classifyLocalError(r) }; if (!r.ok || r.json?.error) return { ok: false, ms: r.ms, error: classifyLocalError({ status: r.ok ? 500 : r.status, body: r.json ?? r.text }) };
      const m = r.json?.message; if (!m) return { ok: false, ms: r.ms, error: { kind: 'unavailable', message: 'The model returned no message', retryAtMs: null } };
      const calls = (m.tool_calls ?? []).filter((c) => c?.function?.name).map((c, i) => ({ id: `call_${Date.now().toString(36)}_${i}`, type: 'function', function: { name: c.function.name, arguments: JSON.stringify(c.function.arguments ?? {}) } }));
      return { ok: true, ms: r.ms, message: { role: 'assistant', content: m.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) }, finish: r.json.done_reason ?? null, model, provider: 'local', usage: { input: r.json.prompt_eval_count ?? 0, output: r.json.eval_count ?? 0, cached: 0, reasoning: 0, cost: 0 }, speed: r.json.eval_count && r.json.eval_duration ? r.json.eval_count / (r.json.eval_duration / 1e9) : null };
    },
  };
}

// Picks a local model for a job and remembers how each one did. Same surface the agent loop uses on the OpenRouter router (pick, noteOk, noteFail, noteBadTool, nextReady, budget, config).
import fs from 'node:fs';
import path from 'node:path';
const REST = { down: 60_000, memory: 600_000, unavailable: 1_800_000, timeout: 300_000, 'bad-request': 900_000, other: 120_000 };
export class LocalRouter {
  constructor({ dir, client, config, onChange, now = () => Date.now() }) { this.dir = dir; this.client = client; this.config = config; this.onChange = onChange ?? (() => {}); this.now = now; this.models = []; this.error = null; this.refreshedAt = 0; this.s = { stats: {} }; this._load(); }
  _file() { return path.join(this.dir, 'local.json'); }
  _load() { try { const j = JSON.parse(fs.readFileSync(this._file(), 'utf8')); if (j && typeof j.stats === 'object') this.s = { stats: j.stats }; } catch { /* first run */ } }
  _save() { try { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(`${this._file()}.tmp`, JSON.stringify(this.s)); fs.renameSync(`${this._file()}.tmp`, this._file()); } catch { /* best effort */ } }
  st(id) { return (this.s.stats[id] ??= { ok: 0, fail: 0, badTool: 0, ms: null, tps: null, restUntil: 0, lastError: null, lastAt: 0 }); }
  async refresh() { try { this.models = await this.client.models(); this.error = null; } catch (e) { this.models = []; this.error = String(e.message ?? e).slice(0, 200); } this.refreshedAt = this.now(); this.onChange('local'); return { models: this.models.length, error: this.error }; }
  maxGb() { const c = this.config(); return Number(c.maxGb) > 0 ? Number(c.maxGb) : defaultMaxGb(); }
  fits(m) { const c = this.config(); if (m.remote) return !!c.allowRemote; return m.sizeGb == null || m.sizeGb * 1.15 <= this.maxGb(); }
  eligible(m, need = {}) { const c = this.config(); if (c.banned?.includes(m.id)) return false; if (!this.fits(m)) return false; if (need.tools && m.tools === false) return false; if (need.tools && this.st(m.id).badTool >= 3 && this.st(m.id).ok < this.st(m.id).badTool) return false; return true; }
  // bigger models write better code and judge better; learned results beat guesses; a model that keeps failing or is very slow sinks
  score(m, role) { const s = this.st(m.id); const total = s.ok + s.fail; const rate = total >= 3 ? s.ok / total : 0.7; const size = Math.min(m.params ?? 4, 14); return size * 10 + (m.tools ? 6 : 0) + rate * 25 - (s.tps != null && s.tps < 1.5 ? 12 : 0) - (m.remote ? 8 : 0) + (m.thinking && ['reviewer', 'security'].includes(role) ? 3 : 0); }
  pick({ role, need = {}, exclude = [] } = {}) {
    const c = this.config(); if (!c.enabled) return null; const pin = c.pinned?.[role]; const now = this.now(); const list = this.models.filter((m) => !exclude.includes(m.id) && this.eligible(m, need) && this.st(m.id).restUntil <= now);
    const pinned = pin && list.find((m) => m.id === pin); if (pinned) return pinned; return list.sort((a, b) => this.score(b, role) - this.score(a, role))[0] ?? null;
  }
  nextReady({ need = {} } = {}) { const now = this.now(); const times = this.models.filter((m) => this.eligible(m, need)).map((m) => this.st(m.id).restUntil).filter((t) => t > now); return times.length ? Math.min(...times) : null; }
  budget() { return { remaining: null, cap: null }; }
  noteOk(id, { ms, usage } = {}) { const s = this.st(id); s.ok++; s.restUntil = 0; s.lastAt = this.now(); if (ms) s.ms = s.ms == null ? ms : s.ms * 0.7 + ms * 0.3; if (usage?.output && ms) { const tps = usage.output / (ms / 1000); s.tps = s.tps == null ? tps : s.tps * 0.7 + tps * 0.3; } this._save(); this.onChange('local'); }
  noteFail(id, error = {}) { const s = this.st(id); s.fail++; s.lastError = clip(error.message, 160); s.lastAt = this.now(); s.restUntil = this.now() + (REST[error.kind] ?? REST.other); this._save(); this.onChange('local'); }
  noteBadTool(id) { this.st(id).badTool++; this._save(); }
  reset(id) { if (id) delete this.s.stats[id]; else this.s.stats = {}; this._save(); this.onChange('local'); }
  status() {
    const now = this.now(); const c = this.config();
    return { reachable: !this.error && this.refreshedAt > 0, error: this.error, kind: this.client.kind, endpoint: this.client.root, refreshedAt: this.refreshedAt || null, maxGb: this.maxGb(), memoryGb: Math.round(os.totalmem() / 1e8) / 10, cores: os.cpus().length,
      models: this.models.map((m) => { const s = this.st(m.id); const ok = this.eligible(m, {}); return { ...m, fits: this.fits(m), banned: !!c.banned?.includes(m.id), pinnedFor: Object.entries(c.pinned ?? {}).filter(([, v]) => v === m.id).map(([r]) => r), usable: ok, resting: s.restUntil > now ? { until: s.restUntil, why: s.lastError } : null,
        ok: s.ok, fail: s.fail, badTool: s.badTool, avgMs: s.ms == null ? null : Math.round(s.ms), tokensPerSecond: s.tps == null ? null : Math.round(s.tps * 10) / 10 }; }) };
  }
}
