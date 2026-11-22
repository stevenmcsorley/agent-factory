// A small OpenRouter client (zero dependencies): the model catalogue, the key's details, and chat completions with tool calling, with every failure classified so the router can decide what
// to do next (rest this model for a while, rest it until tomorrow, drop it, stop everything because the key is bad). The key is read from the environment and never logged or returned.
export const BASE_URL = 'https://openrouter.ai/api/v1';
const clip = (s, n) => String(s ?? '').slice(0, n);
const utcMidnightAfter = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); };

// kind: rate-limit (try again soon) | daily-limit (the free allowance for the day is used) | credits (needs credits) | unavailable (this model/provider is down or gone) | auth (the key is wrong)
//       | bad-request (we sent something this model cannot take) | timeout | network | other
export function classifyError({ status, body, headers = {}, now = Date.now() }) {
  const err = (body && typeof body === 'object' ? body.error : null) ?? {}; const msg = clip(err.message ?? (typeof body === 'string' ? body : ''), 300); const meta = err.metadata ?? {};
  const raw = `${msg} ${clip(typeof meta.raw === 'string' ? meta.raw : JSON.stringify(meta.raw ?? ''), 400)}`.toLowerCase();
  // when the limit lifts, if anything says so: a reset header (epoch ms or seconds) or Retry-After (seconds)
  const h = Object.fromEntries(Object.entries({ ...(meta.headers ?? {}), ...headers }).map(([k, v]) => [String(k).toLowerCase(), v]));
  let retryAtMs = null; const reset = Number(h['x-ratelimit-reset']); if (Number.isFinite(reset) && reset > 0) retryAtMs = reset > 1e12 ? reset : reset > 1e9 ? reset * 1000 : null;
  const cap = Number(h['x-ratelimit-limit']); const ra = Number(h['retry-after']); if (retryAtMs === null && Number.isFinite(ra) && ra > 0) retryAtMs = now + ra * 1000;
  const code = Number(status ?? err.code);
  if (code === 401 || code === 403) return { kind: 'auth', message: msg || 'The API key was refused', retryAtMs: null };
  if (code === 402) return { kind: 'credits', message: msg || 'This needs credits', retryAtMs: null };
  if (code === 429) { const daily = /per-day|per day|daily|free-models-per-day|requests per day/.test(raw); return { kind: daily ? 'daily-limit' : 'rate-limit', message: msg || 'Rate limited', retryAtMs: retryAtMs ?? (daily ? utcMidnightAfter(now) : null), limit: Number.isFinite(cap) && cap > 0 ? cap : null, source: meta.limit_source ?? null, provider: meta.provider_name ?? null }; }
  if (code === 404 || /no endpoints found|model.*(not found|unavailable|no longer)/.test(raw)) return { kind: 'unavailable', message: msg || 'The model is not available', retryAtMs: null };
  if (code === 400 || code === 422) return { kind: 'bad-request', message: msg || 'The model rejected the request', retryAtMs: null };
  if (code === 408 || code === 504) return { kind: 'timeout', message: msg || 'Timed out', retryAtMs: null };
  if (code >= 500 || code === 502 || code === 503) return { kind: 'unavailable', message: msg || 'The provider is having trouble', retryAtMs: retryAtMs ?? null };
  return { kind: 'other', message: msg || `HTTP ${code || '?'}`, retryAtMs: null };
}

