import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, feedbackFromReview, reviewPrompt } from '../src/review.mjs';
import * as sk from '../src/skills.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('a verdict is only trusted when it agrees with its findings', () => {
  assert.equal(parseVerdict('{"verdict":"approve","summary":"ok","findings":[]}').verdict, 'approve');
  assert.equal(parseVerdict('```json\n{"verdict":"approve","findings":[{"severity":"blocker","issue":"SQL built from input"}]}\n```').verdict, 'changes');
  assert.equal(parseVerdict('{"verdict":"changes","findings":[{"severity":"minor","issue":"naming"}]}').verdict, 'approve');
  assert.equal(parseVerdict('looks fine to me!').verdict, 'error');   // never approval by default
  assert.equal(parseVerdict('{"verdict":"yes"}').verdict, 'error');
  const f = parseVerdict(JSON.stringify({ verdict: 'changes', findings: [{ severity: 'major', file: '../../etc/x y', line: -3, issue: 'x'.repeat(900) }] })).findings[0];
  assert.equal(f.line, undefined); assert.ok(f.issue.length <= 400); assert.doesNotMatch(f.file, /\s/);
});

test('review feedback lists only the points that block, and the prompt carries ticket and diff', () => {
  const rv = parseVerdict('{"verdict":"changes","summary":"Missing validation","findings":[{"severity":"major","file":"a.js","line":4,"issue":"no check","fix":"add one"},{"severity":"minor","file":"b.js","issue":"typo"}]}');
  const fb = feedbackFromReview(rv); assert.match(fb, /a\.js:4 no check/); assert.doesNotMatch(fb, /typo/);
  assert.match(reviewPrompt({ rules: 'R', ticket: { id: 7, title: 'T', body: 'B' }, diff: '+x' }), /Ticket #7: T[\s\S]*\+x/);
});

test('skills: built-ins list, an override replaces one, deleting restores it, and role/project filters apply', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-'));
  assert.ok(sk.listSkills(dir).some((s) => s.name === 'code-review' && s.builtin && !s.overridden));
  assert.match(sk.skillsFor(dir, { role: 'reviewer', project: 'a' }).text, /code-review/);
  assert.doesNotMatch(sk.skillsFor(dir, { role: 'reviewer', project: 'a' }).text, /### Skills[\s\S]*bugfix:/);   // builder-only skill is not given to the reviewer
  sk.saveSkill(dir, { name: 'code-review', description: 'mine', roles: 'reviewer', body: 'Only check security.' });
  assert.equal(sk.getSkill(dir, 'code-review').overridden, true); assert.match(sk.skillsFor(dir, { role: 'reviewer', project: 'a' }).text, /Only check security/);
  assert.deepEqual(sk.deleteSkill(dir, 'code-review'), { removed: true, restoredBuiltin: true });
  assert.match(sk.getSkill(dir, 'code-review').body, /two separate axes/);
  sk.saveSkill(dir, { name: 'only-b', roles: 'builder', projects: 'b', body: 'Special rules for project b.' });
  assert.doesNotMatch(sk.skillsFor(dir, { role: 'builder', project: 'a' }).text, /only-b/); assert.match(sk.skillsFor(dir, { role: 'builder', project: 'b' }).text, /only-b/);
  assert.throws(() => sk.saveSkill(dir, { name: '../x', body: 'long enough text' }), /lowercase/);
  assert.throws(() => sk.saveSkill(dir, { name: 'ok', roles: 'wizard', body: 'long enough text' }), /Unknown role/);
  assert.throws(() => sk.saveSkill(dir, { name: 'ok', body: 'text\n---\nmore text here' }), /header/);
  assert.throws(() => sk.deleteSkill(dir, 'bugfix'), /built-in/);
});

import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { callOp } from '../src/ops.mjs';
function boot(agent) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));
  const cfg = withDefaults({ stateDir: path.join(root, 'state'), agent: { kind: 'codexContainer', codexHome: path.join(root, 'cx') }, sandbox: { kind: 'local' }, projects: [{ id: 'a', repo: 'me/a', base: 'main', tickets: { kind: 'file', path: path.join(root, 't.json') } }] });
  return new Engine(cfg, { configPath: path.join(root, 'c.json'), factories: agent ? { agent } : {} });
}

