#!/usr/bin/env node
// Runs the test suite with its OWN temporary folder, deleted afterwards. The tests create many throwaway repositories and state folders in the OS temp directory and
// (until this runner) never removed them: a few dozen runs left tens of thousands of folders behind. Everything the tests make goes under one folder that is removed on exit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-tests-'));
const files = fs.readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join('test', f));
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
let code = 1;
try {
  const r = spawnSync(process.execPath, ['--test', '--test-force-exit', ...(only.length ? only : files)], { cwd: root, stdio: 'inherit', env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp } });
  code = r.status ?? 1;
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
process.exit(code);
