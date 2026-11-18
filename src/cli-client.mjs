// `agent-factory ops | op | portfolio | brief | plan | source | agents-md`: drive a RUNNING factory from the terminal (or from any AI agent that can
// run shell commands). It is a thin client over the same operations the MCP server exposes, so a person, a script, Claude and Codex all
// do exactly the same things and the factory remains the single writer of its own state.
import fs from 'node:fs';
import path from 'node:path';

const FLAG_SKIP = new Set(['config', 'json', 'pretty', 'wait', 'launch', 'show', 'help']);
const short = (s) => String(s).split(/(?<=[.!?])\s/)[0].slice(0, 130);

async function call(cfg, method, p, body) {
  const host = ['0.0.0.0', '::'].includes(cfg.ui.host) ? '127.0.0.1' : cfg.ui.host; const base = `http://${host}:${cfg.ui.port}`;
  let token; try { token = fs.readFileSync(path.join(cfg.stateDir, 'ui-token'), 'utf8').trim(); } catch { throw new Error('No UI token yet. Start the factory once: agent-factory start'); }
  let r; try { r = await fetch(`${base}${p}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000) }); }
  catch { throw new Error(`The factory is not running at ${base}. Start it with: agent-factory start`); }
  const j = await r.json().catch(() => null); if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`); return j;
}
const coerce = (v) => { if (v === true) return true; if (/^(true|false)$/.test(v)) return v === 'true'; if (/^-?\d+$/.test(v)) return Number(v); if (/^[{[]/.test(v)) { try { return JSON.parse(v); } catch { /* keep as text */ } } return v; };
const fromFile = (v) => (typeof v === 'string' && v.startsWith('@') && fs.existsSync(v.slice(1)) ? fs.readFileSync(v.slice(1), 'utf8') : v);   // --scope=@scope.md reads the file
const out = (x, flags) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, flags.compact ? 0 : 2));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function planText(g) {
  if (!g.plan) return `No plan yet${g.job?.state === 'running' ? ` (planning: ${g.job.phase})` : g.job?.state === 'error' ? ` (last attempt failed: ${g.job.error})` : ''}.`;
  const L = [`Plan (${g.plan.status}): ${g.plan.summary}`, g.progress ? `Progress: ${g.progress.done}/${g.progress.total} done, ${g.progress.review} in review, ${g.progress.working} working, ${g.progress.queued} queued, ${g.progress.planned} not started yet` : ''];
  for (const e of g.plan.epics) { L.push('', `${e.title}  [${e.id}]`); for (const t of e.tickets) L.push(`  ${t.status.padEnd(8)} ${t.size} ${t.id}: ${t.title}${t.dependsOn.length ? `   (after ${t.dependsOn.join(', ')})` : ''}${t.url ? `   ${t.url}` : ''}`); }
  return L.join('\n');
}

export async function clientCommand(cmd, args, flags, cfg, root) {
  const rest = args.slice(1).filter((a) => !a.startsWith('--')); const project = rest[0];
  const need = (what) => { if (!project) throw new Error(`Usage: agent-factory ${cmd} <project>${what ? ` ${what}` : ''}`); };
  if (cmd === 'agents-md') return console.log(fs.readFileSync(path.join(root, 'docs', 'AGENT-GUIDE.md'), 'utf8'));
  if (cmd === 'ops') {
    const ops = await call(cfg, 'GET', '/api/ops'); if (flags.json) return out(ops, flags);
    const w = Math.max(...ops.map((o) => o.name.length)); return console.log(ops.map((o) => `${o.name.padEnd(w)}  ${o.readOnly ? '   ' : 'W  '}${short(o.description)}`).join('\n') + '\n\nW = changes something. Run one:  agent-factory op <name> --project=<id> --key=value ...   (or a JSON object as the next argument)');
  }
  if (cmd === 'op') {
    const name = rest[0]; if (!name) throw new Error('Usage: agent-factory op <name> [json] [--key=value ...]');
    let body = {}; const j = rest[1] ?? flags.json; if (typeof j === 'string' && j.startsWith('{')) body = JSON.parse(j);
    for (const [k, v] of Object.entries(flags)) if (!FLAG_SKIP.has(k)) body[k] = coerce(typeof v === 'string' ? fromFile(v) : v);
    return out(await call(cfg, 'POST', `/api/op/${name.replace(/[^a-z_]/g, '')}`, body), flags);
  }
  if (cmd === 'portfolio') {
    const rows = await call(cfg, 'GET', '/api/portfolio'); if (flags.json) return out(rows, flags); if (!rows.length) return console.log('No projects yet. Create one: agent-factory op create_project --name=... --brief=\'{"goal":"...","scope":"..."}\' --plan=true');
    return console.log(rows.map((r) => [r.id.padEnd(22), `brief ${r.brief.filled}/${r.brief.total}`.padEnd(10), (r.plan ? `plan ${r.plan.done}/${r.plan.total}` : 'no plan').padEnd(12), `queue ${Object.entries(r.queue).map(([k, v]) => `${v} ${k}`).join(', ') || 'empty'}`.padEnd(30), `PRs ${r.openPrs}`.padEnd(7), r.quality ? `gate ${r.quality.gate}` : 'not analyzed', r.tests ? `tests ${r.tests}` : ''].join('  ')).join('\n'));
  }
  if (cmd === 'brief') {
    need('[--goal=... --users=... --scope=... --non-goals=... --success=... --constraints=... --stack=... --decisions=...]');
    const patch = { brief: {} }; const map = { goal: 'goal', users: 'users', scope: 'scope', 'non-goals': 'nonGoals', success: 'success', constraints: 'constraints' }; let any = false;
    for (const [flag, key] of Object.entries(map)) if (typeof flags[flag] === 'string') { patch.brief[key] = fromFile(flags[flag]); any = true; }
    for (const k of ['stack', 'decisions']) if (typeof flags[k] === 'string') { patch[k] = fromFile(flags[k]); any = true; }
    if (any) { const r = await call(cfg, 'POST', `/api/projects/${project}/pack`, patch); return flags.json ? out(r.completeness, flags) : console.log(`Saved. Brief ${r.completeness.filled}/${r.completeness.total} complete${r.completeness.missing.length ? `; still missing: ${r.completeness.missing.join(', ')}` : ''}.`); }
    const p = await call(cfg, 'GET', `/api/projects/${project}/pack`); if (flags.json) return out(p, flags);
    return console.log([p.fields.map((f) => `## ${f.label}\n${p.brief[f.key] || `(empty) ${f.hint}`}`).join('\n\n'), `## Stack and conventions\n${p.stack || '(empty)'}`, `## Decisions\n${p.decisions || '(empty)'}`, `## Sources (${p.sources.length})\n${p.sources.map((s) => `- ${s.id} [${s.kind}] ${s.title}${s.url ? ` <${s.url}>` : ''}`).join('\n') || '(none)'}`].join('\n\n'));
  }
  if (cmd === 'source') {
    need('<file|url|-> [--kind=prd|research|design|reference] [--title=...]'); const what = rest[1]; if (!what) throw new Error('Give a file, a URL, or - to read text from stdin');
    const body = { kind: typeof flags.kind === 'string' ? flags.kind : 'other', title: typeof flags.title === 'string' ? flags.title : undefined };
    if (/^https?:\/\//.test(what)) body.url = what;
    else if (what === '-') { body.text = fs.readFileSync(0, 'utf8'); body.title ??= 'Pasted notes'; }
    else { if (!fs.existsSync(what)) throw new Error(`No such file: ${what}`); body.filename = path.basename(what); body.title ??= body.filename; body.dataBase64 = fs.readFileSync(what).toString('base64'); }
    const r = await call(cfg, 'POST', `/api/projects/${project}/pack/sources`, body); return console.log(`Added. ${r.sources.length} source${r.sources.length === 1 ? '' : 's'} on ${project}.`);
  }
  if (cmd === 'plan') {
    need('[--wait] [--launch] [--show]');
    if (!flags.show) { try { await call(cfg, 'POST', `/api/projects/${project}/plan`, {}); console.log('Planning started: the agent is reading the brief.'); } catch (e) { if (!flags.launch || !/already launched/.test(e.message)) throw e; } }
    if (flags.wait || flags.launch) { const end = Date.now() + 25 * 60_000; for (;;) { const g = await call(cfg, 'GET', `/api/projects/${project}/plan`); if (g.job?.state === 'error') throw new Error(`Planning failed: ${g.job.error}`); if (g.job?.state !== 'running' && g.plan) break; if (Date.now() > end) throw new Error('Planning is taking too long; check: agent-factory plan <project> --show'); await wait(3000); } }
    let g = await call(cfg, 'GET', `/api/projects/${project}/plan`);
    if (flags.launch && g.plan?.status === 'proposed') { await call(cfg, 'POST', `/api/projects/${project}/plan/launch`, {}); g = await call(cfg, 'GET', `/api/projects/${project}/plan`); console.log('Plan launched: tickets are created as their dependencies are merged.'); }
    return flags.json ? out(g, flags) : console.log(planText(g));
  }
  throw new Error(`Unknown command: ${cmd}`);
}