test('roles over MCP: reviewer on/off globally and per project, its own model, refusals for the rest', async () => {
  const e = boot();
  assert.equal((await callOp(e, 'get_roles', {})).roles.reviewer.enabled, false);
  assert.equal(e._roleOn(e.project('a'), 'reviewer'), false);
  await callOp(e, 'set_roles', { roles: { reviewer: { enabled: true, agent: { model: 'gpt-5.4', reasoningEffort: 'high' } } } });
  assert.equal(e._roleOn(e.project('a'), 'reviewer'), true); assert.equal(e.roles().roles.reviewer.agent.model, 'gpt-5.4');
  await callOp(e, 'set_project_roles', { project: 'a', roles: { reviewer: { enabled: false } } }); assert.equal(e._roleOn(e.project('a'), 'reviewer'), false);
  await callOp(e, 'set_project_roles', { project: 'a', roles: { reviewer: null } }); assert.equal(e._roleOn(e.project('a'), 'reviewer'), true);
  await assert.rejects(() => callOp(e, 'set_roles', { roles: { builder: { enabled: false } } }), /cannot be switched off/);
  await assert.rejects(() => callOp(e, 'set_roles', { roles: { wizard: {} } }), /Unknown role/);
  await assert.rejects(() => callOp(e, 'set_roles', { roles: { reviewer: { agent: { model: '--bad' } } } }), /model/);
  assert.equal(e._agentFor('reviewer').name !== undefined, true);   // builds without a real login
});

test('skills over MCP: save, preview what a role receives, draft with the skill-writer agent, delete', async () => {
  const draft = '---\nname: ignored\ndescription: Keep migrations safe\nroles: builder\nprojects: all\n---\nNever drop a column in the same release that stops using it.\nAdd the new column first.';
  const e = boot({ name: 'fake', run: async (_sb, ws, prompt) => { assert.match(prompt, /Request \(data\)/); assert.match(prompt, /skill-writing|one job per skill/i); return { out: draft, code: 0 }; } });
  assert.ok((await callOp(e, 'list_skills', {})).skills.some((s) => s.name === 'bugfix'));
  await callOp(e, 'save_skill', { name: 'house-style', roles: 'builder', body: 'Use tabs, never spaces, in this repo.' });
  assert.match((await callOp(e, 'preview_skills', { role: 'builder', project: 'a' })).text, /house-style[\s\S]*tabs/);
  const job = await callOp(e, 'draft_skill', { request: 'Help agents write safe database migrations', name: 'safe-migrations' });
  let r; for (let i = 0; i < 50; i++) { r = await callOp(e, 'get_skill_draft', { id: job.id }); if (r.state !== 'running') break; await new Promise((x) => setTimeout(x, 20)); }
  assert.equal(r.state, 'done', JSON.stringify(r)); assert.equal(r.draft.name, 'safe-migrations'); assert.deepEqual(r.draft.roles, ['builder']);
  assert.throws(() => e.getSkill('safe-migrations'), /No skill/, 'a draft is never saved on its own');
  await callOp(e, 'save_skill', r.draft); assert.equal(e.getSkill('safe-migrations').description, 'Keep migrations safe');
  await callOp(e, 'delete_skill', { name: 'house-style' }); assert.throws(() => e.getSkill('house-style'), /No skill/);
  await assert.rejects(() => callOp(e, 'draft_skill', { request: 'short' }), /Describe/);
});

import { combineReviews } from '../src/review.mjs';
test('combined reviews: any changes wins, an error is never an approval, findings keep their source', () => {
  const ok = { role: 'reviewer', verdict: 'approve', summary: 'fine', findings: [] }; const sec = { role: 'security', verdict: 'changes', summary: 'injection', findings: [{ severity: 'blocker', issue: 'sql' }] };
  assert.equal(combineReviews([ok, sec]).verdict, 'changes'); assert.equal(combineReviews([ok, sec]).findings[0].source, 'security');
  assert.equal(combineReviews([ok, { role: 'security', verdict: 'error', summary: 'timed out', findings: [] }]).verdict, 'error');
  assert.equal(combineReviews([ok, { ...ok, role: 'security' }]).verdict, 'approve'); assert.equal(combineReviews([ok]).verdict, 'approve');
  assert.deepEqual(combineReviews([ok, sec]).passes, [{ role: 'reviewer', verdict: 'approve' }, { role: 'security', verdict: 'changes' }]);
});
test('every built-in skill has a source line and goes to at least one real role', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-')); for (const s of sk.listSkills(dir)) { assert.ok(s.source, `${s.name} has no source`); assert.ok(s.roles.every((r) => sk.ROLE_NAMES.includes(r)), `${s.name} names an unknown role`); assert.ok(s.body.length < 1500, `${s.name} is too long to be read`); }
  for (const role of ['builder', 'fixer', 'reviewer', 'security', 'designer', 'planner', 'spec-writer', 'skill-writer']) assert.ok(sk.skillsFor(dir, { role, project: 'a' }).names.length > 0, `${role} gets no skills`);
  assert.ok(sk.skillsFor(dir, { role: 'builder', project: 'a' }).text.length < 6000);
});
