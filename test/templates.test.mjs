import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { candidates, boilerplateOf, isBoilerplate } from '../src/library.mjs';
import { codeMetrics } from '../src/analyze.mjs';

const installer = (app, title) => `#!/usr/bin/env bash
set -euo pipefail
APP=${app}
PREFIX="\${PREFIX:-/usr/local}"
echo "Installing ${title} to $PREFIX"
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required" >&2
  exit 1
fi
python3 -m pip install --user --upgrade pip
python3 -m pip install --user -r requirements.txt
install -d "$PREFIX/share/${app}"
cp -r src/* "$PREFIX/share/${app}/"
install -m 755 bin/${app} "$PREFIX/bin/${app}"
install -Dm 644 packaging/io.github.example.${title}.desktop "$PREFIX/share/applications/${app}.desktop"
update-desktop-database "$PREFIX/share/applications" >/dev/null 2>&1 || true
echo "Done. Run ${app} from your menu."
`;
const unrelated = `#!/bin/sh
# nightly database backup
set -e
STAMP=$(date +%F)
pg_dump "$DATABASE_URL" | gzip > "/backups/db-$STAMP.sql.gz"
find /backups -name 'db-*.sql.gz' -mtime +14 -delete
aws s3 sync /backups s3://example-bucket/db --only-show-errors
curl -fsS -m 10 "$HEALTHCHECK_URL" >/dev/null
echo "backup finished at $(date)"
`;
const fp = (file, text) => boilerplateOf(file, text, text.split('\n').filter((l) => l.trim()).length);
const sigs = (project, file, text) => ({ project, ...fp(file, text) });

test('which files count as templates: scripts, packaging, CI and container files, not source code or the licence', () => {
  for (const f of ['install.sh', 'packaging/build-deb.sh', 'packaging/control', 'packaging/App.desktop', 'Dockerfile', 'docker/Dockerfile.api', 'docker-compose.yml', '.github/workflows/ci.yml', 'tsconfig.json', 'vite.config.ts', 'nginx.conf', 'Makefile']) assert.ok(isBoilerplate(f), f);
  for (const f of ['src/app.ts', 'README.md', 'LICENSE', 'package.json', 'docs/guide.sh.md', 'src/install.shx']) assert.ok(!isBoilerplate(f), f);
  assert.equal(boilerplateOf('install.sh', 'echo hi\n', 1), null, 'tiny files are noise');
});

test('the same installer written per app is found across projects; an unrelated script with the same name is not; templates are never mixed with code', () => {
  const items = { rampilot: [sigs('rampilot', 'install.sh', installer('rampilot', 'RAMPilot'))], envlens: [sigs('envlens', 'install.sh', installer('envlens', 'EnvLens'))], netatlas: [sigs('netatlas', 'install.sh', installer('netatlas', 'NetAtlas'))], backups: [sigs('backups', 'install.sh', unrelated)] };
  for (const l of Object.values(items)) delete l[0].project;
  const found = candidates(items).filter((c) => c.projects.length > 1);
  assert.equal(found.length, 1); assert.deepEqual(found[0].projects.sort(), ['envlens', 'netatlas', 'rampilot']); assert.equal(found[0].template, true); assert.match(found[0].reason, /same template file in 3 projects/); assert.ok(!found[0].projects.includes('backups'));
  // a code file with similar words must not join a template group
  const code = { file: 'src/install.py', lines: 20, exports: ['install'], sig: items.rampilot[0].sig };
  assert.equal(candidates({ a: items.rampilot, b: [code] }).filter((c) => c.projects.length > 1).length, 0);
  // same file in the same project is not a cross-project template
  assert.equal(candidates({ a: [items.rampilot[0], { ...items.envlens[0], file: 'tools/install.sh' }] }).length, 0);
});

test('analysis records template fingerprints next to code fingerprints (capped), without reading outside the repo', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-')); fs.mkdirSync(path.join(d, 'packaging'), { recursive: true }); fs.mkdirSync(path.join(d, 'src'), { recursive: true });
  fs.writeFileSync(path.join(d, 'install.sh'), installer('thing', 'Thing')); fs.writeFileSync(path.join(d, 'packaging/build-deb.sh'), installer('thing', 'Thing').replace('install ', 'build ')); fs.writeFileSync(path.join(d, 'LICENSE'), 'MIT\n'.repeat(30));
  fs.writeFileSync(path.join(d, 'src/app.js'), Array.from({ length: 30 }, (_, i) => `export function f${i}(a, b) { return a * ${i} + b; }`).join('\n'));
  const m = codeMetrics(d); const prints = m._prints; assert.deepEqual(prints.filter((p) => p.kind === 'boilerplate').map((p) => p.file).sort(), ['install.sh', 'packaging/build-deb.sh']); assert.ok(prints.some((p) => p.file === 'src/app.js' && !p.kind), 'code fingerprints are unchanged');
  for (let i = 0; i < 120; i++) fs.writeFileSync(path.join(d, `s${i}.sh`), installer(`app${i}`, `App${i}`)); assert.ok(codeMetrics(d)._prints.filter((p) => p.kind === 'boilerplate').length <= 80, 'templates are capped per project');
});
