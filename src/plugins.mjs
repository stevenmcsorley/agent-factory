// Plugins: how anyone changes what the factory does and which services it talks to, without forking it.
//
//   <config dir>/plugins/<name>/plugin.json   { name, version, description, secrets: ["AF_..."], main: "index.mjs" }
//   <config dir>/plugins/<name>/index.mjs     export function register(api) { ... }
//   <config dir>/plugins.json                 which plugins are enabled, pinned by a hash of their files, with their config
//
// A plugin can add operations (MCP and CLI), scenario step types (deploy targets, notifiers, anything), quality rules, library part kinds, ticket
// sources and code hosts. Plugins are TRUSTED CODE running in the factory process, so enabling one is a deliberate, human, offline act
// (`agent-factory plugin enable <name>`): it records a hash of the plugin's files, and if a single byte changes later the plugin is refused
// until you review and enable it again. Agents and the API cannot enable plugins.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { OPS, OP } from './ops.mjs';
import { SOURCES } from './sources.mjs';
import { HOSTS } from './hosts.mjs';
import { KINDS } from './library.mjs';
import { registerRule } from './quality.mjs';
import { registerStepType, safeFetch } from './scenarios.mjs';

const NAME = /^[a-z][a-z0-9-]{1,39}$/, SEMVER = /^\d+\.\d+\.\d+$/, SECRET = /^AF_[A-Z0-9_]{1,60}$/, SKIP = new Set(['.git', 'node_modules']);
const bad = (m) => Object.assign(new Error(m), { status: 400 });

