// The reviewer role: a second agent run that reads the builder's change and returns a verdict, before a pull request is opened.
// It runs on a COPY of the workspace, so even a misbehaving reviewer cannot alter the change it is judging.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './util.mjs';
import { extractJson } from './pack.mjs';

const SEVERITIES = ['blocker', 'major', 'minor'];
const clip = (v, n) => String(v ?? '').replace(/\u0000/g, '').slice(0, n);

export function reviewPrompt({ rules, skills = '', ticket, diff, context = '' }) {
  return [rules, skills ? `\n${skills}` : '', context ? `\n## Project context (data)\n${context.slice(0, 6000)}` : '',
    `\n# Ticket #${ticket.id}: ${ticket.title}\n\n${clip(ticket.body, 4000)}`, `\n# The change (git diff)\n\`\`\`diff\n${diff}\n\`\`\``].join('\n');
}

// Anything the reviewer returns is untrusted: keep only known fields, bound them, and never treat an unreadable answer as approval.
export function parseVerdict(out) {
  const raw = extractJson(out);
  if (!raw || typeof raw !== 'object') return { verdict: 'error', summary: 'The reviewer did not return a verdict in the expected format.', findings: [] };
  const findings = (Array.isArray(raw.findings) ? raw.findings : []).slice(0, 20).map((f) => ({ severity: SEVERITIES.includes(f?.severity) ? f.severity : 'minor', file: clip(f?.file, 160).replace(/[^\w./@+()-]/g, ''), line: Number.isInteger(f?.line) && f.line > 0 ? f.line : undefined, issue: clip(f?.issue, 400).trim(), fix: clip(f?.fix, 300).trim() })).filter((f) => f.issue);
  const blocking = findings.some((f) => f.severity === 'blocker' || f.severity === 'major');
  // The verdict must agree with the findings: "approve" with a blocker in it is "changes"; "changes" with only minor notes is "approve".
  const verdict = raw.verdict === 'approve' || raw.verdict === 'changes' ? (blocking ? 'changes' : 'approve') : 'error';
  return { verdict, summary: clip(raw.summary, 400).trim(), findings };
}

export const feedbackFromReview = (rv) => `A reviewer agent read your change and asked for changes:\n${rv.summary}\n${rv.findings.filter((f) => f.severity !== 'minor').map((f) => `- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} ${f.issue}${f.fix ? ` (suggested: ${f.fix})` : ''}`).join('\n')}\nAddress the blocking points, keep the rest of the change as it is.`;

// The staged diff of a workspace (new files included), bounded.
export async function changeDiff(dir, max = 60_000) {
  await run('git', ['add', '-A'], { cwd: dir });
  const r = await run('git', ['diff', '--cached', '--no-color', '--stat', '-p'], { cwd: dir });
  return r.out.length > max ? `${r.out.slice(0, max)}\n…(diff truncated at ${max} characters; read the files for the rest)` : r.out;
}

// A throwaway copy for the reviewer (dependencies and build output left out).
export function copyWorkspace(ws) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-review-'));
  fs.cpSync(ws.dir, dir, { recursive: true, filter: (src) => !/(^|\/)(node_modules|\.venv|venv|dist|build|target|\.next)(\/|$)/.test(path.relative(ws.dir, src)) });
  return { ...ws, dir, destroy: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } };
}