export function openrouter({ key, fetchImpl = fetch, baseUrl = BASE_URL, title = 'Agent Factory', timeoutMs = 120_000, now = () => Date.now() } = {}) {
  const need = () => { if (!key) throw Object.assign(new Error('No OpenRouter API key is set'), { kind: 'auth', status: 401 }); };
  const call = async (method, path, body, { timeout = timeoutMs } = {}) => {
    need(); const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout); const t0 = now();
    try { const res = await fetchImpl(`${baseUrl}${path}`, { method, signal: ctl.signal, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-OpenRouter-Title': title }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } const headers = {}; try { res.headers?.forEach?.((v, k) => { headers[k] = v; }); } catch { /* none */ }
      return { status: res.status, ok: res.ok, json, text, headers, ms: now() - t0 };
    } catch (e) { return { status: 0, ok: false, json: null, text: '', headers: {}, ms: now() - t0, thrown: e?.name === 'AbortError' ? 'timeout' : 'network', error: String(e?.message ?? e).slice(0, 200) }; } finally { clearTimeout(t); }
  };
  return {
    hasKey: !!key,
    // The catalogue, reduced to what routing needs.
    async models() {
      const r = await call('GET', '/models', null, { timeout: 30_000 }); if (!r.ok) throw Object.assign(new Error(classifyError({ status: r.status, body: r.json, headers: r.headers }).message || `models: HTTP ${r.status}`), { status: r.status });
      return (r.json?.data ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id, context: m.context_length ?? m.top_provider?.context_length ?? 0, maxOut: m.top_provider?.max_completion_tokens ?? null, free: String(m.id).endsWith(':free') || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0), pricing: { prompt: Number(m.pricing?.prompt ?? 0), completion: Number(m.pricing?.completion ?? 0) },
        tools: (m.supported_parameters ?? []).includes('tools'), structured: (m.supported_parameters ?? []).includes('response_format') || (m.supported_parameters ?? []).includes('structured_outputs'), reasoning: (m.supported_parameters ?? []).includes('reasoning'), input: m.architecture?.input_modalities ?? ['text'], output: m.architecture?.output_modalities ?? ['text'], created: m.created ?? null }));
    },
    // The account's credit: total bought and total used (only the account owner's key can read it).
    async credits() { const r = await call('GET', '/credits', null, { timeout: 20_000 }); if (!r.ok) return null; const d = r.json?.data ?? {}; return { total: Number(d.total_credits ?? 0), used: Number(d.total_usage ?? 0) }; },
    async keyInfo() { const r = await call('GET', '/key', null, { timeout: 20_000 }); if (!r.ok) return { ok: false, error: classifyError({ status: r.status, body: r.json, headers: r.headers }) }; const d = r.json?.data ?? {}; return { ok: true, label: d.label ?? null, freeTier: !!d.is_free_tier, usage: d.usage ?? 0, limit: d.limit ?? null, remaining: d.limit_remaining ?? null }; },
    // One chat completion. Returns { ok:true, message, finish, usage, model, provider, ms } or { ok:false, error:{kind,message,retryAtMs}, ms }.
    async chat({ model, messages, tools, toolChoice = 'auto', maxTokens = 4096, temperature = 0.2 }) {
      const r = await call('POST', '/chat/completions', { model, messages, ...(tools?.length ? { tools, tool_choice: toolChoice } : {}), max_tokens: maxTokens, temperature });
      if (r.thrown) return { ok: false, ms: r.ms, error: { kind: r.thrown, message: r.error, retryAtMs: null } };
      // OpenRouter can answer 200 with an error body when the upstream provider failed mid-request
      const bodyErr = r.json?.error; if (!r.ok || bodyErr) return { ok: false, ms: r.ms, error: classifyError({ status: r.ok ? Number(bodyErr?.code) || 502 : r.status, body: r.json ?? r.text, headers: r.headers, now: now() }) };
      const ch = r.json?.choices?.[0]; if (!ch?.message) return { ok: false, ms: r.ms, error: { kind: 'unavailable', message: 'The model returned no message', retryAtMs: null } };
      const u = r.json.usage ?? {}; return { ok: true, ms: r.ms, message: ch.message, finish: ch.finish_reason ?? null, model: r.json.model ?? model, provider: r.json.provider ?? null,
        usage: { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0, cached: u.prompt_tokens_details?.cached_tokens ?? 0, reasoning: u.completion_tokens_details?.reasoning_tokens ?? 0, cost: u.cost ?? 0 } };
    },
  };
}
