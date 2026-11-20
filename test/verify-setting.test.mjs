import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { effectiveConfig } from '../src/factory.mjs';

const world = async () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-')); const e = new Engine(withDefaults({ stateDir: path.join(root, 's'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [] }), { configPath: path.join(root, 'c.json'), env: {}, factories: {} }); await e.addProject({ repo: 'app', id: 'app', host: { kind: 'local' } }); return { e, root }; };

test('setVerify stores the command and image on the project, shows them in the overview, and clearing restores detection', async () => {
  const { e } = await world(); assert.deepEqual(e.setVerify('app', { verify: '  pip install -q psutil && python -m unittest  ', image: 'python:3.12-bookworm' }), { verify: 'pip install -q psutil && python -m unittest', image: 'python:3.12-bookworm' });
  const ov = (await e.overview()).find((p) => p.id === 'app'); assert.deepEqual([ov.verify, ov.image], ['pip install -q psutil && python -m unittest', 'python:3.12-bookworm']); assert.deepEqual(e.cfg.projects[0].config, { verify: 'pip install -q psutil && python -m unittest', image: 'python:3.12-bookworm' });
  assert.deepEqual(e.setVerify('app', { image: '' }), { verify: 'pip install -q psutil && python -m unittest', image: null }, 'changing one field leaves the other'); assert.deepEqual(e.setVerify('app', { verify: '' }), { verify: null, image: null }); assert.equal(e.cfg.projects[0].config, undefined, 'nothing left over');
});

test('setVerify refuses anything that is not one command line or a plausible image name', async () => {
  const { e } = await world();
  for (const v of ['npm test\nrm -rf /', 'a\rb', 'x\0y']) assert.throws(() => e.setVerify('app', { verify: v }), /one line/); assert.throws(() => e.setVerify('app', { verify: 'x'.repeat(501) }), /too long/);
  for (const i of ['bad image', '-v /:/x', 'a;b', '../x', 'UPPER space']) assert.throws(() => e.setVerify('app', { image: i }), /container image/); assert.throws(() => e.setVerify('nope', { verify: 'x' }), /No such project/);
  assert.equal(e.setVerify('app', { image: 'ghcr.io/me/img:1.2@sha256-abc' }).image, 'ghcr.io/me/img:1.2@sha256-abc');
});

test('precedence at run time: the repository file beats the project setting, which beats detection', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-')); fs.writeFileSync(path.join(d, 'package.json'), '{"scripts":{"test":"x"}}');
  assert.match(effectiveConfig({}, d).verify, /npm/, 'detected'); assert.equal(effectiveConfig({ verify: 'make check' }, d).verify, 'make check', 'project setting');
  fs.writeFileSync(path.join(d, '.agent-factory.json'), '{"verify":"pytest"}'); assert.equal(effectiveConfig({ verify: 'make check' }, d).verify, 'pytest', 'repository file wins');
  const noDetect = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-')); assert.equal(effectiveConfig({ verify: 'ctest', image: 'gcc:13' }, noDetect).image, 'gcc:13');
});
