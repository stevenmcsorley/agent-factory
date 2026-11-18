// The files a brand-new reuse library starts with: how it works, and a CI check that every part is well-formed and its tests pass.
export const LIBRARY_README = (name) => `# ${name}

A catalog of reusable parts (components, hooks, utilities, services, schemas) managed by [Agent Factory](https://github.com/stevenmcsorley/agent-factory).

\`\`\`
parts/<slug>/part.json   name, kind, summary, tags, stack, version, exports, files, usage, origin, changelog
parts/<slug>/README.md   generated from part.json
parts/<slug>/src/        the part's source (copied into projects, with a \`factory-part:\` header)
parts/<slug>/test/       its tests
\`\`\`

* **Add a part**: promote repeated code from any project in the factory's Library page (or \`agent-factory library promote\`). It opens a pull request here. Review and merge it.
* **Use a part**: when a ticket matches a part, the factory tells the agent about it and the agent copies the files into the project. The factory records the version in the project's \`.factory/parts.lock.json\`.
* **Change a part**: edit it here and bump \`version\` (semver). The factory opens upgrade tickets in the projects that use the old version.
* **CI** (\`scripts/check-parts.mjs\`) checks every \`part.json\` and runs each part's tests.
`;
export const PARTS_WORKFLOW = `name: parts
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: node scripts/check-parts.mjs
`;
export const CHECK_PARTS = `// Validates every part and runs the tests of JavaScript parts (zero dependencies). Run: node scripts/check-parts.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.join(process.cwd(), 'parts'); let failed = 0;
const fail = (slug, msg) => { failed++; console.error('FAIL ' + slug + ': ' + msg); };
for (const slug of fs.existsSync(root) ? fs.readdirSync(root) : []) {
  const dir = path.join(root, slug); if (!fs.statSync(dir).isDirectory()) continue;
  let meta; try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'part.json'), 'utf8')); } catch (e) { fail(slug, 'part.json is missing or not valid JSON'); continue; }
  if (!meta.name) fail(slug, 'missing name'); if (!/^\\d+\\.\\d+\\.\\d+$/.test(meta.version ?? '')) fail(slug, 'version must be semver (1.2.3)');
  const files = meta.files ?? []; for (const f of files) { if (f.path.includes('..') || !fs.existsSync(path.join(dir, f.path))) fail(slug, 'missing file ' + f.path); }
  const tests = files.filter((f) => f.role === 'test' && /\\.(m?js|cjs)$/.test(f.path)).map((f) => f.path);
  if (tests.length) { const r = spawnSync(process.execPath, ['--test', ...tests], { cwd: dir, encoding: 'utf8' }); if (r.status !== 0) fail(slug, 'tests failed\\n' + (r.stdout + r.stderr).slice(-800)); else console.log('ok   ' + slug + ' (' + tests.length + ' test file' + (tests.length > 1 ? 's' : '') + ')'); }
  else console.log('ok   ' + slug + ' (no tests)');
}
if (failed) { console.error(failed + ' problem' + (failed > 1 ? 's' : '')); process.exit(1); }
`;
