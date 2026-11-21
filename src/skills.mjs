// Skills: reusable, editable instructions an agent receives when it does a particular kind of work.
// A skill is one Markdown file with a small header:
//   ---
//   name: code-review
//   description: What this skill is for, in a sentence
//   roles: reviewer, builder        which agent roles receive it (any = all of them)
//   projects: all                   or a comma list of project ids
//   ---
//   ...the instructions...
// Built-in skills ship with the factory. Saving a skill with the same name writes an override under <state>/skills/, and deleting the override restores the built-in.
// Skill text is guidance about HOW to work. It is trusted like the factory's own prompt rules, because only the operator can edit it (UI, MCP with the UI token); it never carries ticket or repo content.
import fs from 'node:fs';
import path from 'node:path';

export const ROLE_NAMES = ['builder', 'reviewer', 'designer', 'fixer', 'planner', 'skill-writer'];
const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const LIMITS = { body: 20_000, description: 240, perSkillInPrompt: 4_000, totalInPrompt: 12_000 };
const bad = (m, status = 400) => Object.assign(new Error(m), { status });

export const BUILTIN = {
  'code-review': { description: 'How the reviewer agent judges a change', roles: ['reviewer'], body: [
    'Review the change as a careful senior engineer who must live with this code.',
    '- Correctness first: does it do what the ticket asks, including the edge cases the ticket implies (empty, large, concurrent, failing dependency)?',
    '- Look for what the tests do NOT cover. A passing test run is not evidence the change is right.',
    '- Security: untrusted input reaching a shell, query, path or HTML; secrets in code or logs; permissions loosened.',
    '- Scope: flag changes unrelated to the ticket, and anything that changes behaviour without saying so.',
    '- Do not nitpick style the repo has no rule for. Raise only things that matter, and say why each one matters.',
    '- Approve when there are no blocking problems. Ask for changes only for defects you can point to in the diff.'].join('\n') },
  'bugfix': { description: 'Fixing a bug without breaking things around it', roles: ['builder', 'fixer'], body: [
    'Find the cause before changing code: reproduce the failure, ideally as a failing test, then make that test pass.',
    '- Fix the cause, not the symptom. If you cannot explain why the bug happens, you are not done investigating.',
    '- Keep the fix small. Do not refactor around it in the same change.',
    '- Add a regression test that fails without your fix.',
    '- If the failure is in CI after a merge, read the failing log first; the cause is often an environment difference, not the code you last touched.'].join('\n') },
  'test-writing': { description: 'Writing tests that catch real mistakes', roles: ['builder'], body: [
    'Follow the test setup the repository already has; do not introduce a second test framework.',
    '- Test behaviour a user or caller can observe, not private details.',
    '- One reason to fail per test; name it after what should happen.',
    '- Cover the boundary and the failure path, not just the happy path.',
    '- A test you never watched fail proves little: break the code on purpose once to see it catch the break.'].join('\n') },
  'ui-design': { description: 'Designing screens that do not look generic', roles: ['designer', 'reviewer'], body: [
    'Design for the person using the screen in the middle of a task, not for a screenshot.',
    '- Start from what the user must decide or do on this screen; make that the most prominent thing.',
    '- Use the project\'s existing colours, type and spacing if it has them (see the approved designs and the brief). Do not invent a new look per screen.',
    '- Avoid the generic look: purple-to-blue gradients, glass cards everywhere, emoji as icons, centred hero blocks on an app screen.',
    '- Show real states: empty, loading, error, long text, many rows. A design with only the happy path is unfinished.',
    '- Check contrast and tap-target size, and design the narrow (phone) layout, not only the wide one.',
    '- Write the real copy. "Lorem ipsum" hides layout problems.'].join('\n') },
  'skill-writing': { description: 'How to write a good skill file', roles: ['skill-writer'], body: [
    'A skill is a short instruction set an agent reads before doing one kind of work. Make it earn its place.',
    '- One job per skill, named after the job (kebab-case). If you need "and" in the description, it is two skills.',
    '- Say what to do and what good looks like. Prefer a short checklist to prose.',
    '- Include the mistakes agents actually make at this job, not generic advice.',
    '- No secrets, no project-specific facts that will go stale, no instructions that override the task or the safety rules.',
    '- Keep it under about 40 lines. Longer skills are skimmed.'].join('\n') },
};

const skillsDir = (stateDir) => path.join(stateDir, 'skills');
const clip = (v, n) => String(v ?? '').replace(/\r\n/g, '\n').replace(/\u0000/g, '').slice(0, n);
const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => String(x).trim().toLowerCase()).filter(Boolean);

