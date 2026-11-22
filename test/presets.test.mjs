import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { callOp } from '../src/ops.mjs';
import { normalizePreset, BUILTIN } from '../src/presets.mjs';

function boot(kind = 'codexContainer') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-'));
  const cfg = withDefaults({ stateDir: path.join(root, 'state'), agent: { kind, ...(kind === 'codexContainer' ? { codexHome: path.join(root, 'cx'), model: 'm-astra', reasoningEffort: 'high' } : {}) }, sandbox: { kind: 'local' }, projects: ['a', 'b', 'c'].map((id) => ({ id, repo: `me/${id}`, base: 'main', tickets: { kind: 'file', path: path.join(root, 't.json') } })) });
  return new Engine(cfg, { configPath: path.join(root, 'c.json'), factories: {} });
}

test('the built-in setups: lean, standard (recommended) and thorough, naming no model so they work on any login', async () => {
  const e = boot(); const l = await callOp(e, 'list_setups', {}); assert.deepEqual(l.presets.map((p) => p.name).sort(), ['lean', 'standard', 'thorough']); assert.ok(l.presets.every((p) => p.builtin && p.evidence));
  for (const p of Object.values(BUILTIN)) { assert.ok(!JSON.stringify(p).match(/gpt|claude|model/i) || !p.agent?.model, 'no hard-coded model'); assert.ok(!('autonomy' in p), 'autonomous merging is never part of a setup'); }
  assert.equal(l.active, null); assert.equal(l.newProject, null);
});

test('applying a setup sets the default effort and the roles\' models, replaces earlier role choices, and can switch optional roles on for chosen projects only', async () => {
  const e = boot(); await callOp(e, 'set_roles', { roles: { reviewer: { agent: { model: 'old-model' } } } });
  const r = await callOp(e, 'apply_setup', { name: 'thorough', projects: ['a', 'b'] }); assert.equal(e.cfg.agent.reasoningEffort, 'low'); assert.equal(e.cfg.agent.model, 'm-astra', 'model untouched when the setup names none');
  assert.equal(e.cfg.roles.designer.agent.reasoningEffort, 'medium'); assert.equal(e.cfg.roles.planner.agent.reasoningEffort, 'medium'); assert.equal(e.cfg.roles.reviewer?.agent, undefined, 'the earlier reviewer model choice was replaced');
  assert.deepEqual(Object.keys(e.project('a').roles).sort(), ['reviewer', 'security', 'spec-writer', 'tester']); assert.equal(e.project('b').roles.tester.enabled, true); assert.equal(e.project('c').roles, undefined, 'a project not named is untouched');
  assert.equal(r.active, 'thorough'); assert.deepEqual(r.projects, ['a', 'b']);
  await callOp(e, 'apply_setup', { name: 'lean', projects: 'all' }); assert.equal(e.project('c').roles.reviewer.enabled, true); assert.equal(e.project('c').roles.security.enabled, false); assert.equal(e.cfg.roles.designer?.agent, undefined, 'lean names no role models, so the designer override is cleared');
});

test('new projects start with the default setup\'s optional roles; the choice persists and can be cleared', async () => {
  const e = boot(); await callOp(e, 'apply_setup', { name: 'standard', makeDefault: true }); assert.equal((await callOp(e, 'list_setups', {})).newProject, 'standard');
  const p = await e.addProject({ id: 'fresh', repo: 'local/fresh', host: { kind: 'local' } }); assert.deepEqual(Object.fromEntries(Object.entries(p.roles).map(([k, v]) => [k, v.enabled])), { reviewer: true, security: true, tester: true, 'spec-writer': true });
  assert.equal(e.project('a').roles, undefined, 'existing projects are not changed by the default');
  await callOp(e, 'set_new_project_setup', { name: 'lean' }); const q = await e.addProject({ id: 'fresh2', repo: 'local/fresh2', host: { kind: 'local' } }); assert.equal(q.roles.security.enabled, false);
  await callOp(e, 'set_new_project_setup', { name: null }); const z = await e.addProject({ id: 'fresh3', repo: 'local/fresh3', host: { kind: 'local' } }); assert.equal(z.roles, undefined);
  await assert.rejects(() => callOp(e, 'set_new_project_setup', { name: 'nope' }), /No setup/);
});

test('custom setups: save the current setup, name models, apply, delete; built-ins and bad input are refused', async () => {
  const e = boot(); await callOp(e, 'set_roles', { roles: { reviewer: { agent: { model: 'astra-x', reasoningEffort: 'low' } } } });
  const s = await callOp(e, 'save_setup', { name: 'mine', label: 'My setup', fromCurrent: true, projectRoles: { reviewer: true } }); assert.equal(s.builtin, false); assert.equal(s.roles.reviewer.model, 'astra-x'); assert.equal(s.agent.model, 'm-astra'); assert.equal(e.cfg.presets.mine.label, 'My setup');
  const hand = await callOp(e, 'save_setup', { name: 'cheap-helpers', agent: { reasoningEffort: 'low' }, roles: { tester: { model: 'luna-x' }, 'spec-writer': { model: 'luna-x' } }, projectRoles: { reviewer: true, tester: true } }); assert.equal(hand.roles.tester.model, 'luna-x');
  await callOp(e, 'apply_setup', { name: 'cheap-helpers' }); assert.equal(e.cfg.roles.tester.agent.model, 'luna-x'); assert.equal(e.cfg.roles.reviewer?.agent, undefined);
  await assert.rejects(() => callOp(e, 'save_setup', { name: 'lean', fromCurrent: true }), /built-in/); await assert.rejects(() => callOp(e, 'delete_setup', { name: 'standard' }), /built-in/);
  for (const bad of [{ name: 'x', roles: { wizard: {} } }, { name: 'x', projectRoles: { builder: true } }, { name: 'x', projectRoles: { reviewer: 'yes' } }, { name: 'x', agent: { kind: 'shell' } }, { name: 'x', agent: { model: '--bad' } }, { name: 'x', agent: { reasoningEffort: 'turbo' } }, { name: 'Bad Name' }, { name: 'x', autonomy: { mode: 'merge' } }]) await assert.rejects(() => callOp(e, 'save_setup', bad), /Unknown role|can switch|must be|cannot be set|valid model|one of|lowercase|not part of a setup|unknown argument/, JSON.stringify(bad));
  await callOp(e, 'apply_setup', { name: 'mine', makeDefault: true }); assert.deepEqual(await callOp(e, 'delete_setup', { name: 'mine' }), { deleted: true }); const l = await callOp(e, 'list_setups', {}); assert.equal(l.newProject, null); assert.equal(l.active, null, 'deleting the applied or default setup clears the pointer');
});

test('an unknown project id refuses the whole apply, and an agent type with no model setting just skips those keys', async () => {
  const e = boot(); await assert.rejects(() => callOp(e, 'apply_setup', { name: 'standard', projects: ['a', 'ghost'] }), /No such project/); assert.equal(e.cfg.agent.reasoningEffort, 'high', 'nothing changed');
  const shell = boot('shell'); const r = await callOp(shell, 'apply_setup', { name: 'thorough', projects: 'all' }); assert.equal(r.applied, 'thorough'); assert.equal(shell.project('a').roles.reviewer.enabled, true, 'the per-project part still applies'); assert.equal(shell.cfg.agent.reasoningEffort, undefined);
});
