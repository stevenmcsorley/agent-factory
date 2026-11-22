// Which OpenRouter model should do this job right now, and what to do when one runs out.
// It keeps (on disk) a catalogue of the models, what has happened with each one (calls, successes, rate limits, bad tool calls, speed, tokens), and for any model that ran out:
// when it is expected to be back, learned from how long it really took to recover last time. Picking combines a PRIOR (size, name, context, what the role needs) with what has been
// OBSERVED (success rate, tool-call reliability, speed), skips what is resting, and never picks a paid model unless allowed. No I/O except its own two files; the client is injected.
import fs from 'node:fs';
import path from 'node:path';

const MIN = 60_000, HOUR = 3_600_000;
const clip = (s, n) => String(s ?? '').slice(0, n);

// ---- the prior: what we can tell about a model from its name, size and context before it has done anything for us
export function parseSizeB(id) { const m = [...String(id).toLowerCase().matchAll(/(\d+(?:\.\d+)?)b(?![a-z])/g)].map((x) => Number(x[1])); if (!m.length) return null; const total = Math.max(...m); const active = /a(\d+(?:\.\d+)?)b/.exec(String(id).toLowerCase()); return { total, active: active ? Number(active[1]) : null }; }
export function priorScore(m, role = 'builder') {
  let s = 0; const sz = parseSizeB(m.id); const name = m.id.toLowerCase();
  if (sz) { const eff = sz.active ? (sz.total * 0.6 + sz.active * 4) : sz.total; s += Math.min(4, Math.log2(Math.max(1, eff)) * 0.45); } else s += 1.2;       // unknown size: assume middling
  if (/ultra|opus|pro\b|max|large|plus/.test(name)) s += 1.2; if (/super|thinking|reason|r1\b/.test(name)) s += 0.7; if (/flash|lite|nano|mini|small|tiny|lightning|instant/.test(name)) s -= 0.7; if (/preview|beta|exp(?:erimental)?\b/.test(name)) s -= 0.3; if (/coder|code|codex|devstral/.test(name)) s += role === 'builder' || role === 'fixer' ? 1 : 0.2;
  s += Math.min(1.5, Math.max(0, Math.log2((m.context || 8192) / 32768)) * 0.35); if (m.reasoning && ['reviewer', 'security', 'planner', 'spec-writer'].includes(role)) s += 0.4; if (/^openrouter\//.test(name)) s -= 1.5;   // the auto-router is a last resort
  return Math.round(s * 100) / 100;
}

export class ModelRouter {
  constructor({ dir, client, now = () => Date.now(), config = () => ({}) }) { this.dir = dir; this.client = client; this.now = now; this.config = config; this.file = path.join(dir, 'openrouter.json'); this.callsFile = path.join(dir, 'openrouter-calls.jsonl'); this.s = this._load(); }
  _load() { try { const s = JSON.parse(fs.readFileSync(this.file, 'utf8')); return { models: s.models ?? {}, stats: s.stats ?? {}, refreshedAt: s.refreshedAt ?? null, freeUntil: s.freeUntil ?? 0, authFailed: !!s.authFailed, day: s.day ?? { date: null, requests: 0 }, keyInfo: s.keyInfo ?? null }; } catch { return { models: {}, stats: {}, refreshedAt: null, freeUntil: 0, authFailed: false, day: { date: null, requests: 0 }, keyInfo: null }; } }
  _save() { try { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.s)); fs.renameSync(`${this.file}.tmp`, this.file); } catch { /* the router must never break a run */ } }
  _stat(id) { return (this.s.stats[id] ??= { calls: 0, ok: 0, limited: 0, unavailable: 0, badTools: 0, otherFail: 0, ms: 0, input: 0, output: 0, cached: 0, lastOk: null, lastErr: null, lastKind: null, lastMsg: null, cooldown: null, level: 0, restEma: null, rests: 0 }); }

  async refresh() { const list = await this.client.models(); const models = {}; for (const m of list) models[m.id] = m; this.s.models = models; this.s.refreshedAt = this.now(); const k = await this.client.keyInfo().catch(() => null); if (k?.ok) { this.s.keyInfo = k; this.s.authFailed = false; } else if (k?.error?.kind === 'auth') this.s.authFailed = true; this._save(); return { models: list.length, free: list.filter((m) => m.free).length, toolCapableFree: list.filter((m) => m.free && m.tools).length }; }

  // ---- state of one model right now
  resting(id, t = this.now()) { const c = this.s.stats[id]?.cooldown; return c && c.until > t ? c : null; }
  allowed(m, cfg = this.config()) { if (cfg.banned?.includes(m.id)) return false; if (!m.free && !cfg.allowPaid) return false; return true; }
  score(m, role) { const st = this.s.stats[m.id]; let s = priorScore(m, role); const pin = this.config().pinned?.[role]; if (pin === m.id) s += 100;
    if (st && st.calls >= 3) { const rate = st.ok / st.calls; s += 3 * (rate - 0.8); const avg = st.ms / Math.max(1, st.ok); s -= Math.min(1.5, avg / 60_000); s -= 3 * (st.badTools / st.calls); }
    if (st?.lastErr && this.now() - st.lastErr < 2 * MIN) s -= 1;   // just failed: do not flap straight back
    return Math.round(s * 100) / 100; }
  // The best model that is ready, in order, for a job. need = { tools, vision, minContext }.
  candidates({ role = 'builder', need = {}, exclude = [] } = {}) {
    const t = this.now(); const cfg = this.config(); const out = [];
    for (const m of Object.values(this.s.models)) { if (exclude.includes(m.id) || !this.allowed(m, cfg)) continue; if (need.tools !== false && !m.tools) continue; if (need.vision && !m.input.includes('image')) continue; if ((need.minContext ?? 0) > (m.context || 0)) continue;
      const rest = this.resting(m.id, t); if (rest) continue; if (m.free && this.s.freeUntil > t) continue; out.push({ ...m, score: this.score(m, role) }); }
    return out.sort((a, b) => b.score - a.score);
  }
  // Nothing ready: when is the soonest one expected back (null if nothing will ever be)?
  nextReady({ role = 'builder', need = {} } = {}) { const t = this.now(); const cfg = this.config(); let best = null; for (const m of Object.values(this.s.models)) { if (!this.allowed(m, cfg) || (need.tools !== false && !m.tools)) continue; const c = this.resting(m.id, t); const until = Math.max(c?.until ?? 0, m.free ? this.s.freeUntil : 0); if (until > t && (best === null || until < best)) best = until; } return best; }
  pick(opts) { return this.candidates(opts)[0] ?? null; }

  // ---- what happened
  _day() { const d = new Date(this.now()).toISOString().slice(0, 10); if (this.s.day.date !== d) this.s.day = { date: d, requests: 0 }; return this.s.day; }
  noteOk(id, { ms = 0, usage = {}, role = null, project = null, steps = 0, ref = null } = {}) {
    const st = this._stat(id); const t = this.now(); this._day().requests++; st.calls++; st.ok++; st.ms += ms; st.input += usage.input ?? 0; st.output += usage.output ?? 0; st.cached += usage.cached ?? 0; st.lastOk = t;
    if (st.cooldown) { const rested = Math.max(0, t - st.cooldown.since); st.restEma = st.restEma === null ? rested : Math.round(0.6 * st.restEma + 0.4 * rested); st.rests++; st.cooldown = null; }   // it came back: remember how long that took
    st.level = 0; this._log({ at: t, role, project, model: id, ok: true, ms, in: usage.input ?? 0, out: usage.output ?? 0, steps, ref }); this._save();
  }
  noteFail(id, error, { ms = 0, role = null, project = null, ref = null } = {}) {
    const st = this._stat(id); const t = this.now(); this._day().requests++; st.calls++; st.ms += ms; st.lastErr = t; st.lastKind = error.kind; st.lastMsg = clip(error.message, 200); let until = 0;
    const learned = st.restEma ?? null;
    if (error.kind === 'auth') this.s.authFailed = true;
    else if (error.kind === 'daily-limit') { until = error.retryAtMs ?? t + 6 * HOUR; if (!id.includes(':free') && this.s.models[id]?.free === false) { /* a paid model's own daily limit */ } else this.s.freeUntil = Math.max(this.s.freeUntil, until); st.limited++; }
    else if (error.kind === 'rate-limit') { st.limited++; st.level++; const base = learned ?? MIN; until = error.retryAtMs ? Math.min(error.retryAtMs, t + 24 * HOUR) : t + Math.min(HOUR, base * 2 ** (st.level - 1)); }
    else if (error.kind === 'unavailable') { st.unavailable++; st.level++; until = t + Math.min(6 * HOUR, 5 * MIN * 2 ** (st.level - 1)); if (/no endpoints|not found|no longer/i.test(error.message)) until = t + 6 * HOUR; }
    else if (error.kind === 'bad-request') { st.badTools++; until = t + 30 * MIN; }
    else if (error.kind === 'credits') { until = t + HOUR; }
    else { st.otherFail++; st.level++; until = t + Math.min(30 * MIN, 2 * MIN * 2 ** (st.level - 1)); }
    if (until) st.cooldown = { until, since: st.cooldown?.since ?? t, kind: error.kind, level: st.level };
    this._log({ at: t, role, project, model: id, ok: false, kind: error.kind, ms, err: clip(error.message, 160), ref }); this._save(); return st.cooldown;
  }
  // A model the agent saw answer with unusable tool calls (not an HTTP error): a quality failure, remembered against it.
  noteBadTool(id, { role = null } = {}) { const st = this._stat(id); st.badTools++; this._log({ at: this.now(), role, model: id, ok: false, kind: 'bad-tool-call', err: 'invalid tool call arguments' }); this._save(); }
  reset(id) { if (id) { const st = this.s.stats[id]; if (st) { st.cooldown = null; st.level = 0; } } else { for (const st of Object.values(this.s.stats)) { st.cooldown = null; st.level = 0; } this.s.freeUntil = 0; this.s.authFailed = false; } this._save(); }
  clearAuth() { this.s.authFailed = false; this._save(); }

  _log(row) { try { fs.mkdirSync(this.dir, { recursive: true }); fs.appendFileSync(this.callsFile, `${JSON.stringify(row)}\n`); if (Math.random() < 0.02) this._trim(); } catch { /* best effort */ } }
  _trim() { try { const lines = fs.readFileSync(this.callsFile, 'utf8').split('\n').filter(Boolean); if (lines.length > 600) fs.writeFileSync(this.callsFile, `${lines.slice(-400).join('\n')}\n`); } catch { /* best effort */ } }
  recent(n = 60) { try { return fs.readFileSync(this.callsFile, 'utf8').split('\n').filter(Boolean).slice(-n).map((l) => JSON.parse(l)).reverse(); } catch { return []; } }

  status({ role = 'builder' } = {}) {
    const t = this.now(); const cfg = this.config(); const rows = Object.values(this.s.models).filter((m) => m.free || cfg.allowPaid || this.s.stats[m.id]?.calls).map((m) => { const st = this.s.stats[m.id] ?? null; const rest = this.resting(m.id, t); const freeRest = m.free && this.s.freeUntil > t;
      return { id: m.id, name: m.name, free: m.free, tools: m.tools, context: m.context, input: m.input, reasoning: m.reasoning, allowed: this.allowed(m, cfg), banned: !!cfg.banned?.includes(m.id), score: this.score(m, role), prior: priorScore(m, role),
        state: !this.allowed(m, cfg) ? (cfg.banned?.includes(m.id) ? 'banned' : 'not allowed') : !m.tools ? 'no tool calling' : rest ? 'resting' : freeRest ? 'free allowance used' : 'ready',
        backAt: rest ? rest.until : freeRest ? this.s.freeUntil : null, restKind: rest?.kind ?? (freeRest ? 'daily-limit' : null), learnedRestMs: st?.restEma ?? null,
        calls: st?.calls ?? 0, ok: st?.ok ?? 0, limited: st?.limited ?? 0, unavailable: st?.unavailable ?? 0, badTools: st?.badTools ?? 0, avgMs: st?.ok ? Math.round(st.ms / st.ok) : null, input: st?.input ?? 0, output: st?.output ?? 0, lastOk: st?.lastOk ?? null, lastErr: st?.lastErr ?? null, lastMsg: st?.lastMsg ?? null }; });
    rows.sort((a, b) => (b.state === 'ready') - (a.state === 'ready') || b.score - a.score);
    return { refreshedAt: this.s.refreshedAt, authFailed: this.s.authFailed, freeUntil: this.s.freeUntil > t ? this.s.freeUntil : null, today: this._day().requests, keyInfo: this.s.keyInfo, models: rows, ready: rows.filter((r) => r.state === 'ready').length, resting: rows.filter((r) => r.state === 'resting').length };
  }
}
