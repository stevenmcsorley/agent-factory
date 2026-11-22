// Agent adapters: { run(sandbox, ws, prompt, {timeoutMs}) -> {code,out} }
// claude/codex run on the HOST inside the workspace (they need the user's login); isolation for
// those is workspace-only. For stricter isolation use the 'shell' agent inside docker.
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../util.mjs';
import { EFFORTS, MODEL_RE } from '../settings.mjs';

// `claude -p --output-format json` prints one JSON object with .result and .total_cost_usd.
// Note: on a subscription token the cost is notional (what the API would have charged) but is still a useful budget signal.
export function parseClaudeJson(r) {
  try {
    const j = JSON.parse(r.out.trim().split('\n').filter(Boolean).pop());
    const u = j.usage; const cached = Number(u?.cache_read_input_tokens) || 0;   // Claude reports cache reads separately from input_tokens: fold them in so 'input' means everything sent
    return { ...r, out: j.result ?? r.out, costUsd: Number(j.total_cost_usd) || 0, isError: !!j.is_error, ...(u ? { tokens: { input: (Number(u.input_tokens) || 0) + cached + (Number(u.cache_creation_input_tokens) || 0), cached, output: Number(u.output_tokens) || 0 } } : {}) };
  } catch { return { ...r, costUsd: 0 }; }
}

// `codex exec --json` prints JSONL events; sum any token usage we can find. Cost is not reported (subscription).
export function parseCodexJsonl(r) {
  let input = 0, output = 0, cached = 0, reasoning = 0, last = '';
  for (const line of r.out.split('\n')) {
    try {
      const e = JSON.parse(line);
      const u = e.usage ?? e.msg?.usage ?? e.item?.usage;
      if (u) { input += u.input_tokens ?? 0; output += u.output_tokens ?? 0; cached += u.cached_input_tokens ?? u.cache_read_input_tokens ?? 0; reasoning += u.reasoning_output_tokens ?? 0; }
      const t = e.item?.text ?? e.msg?.message ?? e.message; if (typeof t === 'string') last = t;
    } catch { /* non-JSON line */ }
  }
  return { ...r, out: last || r.out, costUsd: 0, tokens: { input, output, cached, reasoning } };
}

const CRED_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

// The model and effort are config the operator can edit, so check them again at the point of use (a hand-edited config file
// bypasses the UI's validation). They reach the container as separate argv elements, never through a shell.
const checkModel = (m) => { if (m != null && !MODEL_RE.test(m)) throw new Error(`agent.model "${m}" is not a valid model id`); return m ?? null; };
const checkEffort = (e) => { if (e != null && !EFFORTS.includes(e)) throw new Error(`agent.reasoningEffort "${e}" must be one of ${EFFORTS.join(', ')}`); return e ?? null; };

// The argument list for `codex exec` inside the container. With no model/effort given, Codex picks its own defaults (and may change them).
export function codexExecArgs({ model, reasoningEffort, prompt, probe = false } = {}) {
  const m = checkModel(model); const e = checkEffort(reasoningEffort);
  return ['exec', ...(probe ? [] : ['--json']), '--ephemeral', '--skip-git-repo-check', ...(probe ? [] : ['--dangerously-bypass-approvals-and-sandbox']),
    ...(m ? ['-m', m] : []), ...(e ? ['-c', `model_reasoning_effort="${e}"`] : []), prompt];
}

export const agents = {
  // Codex INSIDE the docker sandbox, on a ChatGPT subscription. `codexHome` is a DEDICATED login for the factory
  // (create once: CODEX_HOME=<dir> codex login --device-auth) — never your own ~/.codex, because the container refreshes
  // and rewrites auth.json and could invalidate your personal session. It is mounted read-write so refreshed tokens persist.
  // Codex's own sandbox is bypassed on purpose: the container + egress allowlist are the sandbox.
  codexContainer: ({ image = 'agent-factory-agent:latest', codexHome, model, reasoningEffort } = {}) => ({
    name: 'codex-container',
    info: { model: model ?? null, reasoningEffort: reasoningEffort ?? null },   // what we ASKED for; null means "Codex's own default"
    run: async (sb, ws, prompt, { timeoutMs }) => {
      if (sb.kind !== 'docker') throw new Error('codexContainer requires sandbox.kind = docker');
      if (!codexHome || !fs.existsSync(path.join(codexHome, 'auth.json')))
        throw new Error(`codexContainer needs agent.codexHome with auth.json (run: CODEX_HOME=<dir> codex login --device-auth)`);
      return parseCodexJsonl(await sb.exec(ws, 'codex', codexExecArgs({ model, reasoningEffort, prompt }),
        { timeoutMs, image, mounts: [`${path.resolve(codexHome)}:/home/node/.codex`], env: { HOME: '/home/node' } }));
    },
  }),

  // Claude Code INSIDE the docker sandbox. Only a long-lived token/API key is passed (never ~/.claude, whose
  // OAuth refresh token would be rotated by the container and could log the host session out).
  // Create one with `claude setup-token`, or use an API key with a spend limit.
  claudeContainer: ({ image = 'agent-factory-agent:latest', permissionMode = 'acceptEdits', model,
    allowedTools = 'Read,Edit,Write,Glob,Grep,Bash(git diff:*),Bash(npm test:*),Bash(node:*)', env = process.env } = {}) => ({
    name: 'claude-container',
    info: { model: model ?? null, reasoningEffort: null },
    run: async (sb, ws, prompt, { timeoutMs }) => {
      if (sb.kind !== 'docker') throw new Error('claudeContainer requires sandbox.kind = docker');
      const creds = Object.fromEntries(CRED_VARS.filter((k) => env[k]).map((k) => [k, env[k]]));
      if (!Object.keys(creds).length) throw new Error(`claudeContainer needs one of ${CRED_VARS.join(', ')} in the environment`);
      const m = checkModel(model);
      return parseClaudeJson(await sb.exec(ws, 'claude', ['-p', prompt, '--output-format', 'json', '--permission-mode', permissionMode, '--allowedTools', allowedTools, ...(m ? ['--model', m] : [])],
        { timeoutMs, image, env: { ...creds, HOME: '/home/node' } }));
    },
  }),

  // Headless Claude Code. Permission mode is configurable; default accepts edits only.
  claude: ({ permissionMode = 'acceptEdits', allowedTools = 'Read,Edit,Write,Glob,Grep,Bash(git diff:*),Bash(npm test:*),Bash(node:*)', log } = {}) => ({
    name: 'claude',
    run: async (_sb, ws, prompt, { timeoutMs }) =>
      parseClaudeJson(await run('claude', ['-p', prompt, '--output-format', 'json', '--permission-mode', permissionMode, '--allowedTools', allowedTools],
        { cwd: ws.dir, timeoutMs, log })),
  }),
  codex: ({ log } = {}) => ({
    name: 'codex',
    run: (_sb, ws, prompt, { timeoutMs }) => run('codex', ['exec', '--full-auto', prompt], { cwd: ws.dir, timeoutMs, log }),
  }),
  // Arbitrary command through the sandbox; prompt arrives on stdin and in $FACTORY_PROMPT. Used for tests.
  shell: ({ command }) => ({
    name: 'shell',
    run: (sb, ws, prompt, { timeoutMs }) => sb.exec(ws, 'sh', ['-c', command], { timeoutMs, input: prompt, env: { FACTORY_PROMPT: prompt } }),
  }),
};
