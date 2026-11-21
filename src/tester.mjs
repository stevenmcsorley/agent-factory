// The tester role: when the builder changed source code but added no tests, a second agent writes them.
// Guard rails, because it works on the builder's uncommitted change: it may only ADD or CHANGE test files (anything else it touches is reverted),
// the whole test command must still pass, and if either rule fails everything it did is undone so the builder's change is exactly as it was.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './util.mjs';
import { isTestPath } from './quality.mjs';

const CODE = /\.(js|mjs|cjs|jsx|ts|tsx|py|go|rs|java|kt|rb|php|cs|swift|c|cc|cpp|h|hpp)$/i;
const paths = (porcelain) => String(porcelain ?? '').split('\n').filter(Boolean).map((l) => l.replace(/^\s*\S+\s+/, '').trim().replace(/^"|"$/g, '').split(' -> ').pop());

// -> the changed source files that have no test change alongside them, or null when nothing needs tests.
export function needsTests(porcelain) {
  const files = paths(porcelain); const src = files.filter((f) => CODE.test(f) && !isTestPath(f)); const tests = files.filter((f) => isTestPath(f));
  return src.length && !tests.length ? src : null;
}
export const testerPrompt = ({ rules, skills = '', ticket, files, diff }) => [rules, skills ? `\n${skills}` : '', `\n# Ticket #${ticket.id}: ${ticket.title}\n${String(ticket.body ?? '').slice(0, 3000)}`,
  `\n# Source files the builder changed (they have no tests yet)\n${files.map((f) => `- ${f}`).join('\n')}`, `\n# The change (git diff)\n\`\`\`diff\n${diff}\n\`\`\``].join('\n');

const git = (ws, args, opts) => run('git', args, { cwd: ws.dir, ...opts });
// Everything the tester did, measured against the state before it ran.
export async function snapshot(ws) { await git(ws, ['add', '-A']); const patch = (await git(ws, ['diff', '--cached', '--binary', '--no-color'])).out; const f = path.join(os.tmpdir(), `factory-tester-${process.pid}-${Date.now()}.patch`); fs.writeFileSync(f, patch); return { patch: f, files: new Set(paths((await git(ws, ['status', '--porcelain'])).out)) }; }
export async function restore(ws, snap) { await git(ws, ['reset', '-q', '--hard', 'HEAD']); await git(ws, ['clean', '-fdq']); if (fs.statSync(snap.patch).size) await git(ws, ['apply', '--binary', snap.patch]); }
export const dropSnapshot = (snap) => { try { fs.rmSync(snap.patch, { force: true }); } catch { /* best effort */ } };
// Files the tester touched that it was not allowed to: anything outside test paths.
export async function forbiddenChanges(ws, snap, before) {
  const now = await git(ws, ['status', '--porcelain']); const nowFiles = paths(now.out); const bad = [];
  for (const f of nowFiles) { if (isTestPath(f)) continue; const hadIt = snap.files.has(f); if (!hadIt) { bad.push(f); continue; }
    const cur = (await git(ws, ['hash-object', f])).out.trim(); if (before.get(f) !== cur) bad.push(f); }
  return bad;
}
export async function hashes(ws, files) { const m = new Map(); for (const f of files) { try { m.set(f, (await git(ws, ['hash-object', f])).out.trim()); } catch { /* deleted */ } } return m; }
