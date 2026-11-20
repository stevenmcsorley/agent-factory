import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectVerify } from '../src/repoconfig.mjs';

const repo = (files) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'py-')); for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); } return d; };

test('Python: pytest is installed alongside the requirements (many files leave it out), and only when there are tests to run', () => {
  assert.deepEqual(detectVerify(repo({ 'requirements.txt': 'fastapi\n', 'tests/test_a.py': 'def test_a(): pass\n' })), { verify: 'pip install -q -r requirements.txt pytest && python -m pytest -q', image: 'python:3.12-bookworm' });
  assert.deepEqual(detectVerify(repo({ 'pyproject.toml': '[project]\nname="x"\n', 'pytest.ini': '[pytest]\n' })), { verify: 'pip install -q pytest && python -m pytest -q', image: 'python:3.12-bookworm' });
  assert.equal(detectVerify(repo({ 'requirements.txt': 'fastapi\n', 'app/main.py': 'x = 1\n' })), null, 'no tests: a verify command that always fails would block every run, so there is none');
  assert.ok(detectVerify(repo({ 'requirements.txt': 'x\n', 'pkg/sub/thing_test.py': '' })), 'a *_test.py file counts'); assert.ok(detectVerify(repo({ 'setup.py': '', 'test/test_x.py': '' })), 'a test/ folder counts');
  assert.equal(detectVerify(repo({ 'requirements.txt': 'x\n', 'node_modules/tests/a.py': '', 'venv/tests/b.py': '' })), null, 'dependency folders are not the project\'s tests');
});