export const pluginsFile = (configDir) => path.join(configDir, 'plugins.json');
export const readEnabled = (configDir) => { try { const j = JSON.parse(fs.readFileSync(pluginsFile(configDir), 'utf8')); return j && typeof j.enabled === 'object' && j.enabled ? j.enabled : {}; } catch { return {}; } };
export const writeEnabled = (configDir, enabled) => { const f = pluginsFile(configDir); fs.writeFileSync(`${f}.tmp`, `${JSON.stringify({ enabled }, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(`${f}.tmp`, f); };

// A hash of every file in the plugin folder (names and bytes). Any edit changes it.
export function hashDir(dir) {
  const h = crypto.createHash('sha256'); let total = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { if (SKIP.has(e.name) || e.isSymbolicLink()) continue; const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f); else { const buf = fs.readFileSync(f); total += buf.length; if (total > 5_000_000) throw bad('Plugin is too large (5 MB max)'); h.update(path.relative(dir, f)).update('\0').update(buf).update('\0'); } } };
  walk(dir); return h.digest('hex');
}
export function readManifest(dir) {
  let m; try { m = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')); } catch { throw bad('plugin.json is missing or not valid JSON'); }
  if (!NAME.test(m.name ?? '')) throw bad('plugin.json: name must be lowercase letters, digits and dashes (2-40 chars)'); if (!SEMVER.test(m.version ?? '')) throw bad('plugin.json: version must be semver (1.2.3)');
  const main = m.main ?? 'index.mjs'; if (path.isAbsolute(main) || main.includes('..') || !/\.m?js$/.test(main)) throw bad('plugin.json: main must be a .mjs file inside the plugin folder');
  const secrets = Array.isArray(m.secrets) ? m.secrets : []; for (const s of secrets) if (!SECRET.test(s)) throw bad(`plugin.json: secret "${s}" must look like AF_MY_TOKEN`);
  return { name: m.name, version: m.version, description: String(m.description ?? '').slice(0, 300), secrets, main, homepage: String(m.homepage ?? '').slice(0, 200) };
}
export function discover(dirs) {
  const out = [];
  for (const root of [...new Set(dirs.map((d) => path.resolve(d)))]) { let es = []; try { es = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { continue; }
    for (const e of es) { const dir = path.join(root, e.name); try { const manifest = readManifest(dir); out.push({ dir, manifest, sha: hashDir(dir) }); } catch (err) { out.push({ dir, error: String(err.message).slice(0, 200), manifest: { name: e.name } }); } } }
  return out;
}

// The object a plugin's register() receives. Everything a plugin adds is recorded so the UI can show what it provides.
function makeApi({ manifest, config, env, log, provided }) {
  const ns = (n) => `${manifest.name}.${n}`;
  const note = (kind, name) => provided.push(`${kind}:${name}`);
  return {
    name: manifest.name, config: structuredClone(config ?? {}), log: (m) => log(`[${manifest.name}] ${m}`),
    // Outbound HTTP for scenario steps: https only, hosts must be in the scenario's allowHosts, no redirects, no private addresses.
    safeFetch,
    // Only the secrets the manifest declares, so a plugin cannot read your other tokens.
    secret: (n) => { if (!manifest.secrets.includes(n)) throw new Error(`${manifest.name} did not declare the secret ${n} in plugin.json`); return env[n]; },
    registerOp(def) {
      const short = String(def?.name ?? ''); if (!/^[a-z][a-z0-9_]{1,40}$/.test(short)) throw new Error('op name must be lowercase letters, digits and underscores'); const full = `${manifest.name.replace(/-/g, '_')}_${short}`;
      if (OP[full]) throw new Error(`operation ${full} already exists`); if (typeof def.handler !== 'function') throw new Error('op needs a handler(engine, args)');
      const op = { name: full, description: `[${manifest.name}] ${def.description ?? ''}`, readOnly: !!def.readOnly, openWorld: !!def.openWorld, input: def.input ?? { type: 'object', properties: {}, required: [], additionalProperties: false }, handler: def.handler };
      op.input = { type: 'object', properties: op.input.properties ?? {}, required: op.input.required ?? [], additionalProperties: false }; OPS.push(op); OP[full] = op; note('op', full);
    },
    // A scenario step type: { describe(args, ctx), plan?(args, ctx), run(args, ctx), validate?(args) }. Used in scenario files as "type": "<plugin>.<name>".
    registerStep(n, def) { if (!/^[a-z][a-z0-9_-]{1,40}$/.test(n)) throw new Error('step name must be lowercase letters, digits, dashes and underscores'); registerStepType(ns(n), { ...def, plugin: manifest.name }); note('step', ns(n)); },
    registerRule(def) { registerRule({ ...def, id: ns(def.id) }); note('rule', ns(def.id)); },
    registerPartKind(n) { if (!/^[a-z][a-z-]{1,24}$/.test(n)) throw new Error('part kind must be lowercase letters and dashes'); if (!KINDS.includes(n)) KINDS.push(n); note('part-kind', n); },
    registerSource(kind, def) { if (SOURCES[kind]) throw new Error(`ticket source ${kind} already exists`); SOURCES[kind] = def; note('source', kind); },
    registerHost(kind, def) { if (HOSTS[kind]) throw new Error(`code host ${kind} already exists`); HOSTS[kind] = def; note('host', kind); },
  };
}

// Load every enabled plugin whose files still match the hash you approved. Returns a report for the UI and the CLI.
export async function loadPlugins({ dirs, enabled, env = {}, log = () => {} }) {
  const found = new Map(discover(dirs).map((p) => [p.manifest.name, p])); const report = [];
  for (const p of found.values()) if (!enabled[p.manifest.name]) report.push({ name: p.manifest.name, version: p.manifest.version, description: p.manifest.description, status: p.error ? 'invalid' : 'available', error: p.error, dir: p.dir, secrets: p.manifest.secrets ?? [] });
  for (const [name, entry] of Object.entries(enabled)) {
    const p = found.get(name); if (!p || p.error) { report.push({ name, status: p ? 'invalid' : 'missing', error: p?.error ?? 'The plugin folder is not there any more', provides: [] }); continue; }
    const base = { name, version: p.manifest.version, description: p.manifest.description, dir: p.dir, secrets: p.manifest.secrets, provides: [] };
    if (entry.sha !== p.sha) { report.push({ ...base, status: 'changed', error: 'The plugin files changed since you enabled it. Review them, then run: agent-factory plugin enable ' + name }); continue; }
    const provided = []; try {
      const mod = await import(`${pathToFileURL(path.join(p.dir, p.manifest.main)).href}?v=${p.sha.slice(0, 12)}`); if (typeof mod.register !== 'function') throw new Error('the plugin must export register(api)');
      await mod.register(makeApi({ manifest: p.manifest, config: entry.config, env, log, provided })); report.push({ ...base, status: 'loaded', provides: provided });
    } catch (e) { report.push({ ...base, status: 'error', error: String(e.message ?? e).slice(0, 300), provides: provided }); }
  }
  return report.sort((a, b) => a.name.localeCompare(b.name));
}

export function enablePlugin(configDir, dirs, name, config = undefined) {
  const p = discover(dirs).find((x) => x.manifest.name === name); if (!p) throw bad(`No plugin named ${name} in ${dirs.join(', ')}`); if (p.error) throw bad(p.error);
  const enabled = readEnabled(configDir); enabled[name] = { sha: p.sha, ...(config !== undefined ? { config } : enabled[name]?.config ? { config: enabled[name].config } : {}) }; writeEnabled(configDir, enabled); return { name, version: p.manifest.version, sha: p.sha, secrets: p.manifest.secrets };
}
export function disablePlugin(configDir, name) { const enabled = readEnabled(configDir); if (!enabled[name]) throw bad(`${name} is not enabled`); delete enabled[name]; writeEnabled(configDir, enabled); return { name, enabled: false }; }
