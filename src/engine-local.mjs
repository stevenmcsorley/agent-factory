// Local models as an agent provider: Ollama, LM Studio, llama.cpp or vLLM running on this machine (or another one on your network). Free, private, no allowance, no key.
// Config lives in cfg.local: { enabled (default false), baseUrl, numCtx, maxGb, allowRemote, banned: [ids], pinned: { role: id } }. Off until you turn it on, because a small model on a CPU is slow:
// the delegation rules (delegation.mjs) only use it where you route a role to it, where Codex and the free models are both unavailable, or in "local only" mode. Installed on Engine.prototype.
import { randomBytes } from 'node:crypto';
import { localClient, LocalRouter, DEFAULT_URL } from './localmodels.mjs';
import { openrouterAgent } from './adapters/agent-openrouter.mjs';
import { ROLE_KEYS } from './presets.mjs';

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const MODEL_RE = /^[A-Za-z0-9._~\/:@+-]{1,120}$/;
const URL_RE = /^https?:\/\/[^\s/?#]+(:\d{1,5})?(\/[^\s?#]*)?$/i;

export const localMethods = {
  _localConf() { const c = this.cfg.local ?? {}; return { enabled: c.enabled === true, baseUrl: typeof c.baseUrl === 'string' && URL_RE.test(c.baseUrl) ? c.baseUrl : DEFAULT_URL, numCtx: Number(c.numCtx) >= 2048 ? Math.min(131072, Math.round(Number(c.numCtx))) : 16384, maxGb: Number(c.maxGb) > 0 ? Number(c.maxGb) : null, allowRemote: c.allowRemote === true, banned: Array.isArray(c.banned) ? c.banned : [], pinned: c.pinned && typeof c.pinned === 'object' ? c.pinned : {} }; },
  _localClient() { const c = this._localConf(); const sig = `${c.baseUrl}|${c.numCtx}`; if (!this._lc || this._lc.sig !== sig) this._lc = { sig, client: localClient({ baseUrl: c.baseUrl, numCtx: c.numCtx, fetchImpl: this.f.fetch ?? fetch }) }; return this._lc.client; },
  localRouter() { const cl = this._localClient(); if (!this._lrouter || this._lrouter.client !== cl) this._lrouter = new LocalRouter({ dir: this.cfg.stateDir, client: cl, config: () => this._localConf(), onChange: (t) => this.notify(t) }); return this._lrouter; },
  // Looks at what the server has installed, at most once a minute (and only when local models are switched on).
  async _localEnsure() { const c = this._localConf(); if (!c.enabled) return; const r = this.localRouter(); if (Date.now() - r.refreshedAt > 60_000) await r.refresh(); },
  // Can local models take a job right now? (switched on, the server answered, and a model that fits is not resting)
  _localState(role = 'builder', judge = false) { const c = this._localConf(); if (!c.enabled) return { usable: false, ready: false }; const r = this.localRouter(); const usable = r.refreshedAt > 0 && !r.error && r.models.some((m) => r.eligible(m, { tools: !judge })); return { usable, ready: usable && !!r.pick({ role, need: { tools: !judge } }) }; },
  _localAgent(role, log, ctx = {}) {
    const live = (this._localLive ??= new Map()); const id = randomBytes(4).toString('hex');
    const base = openrouterAgent({ router: this.localRouter(), client: this._localClient(), role, project: ctx.project ?? null, name: 'local', local: true, label: 'local model', modelLabel: 'auto (local models)', minGapMs: 0, onEvent: (e) => { const x = live.get(id); if (x && e.type === 'model') x.model = e.model; } });
    return { ...base, run: async (...args) => { live.set(id, { role, project: ctx.project ?? null, model: null, since: Date.now() }); try { return await base.run(...args); } finally { live.delete(id); } } };
  },

  localStatus() {
    const c = this._localConf(); const r = this.localRouter(); const st = r.status();
    return { config: c, ...st, enabled: c.enabled, usable: this._localState().usable, live: [...(this._localLive ?? new Map()).values()], roleModels: Object.fromEntries(ROLE_KEYS.map((role) => [role, c.enabled ? (r.pick({ role })?.id ?? null) : null])) };
  },
  setLocal(patch = {}) {
    const next = { ...(this.cfg.local ?? {}) }; const before = JSON.stringify(this._localConf());
    if (patch.enabled !== undefined) { if (typeof patch.enabled !== 'boolean') throw bad('enabled must be true or false'); next.enabled = patch.enabled; }
    if (patch.baseUrl !== undefined) { if (typeof patch.baseUrl !== 'string' || !URL_RE.test(patch.baseUrl.trim())) throw bad('The address must look like http://127.0.0.1:11434'); next.baseUrl = patch.baseUrl.trim().replace(/\/+$/, ''); }
    if (patch.numCtx !== undefined) { const n = Number(patch.numCtx); if (!Number.isFinite(n) || n < 2048 || n > 131072) throw bad('The context size must be between 2048 and 131072 tokens'); next.numCtx = Math.round(n); }
    if (patch.maxGb !== undefined) { if (patch.maxGb === null) delete next.maxGb; else { const n = Number(patch.maxGb); if (!Number.isFinite(n) || n < 1 || n > 1024) throw bad('The memory limit must be between 1 and 1024 GB'); next.maxGb = n; } }
    if (patch.allowRemote !== undefined) { if (typeof patch.allowRemote !== 'boolean') throw bad('allowRemote must be true or false'); next.allowRemote = patch.allowRemote; }
    if (patch.banned !== undefined) { if (!Array.isArray(patch.banned) || patch.banned.some((m) => !MODEL_RE.test(m))) throw bad('banned must be a list of model names'); next.banned = [...new Set(patch.banned)].slice(0, 100); }
    if (patch.pinned !== undefined) { if (!patch.pinned || typeof patch.pinned !== 'object') throw bad('pinned must map a role to a model name'); const p = {}; for (const [r, m] of Object.entries(patch.pinned)) { if (!ROLE_KEYS.includes(r)) throw bad(`Unknown role "${r}"`); if (m === null || m === '') continue; if (!MODEL_RE.test(String(m))) throw bad('That is not a model name'); p[r] = m; } next.pinned = p; }
    this.cfg.local = next; this._persist(); this._lrouter && (this._lrouter.refreshedAt = 0); this._audit({ what: 'local', action: 'config', from: JSON.parse(before), to: this._localConf() }); return this.localStatus();
  },
  async refreshLocal() { const info = await this.localRouter().refresh(); return { refreshed: true, ...info, ...this.localStatus() }; },
  // One tiny real call: does it answer, how fast, and does it handle a tool call? (The first call also loads the model, which can take a while on a CPU.)
  async testLocalModel(id) {
    if (!MODEL_RE.test(String(id))) throw bad('That is not a model name'); const r = this.localRouter(); const c = this._localClient();
    const res = await c.chat({ model: id, messages: [{ role: 'user', content: 'Call the ping tool with message "ready". Do not reply in text.' }], tools: [{ type: 'function', function: { name: 'ping', description: 'Ping', parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } } }], maxTokens: 120 });
    if (!res.ok) { r.noteFail(id, res.error); return { ok: false, kind: res.error.kind, message: res.error.message, ms: res.ms }; }
    const calls = res.message.tool_calls ?? []; let toolOk = false; try { toolOk = calls.length > 0 && typeof JSON.parse(calls[0].function.arguments || '{}') === 'object'; } catch { toolOk = false; }
    r.noteOk(id, { ms: res.ms, usage: res.usage }); if (!toolOk) r.noteBadTool(id); return { ok: true, toolCalling: toolOk, ms: res.ms, tokens: res.usage, tokensPerSecond: res.speed ? Math.round(res.speed * 10) / 10 : null };
  },
  resetLocal(id) { this.localRouter().reset(id || null); this._audit({ what: 'local', action: 'reset', model: id ?? 'all' }); return this.localStatus(); },
};
