// OpenRouter as an agent provider: free models used at full capacity, swapped as they run out, and a way to carry on when Codex is limited or unavailable.
// Config lives in cfg.openrouter: { enabled, roles: ['reviewer', ...] | ['*'], fallback: { enabled, roles: 'all' | [...] }, allowPaid, banned: [ids], pinned: { role: id } }.
// The API key is the secret OPENROUTER_API_KEY (state/secrets.env, never in the config file, never returned by any API). Installed on Engine.prototype (see the bottom of engine.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { openrouter } from './openrouter.mjs';
import { ModelRouter } from './modelrouter.mjs';
import { openrouterAgent } from './adapters/agent-openrouter.mjs';
import { ROLE_KEYS } from './presets.mjs';

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const KEY_RE = /^sk-or-[A-Za-z0-9_-]{16,200}$/;
const MODEL_RE = /^[A-Za-z0-9._~\/:@+-]{1,120}$/;

export const openrouterMethods = {
  _orConf() { const c = this.cfg.openrouter ?? {}; return { enabled: c.enabled !== false, roles: Array.isArray(c.roles) ? c.roles : [], fallback: { enabled: c.fallback?.enabled !== false, roles: c.fallback?.roles === 'all' || c.fallback?.roles === undefined ? 'all' : (Array.isArray(c.fallback.roles) ? c.fallback.roles : 'all') }, allowPaid: !!c.allowPaid, banned: Array.isArray(c.banned) ? c.banned : [], pinned: c.pinned && typeof c.pinned === 'object' ? c.pinned : {} }; },
  _orKey() { return this.env?.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY || ''; },
  _orClient() { const key = this._orKey(); if (!this._orC || this._orC.key !== key) this._orC = { key, client: openrouter({ key, fetchImpl: this.f.fetch ?? fetch }) }; return this._orC.client; },
  router() { const c = this._orClient(); if (!this._router || this._router.client !== c) this._router = new ModelRouter({ dir: this.cfg.stateDir, client: c, config: () => this._orConf() }); return this._router; },
  _orLiveMap() { return (this._orLive ??= new Map()); },

  // Does a role run on OpenRouter as its first choice? Does OpenRouter stand in when the plan is limited?
  _roleUsesOpenRouter(role) { const c = this._orConf(); return c.enabled && !!this._orKey() && (c.roles.includes('*') || c.roles.includes(role)); },
  _orAgent(role, log, ctx = {}) {
    const id = randomBytes(4).toString('hex'); const live = this._orLiveMap(); const base = openrouterAgent({ router: this.router(), client: this._orClient(), role, project: ctx.project ?? null, onEvent: (e) => { const x = live.get(id); if (!x) return; if (e.type === 'model') { x.model = e.model; x.step = e.step; } if (e.type === 'fail') { x.lastFail = `${e.model}: ${e.kind}`; } } });
    return { ...base, run: async (...args) => { live.set(id, { role, project: ctx.project ?? null, model: null, since: Date.now(), ref: args[3]?.meta?.ref ?? null }); try { return await base.run(...args); } finally { live.delete(id); } } };
  },

  openrouterStatus() {
    const r = this.router(); const conf = this._orConf(); const lim = this.planLimit?.() ?? null; const keySet = !!this._orKey();
    return { key: { set: keySet, authFailed: r.s.authFailed, info: r.s.keyInfo ?? null }, config: conf, ...r.status(), recent: r.recent(50), live: [...this._orLiveMap().values()], codexLimit: lim ? { until: lim.until, untilText: lim.untilText } : null,
      covering: !!lim && this._fallbackAny(), usable: conf.enabled && keySet && !r.s.authFailed, roleModels: Object.fromEntries(ROLE_KEYS.map((role) => [role, r.pick({ role })?.id ?? null])) };
  },
  async setOpenRouterKey(key) {
    if (typeof key !== 'string' || !KEY_RE.test(key.trim())) throw bad('That does not look like an OpenRouter key (it starts with sk-or-).');
    const f = path.join(this.cfg.stateDir, 'secrets.env'); let cur = ''; try { cur = fs.readFileSync(f, 'utf8'); } catch { /* new file */ } const lines = cur.split('\n').filter((l) => l && !l.startsWith('OPENROUTER_API_KEY='));
    lines.push(`OPENROUTER_API_KEY=${key.trim()}`); fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = `${f}.tmp`; fs.writeFileSync(tmp, `${lines.join('\n')}\n`, { mode: 0o600 }); fs.renameSync(tmp, f); this.env.OPENROUTER_API_KEY = key.trim();
    this._audit({ what: 'openrouter', action: 'key-set' }); const r = this.router(); r.clearAuth(); const info = await r.refresh().catch((e) => ({ error: String(e.message ?? e).slice(0, 200) })); return { saved: true, ...info };
  },
  setOpenRouter(patch = {}) {
    const next = { ...(this.cfg.openrouter ?? {}) }; const before = JSON.stringify(this._orConf());
    if (patch.enabled !== undefined) { if (typeof patch.enabled !== 'boolean') throw bad('enabled must be true or false'); next.enabled = patch.enabled; }
    if (patch.allowPaid !== undefined) { if (typeof patch.allowPaid !== 'boolean') throw bad('allowPaid must be true or false'); next.allowPaid = patch.allowPaid; }
    if (patch.roles !== undefined) { if (!Array.isArray(patch.roles) || patch.roles.some((r) => r !== '*' && !ROLE_KEYS.includes(r))) throw bad(`roles must be a list of ${ROLE_KEYS.join(', ')} (or "*" for all)`); next.roles = [...new Set(patch.roles)]; }
    if (patch.fallback !== undefined) { const f = patch.fallback; if (!f || typeof f !== 'object') throw bad('fallback must be { enabled, roles }'); const cur = { ...(next.fallback ?? {}) }; if (f.enabled !== undefined) { if (typeof f.enabled !== 'boolean') throw bad('fallback.enabled must be true or false'); cur.enabled = f.enabled; }
      if (f.roles !== undefined) { if (f.roles !== 'all' && (!Array.isArray(f.roles) || f.roles.some((r) => !ROLE_KEYS.includes(r)))) throw bad('fallback.roles must be "all" or a list of roles'); cur.roles = f.roles; } next.fallback = cur; }
    if (patch.banned !== undefined) { if (!Array.isArray(patch.banned) || patch.banned.some((m) => !MODEL_RE.test(m))) throw bad('banned must be a list of model ids'); next.banned = [...new Set(patch.banned)].slice(0, 100); }
    if (patch.pinned !== undefined) { if (!patch.pinned || typeof patch.pinned !== 'object') throw bad('pinned must map a role to a model id'); const p = {}; for (const [r, m] of Object.entries(patch.pinned)) { if (!ROLE_KEYS.includes(r)) throw bad(`Unknown role "${r}"`); if (m !== null && m !== '' && !MODEL_RE.test(m)) throw bad('That is not a model id'); if (m) p[r] = m; } next.pinned = p; }
    this.cfg.openrouter = next; this._persist(); this._audit({ what: 'openrouter', action: 'config', from: JSON.parse(before), to: this._orConf() }); return this.openrouterStatus();
  },
  async refreshOpenRouter() { if (!this._orKey()) throw bad('Add your OpenRouter API key first.'); const info = await this.router().refresh().catch((e) => { throw bad(`Could not reach OpenRouter: ${String(e.message ?? e).slice(0, 200)}`); }); return { refreshed: info, ...this.openrouterStatus() }; },
  // One tiny real call to a model: does it answer, how fast, and does it handle a tool call? Counts against its limits like any other call.
  async testOpenRouterModel(id) {
    if (!MODEL_RE.test(String(id))) throw bad('That is not a model id'); if (!this._orKey()) throw bad('Add your OpenRouter API key first.'); const r = this.router(); const c = this._orClient();
    const res = await c.chat({ model: id, messages: [{ role: 'user', content: 'Call the ping tool with message "ready". Do not reply in text.' }], tools: [{ type: 'function', function: { name: 'ping', description: 'Ping', parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } } }], maxTokens: 80 });
    if (!res.ok) { r.noteFail(id, res.error, { ms: res.ms, role: 'test' }); return { ok: false, kind: res.error.kind, message: res.error.message, ms: res.ms }; }
    const calls = res.message.tool_calls ?? []; let toolOk = false; try { toolOk = calls.length > 0 && typeof JSON.parse(calls[0].function.arguments || '{}') === 'object'; } catch { toolOk = false; }
    r.noteOk(id, { ms: res.ms, usage: res.usage, role: 'test' }); if (!toolOk) r.noteBadTool(id, { role: 'test' }); return { ok: true, toolCalling: toolOk, ms: res.ms, tokens: res.usage, provider: res.provider };
  },
  resetOpenRouter(id) { this.router().reset(id || null); this._audit({ what: 'openrouter', action: 'reset', model: id ?? 'all' }); return this.openrouterStatus(); },
};