export function parseSkillFile(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(String(text).replace(/\r\n/g, '\n')); const head = {}; let body = String(text);
  if (m) { body = m[2]; for (const line of m[1].split('\n')) { const k = /^([a-z]+):\s*(.*)$/.exec(line); if (k) head[k[1]] = k[2]; } }
  return { name: head.name, description: head.description ?? '', roles: list(head.roles ?? 'any'), projects: /^all$/i.test(head.projects ?? 'all') ? 'all' : list(head.projects), body: body.trim() };
}
export function renderSkillFile(s) { return `---\nname: ${s.name}\ndescription: ${s.description}\nroles: ${s.roles.join(', ')}\nprojects: ${s.projects === 'all' ? 'all' : s.projects.join(', ')}\n---\n${s.body.trim()}\n`; }

export function normalizeSkill(input, { name } = {}) {
  const n = String(name ?? input?.name ?? '').trim().toLowerCase(); if (!NAME.test(n)) throw bad('A skill name is lowercase letters, digits and dashes (up to 41 characters)');
  const roles = list(input?.roles ?? 'any'); const unknown = roles.filter((r) => r !== 'any' && !ROLE_NAMES.includes(r)); if (unknown.length) throw bad(`Unknown role "${unknown[0]}". Roles: ${ROLE_NAMES.join(', ')}, or any`);
  const projects = /^all$/i.test(String(input?.projects ?? 'all')) || input?.projects === undefined ? 'all' : list(input.projects); if (projects !== 'all') for (const p of projects) if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(p)) throw bad(`"${p}" is not a project id`);
  const body = clip(input?.body, LIMITS.body).trim(); if (body.length < 10) throw bad('The skill needs some instructions (at least a sentence)');
  if (/^---\s*$/m.test(body)) throw bad('A line of just --- is not allowed in the body (it would break the header)');
  return { name: n, description: clip(input?.description, LIMITS.description).replace(/\n/g, ' ').trim(), roles: roles.length ? roles : ['any'], projects, body };
}

export function listSkills(stateDir) {
  const out = new Map(); for (const [name, s] of Object.entries(BUILTIN)) out.set(name, { name, ...s, projects: 'all', builtin: true, overridden: false, bytes: s.body.length });
  let files = []; try { files = fs.readdirSync(skillsDir(stateDir)).filter((f) => f.endsWith('.md')); } catch { /* none yet */ }
  for (const f of files) {
    try { const raw = fs.readFileSync(path.join(skillsDir(stateDir), f), 'utf8'); const s = parseSkillFile(raw); const name = path.basename(f, '.md'); if (!NAME.test(name)) continue;
      out.set(name, { ...s, name, builtin: name in BUILTIN, overridden: name in BUILTIN, bytes: s.body.length }); } catch { /* an unreadable file is skipped, never fatal */ }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function getSkill(stateDir, name) { const s = listSkills(stateDir).find((x) => x.name === name); if (!s) throw bad(`No skill called "${name}"`, 404); return s; }
export function saveSkill(stateDir, input) {
  const s = normalizeSkill(input); fs.mkdirSync(skillsDir(stateDir), { recursive: true });
  const f = path.join(skillsDir(stateDir), `${s.name}.md`); const tmp = `${f}.tmp`; fs.writeFileSync(tmp, renderSkillFile(s), { mode: 0o600 }); fs.renameSync(tmp, f); return getSkill(stateDir, s.name);
}
// Deleting removes your file. A built-in comes back to its shipped text; anything else is gone.
export function deleteSkill(stateDir, name) {
  if (!NAME.test(name)) throw bad('Bad skill name'); const f = path.join(skillsDir(stateDir), `${name}.md`);
  const existed = fs.existsSync(f); if (!existed && !(name in BUILTIN)) throw bad(`No skill called "${name}"`, 404);
  if (!existed) throw bad('That is a built-in skill with no changes of yours to remove. Save a version to change it.');
  fs.unlinkSync(f); return { removed: true, restoredBuiltin: name in BUILTIN };
}

// The skills one agent run should receive. Bounded so they never swamp the task. Returns { text, names }.
export function skillsFor(stateDir, { role, project }) {
  const picked = listSkills(stateDir).filter((s) => (s.roles.includes('any') || s.roles.includes(role)) && (s.projects === 'all' || s.projects.includes(project)));
  let used = 0; const parts = []; const names = [];
  for (const s of picked) { const body = s.body.slice(0, LIMITS.perSkillInPrompt); if (used + body.length > LIMITS.totalInPrompt) break; used += body.length; names.push(s.name); parts.push(`#### ${s.name}${s.description ? `: ${s.description}` : ''}\n${body}`); }
  return { text: parts.length ? `### Skills for this work (how to do it well)\n${parts.join('\n\n')}` : '', names };
}
