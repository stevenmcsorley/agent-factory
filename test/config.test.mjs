import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withDefaults, validateConfig, loadConfig, saveConfig, loadSecrets, EGRESS_DEFAULTS } from '../src/config.mjs';
import { doctor } from '../src/doctor.mjs';

const good = () => withDefaults({ agent: { kind: 'codexContainer', codexHome: '/x' }, projects: [{ id: 'app', repo: 'me/app', tickets: { kind: 'github', allowedAuthors: ['me'] } }] });

test('defaults fill in sandbox, limits, ui and the agent-specific egress allowlist', () => {
  const c = good();
  assert.deepEqual(c.sandbox.egress.allow, [...EGRESS_DEFAULTS.codexContainer, 'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org']);
  assert.ok(!c.sandbox.egress.allow.includes('github.com'), 'package registries only: no code hosts and no wildcard');
  assert.equal(c.ui.host, '127.0.0.1'); assert.equal(c.limits.maxRunsPerDay, 20);
  assert.deepEqual(validateConfig(c), []);
});

test('validation enforces the security boundaries', () => {
  const c = good();
  assert.match(validateConfig({ ...c, agent: { kind: 'codexContainer' } }).join(), /codexHome/);
  assert.match(validateConfig({ ...c, agent: { kind: 'claude' } }).join(), /without isolation/);
  assert.deepEqual(validateConfig({ ...c, agent: { kind: 'claude', allowHostAgent: true } }), []);
  assert.match(validateConfig({ ...c, ui: { ...c.ui, host: '0.0.0.0' } }).join(), /loopback/);
  assert.deepEqual(validateConfig({ ...c, ui: { ...c.ui, host: '0.0.0.0', allowRemote: true } }), []);
  const p = (x) => ({ ...c, projects: [{ ...c.projects[0], ...x }] });
  assert.match(validateConfig(p({ tickets: { kind: 'github', allowedAuthors: [] } })).join(), /allowedAuthors/);
  assert.match(validateConfig(p({ repo: 'not a repo' })).join(), /owner\/name/);
  assert.match(validateConfig(p({ id: 'Bad ID!' })).join(), /must match/);
  assert.match(validateConfig({ ...c, projects: [c.projects[0], c.projects[0]] }).join(), /duplicate/);
  assert.match(validateConfig(p({ tickets: { kind: 'ossicone', baseUrl: 'https://x', projectId: 1, allowedReporterIds: [1] } })).join(), /feedbackAuthors/);
});

test('save/load round-trips, resolves stateDir, writes owner-only', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')); const f = path.join(d, 'agent-factory.json');
  saveConfig(f, { ...good(), stateDir: path.join(d, 'state') });
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  const c = loadConfig(f); assert.equal(c.stateDir, path.join(d, 'state')); assert.equal(c.projects[0].repo, 'me/app');
});

test('secrets file: KEY=VALUE, comments and quotes handled', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sec-')), 'secrets.env');
  fs.writeFileSync(f, '# c\nA=1\nB="two words"\n  C = x \nnot valid\n');
  assert.deepEqual(loadSecrets(f), { A: '1', B: 'two words', C: 'x' });
  assert.deepEqual(loadSecrets('/nonexistent'), {});
});

test('doctor reports each prerequisite with a fix hint, using injected exec', async () => {
  const exec = async (cmd, args) => (cmd === 'docker' && args[0] === 'info' ? { code: 1, out: '' } : cmd === 'gh' ? { code: 0, out: 'ok' } : { code: 0, out: 'git version 2' });
  const d = await doctor({ ...good(), stateDir: os.tmpdir() }, { exec, env: {} });
  const by = Object.fromEntries(d.map((c) => [c.id, c]));
  assert.equal(by.docker.ok, false); assert.match(by.docker.fix, /Docker/);
  assert.equal(by.github.ok, true); assert.equal(by['agent-auth'].ok, false); assert.match(by['agent-auth'].fix, /codex login/);
  assert.equal(by.config.ok, true);
});

import { execFileSync } from 'node:child_process';
test('CLI `service` prints a systemd unit for the given config, and `help` lists every command', () => {
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'cli.mjs');
  const out = execFileSync(process.execPath, [cli, 'service', '--config=/srv/factory/agent-factory.json']).toString();
  assert.match(out, /\[Service\]/); assert.match(out, /WorkingDirectory=\/srv\/factory/); assert.match(out, /ExecStart=.*cli\.mjs start --config=\/srv\/factory\/agent-factory\.json/); assert.match(out, /Restart=on-failure/);
  const help = execFileSync(process.execPath, [cli, 'help']).toString(); for (const c of ['init', 'start', 'doctor', 'add', 'service', 'token']) assert.match(help, new RegExp(`\\b${c}\\b`));
});

test('a second factory instance can name its own egress proxy and network; odd names are refused', () => {
  const base = { agent: { kind: 'shell' }, ui: { host: '127.0.0.1' }, sandbox: { kind: 'docker', egress: { allow: ['x.test'], name: 'factory-egress-showcase', network: 'factory-agents-showcase' } }, projects: [] };
  assert.deepEqual(validateConfig(base), []);
  assert.match(validateConfig({ ...base, sandbox: { ...base.sandbox, egress: { allow: [], name: 'bad name; rm' } } }).join(), /sandbox\.egress\.name/);
});
