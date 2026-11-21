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

export const ROLE_NAMES = ['builder', 'reviewer', 'security', 'tester', 'designer', 'fixer', 'planner', 'spec-writer', 'skill-writer'];
const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const LIMITS = { body: 20_000, description: 240, perSkillInPrompt: 4_000, totalInPrompt: 12_000 };
const bad = (m, status = 400) => Object.assign(new Error(m), { status });

export const BUILTIN = {
  'test-driven-development': { source: 'Inspired by obra/superpowers (MIT) and mattpocock/skills (MIT)', description: 'Write the failing test first, then the smallest code that passes', roles: ['builder', 'fixer'], body: [
    'Work in small red-green steps, using the repository\'s existing test setup.',
    '1. RED: write one test that states the behaviour you are about to add. Run it and read the failure. It must fail for the RIGHT reason (the behaviour is missing, not a typo or an import error).',
    '2. GREEN: write the smallest code that makes it pass. No extra features, no "while I am here" cleanups.',
    '3. REFACTOR: with everything green, remove duplication and improve names. Run the tests again.',
    '- A test you never saw fail proves nothing. If a new test passes immediately, it is not testing what you think: tighten it.',
    '- If you wrote code first, write the test now and then break the code on purpose once to see the test catch it.',
    '- One behaviour per test, named for what should happen. Cover the boundary and the failure path, not only the happy path.',
    '- Do not edit a test just to make it pass. If a test and the ticket disagree, the ticket wins: say so in your summary.'].join('\n') },
  'bugfix': { source: 'Inspired by obra/superpowers systematic-debugging (MIT) and mattpocock/skills diagnosing-bugs (MIT)', description: 'Find the cause before changing code, then fix only that', roles: ['builder', 'fixer'], body: [
    'No fix before you can explain the cause. Guessing and retrying is how one bug becomes three.',
    '1. Build a feedback loop first: a failing test, a script, or a command that goes red on THIS bug. Spend your effort here; with a sharp loop the rest is mechanical.',
    '2. Read the whole error and stack trace. Check what changed recently (git log, git diff, new dependencies, config).',
    '3. In a system with several parts (CI, build, service, database), add a temporary log at each boundary to see which part is wrong before touching any.',
    '4. State one hypothesis ("X fails because Y"), change one thing to test it, and observe. If it is wrong, form a new hypothesis; do not stack fixes.',
    '5. Fix the cause, with a regression test that fails without your fix. Remove any temporary logging.',
    '- Fix the cause, not the symptom. Do not refactor around the bug in the same change.',
    '- Never print secrets while debugging: redact tokens, keys and passwords from anything you show or log.',
    '- If three attempts at a fix have failed, stop: the problem is probably the design or your understanding, so say what you learned.'].join('\n') },
  'verification-before-completion': { source: 'Inspired by obra/superpowers (MIT)', description: 'Run the checks and read the output before saying it is done', roles: ['builder', 'fixer', 'designer'], body: [
    'Evidence before claims. Do not say a change works, passes or is finished until you have run the command that proves it and read its output in this session.',
    '- "Tests pass" needs the test command run now, with the failure count read. A previous run, or "it should pass", is not evidence.',
    '- "Bug fixed" needs the original symptom checked again, not just a code change.',
    '- "Build works" needs the build run. A passing linter is not a passing build.',
    '- Check the requirement line by line against the ticket; passing tests do not mean every requirement is met.',
    '- Words like "should", "probably" and "seems to" mean you have not verified. Run it, or say plainly what you could not run.',
    '- In your final summary, state what you ran and what it showed, including anything that failed or that you could not check.'].join('\n') },
  'test-writing': { source: 'Original', description: 'Writing tests that catch real mistakes', roles: ['builder', 'tester'], body: [
    'Follow the test setup the repository already has; do not introduce a second test framework.',
    '- Test behaviour a user or caller can observe, not private details.',
    '- One reason to fail per test; name it after what should happen.',
    '- Cover the boundary and the failure path, not just the happy path.',
    '- Avoid mocking what you own; mock only the edge of the system (network, clock, disk).',
    '- Tests must be deterministic: pin time, seed randomness, do not depend on test order.'].join('\n') },
  'receiving-code-review': { source: 'Inspired by obra/superpowers receiving-code-review (MIT)', description: 'Handling review comments on a pull request', roles: ['fixer'], body: [
    'Review comments are input to evaluate, not orders to follow blindly and not criticism to grovel over.',
    '1. Read all the feedback before changing anything. If any item is unclear, say which and why you could not act on it, rather than guessing: items are often related.',
    '2. Check each point against the actual code. A reviewer can be wrong, or can be missing context.',
    '3. If a point is right, fix it. If it is wrong or would break something, do not apply it: explain why in your summary, with the evidence.',
    '4. Change one thing at a time and run the tests after each.',
    '- No flattery or filler ("You are absolutely right!"). State what you changed, or what you did not and why.',
    '- Do not widen the change beyond what the comments ask for.'].join('\n') },
  'ci-failure-triage': { source: 'Original', description: 'A pipeline failed after a change: work out why, then fix it', roles: ['fixer', 'builder'], body: [
    'Read the failing log from the bottom up: the first real error is usually above the last line.',
    '- Decide which kind it is: a real defect in the change, a test that depended on the old behaviour, an environment difference (version, missing variable, network), or a flaky test.',
    '- Reproduce it locally with the same command CI runs before changing code. If you cannot reproduce it, say so and explain what you checked.',
    '- Fix the cause with the smallest change. Do not delete or skip a failing test to get green; if a test is genuinely obsolete, change it and say why.',
    '- A flaky test is a finding, not a fix: report it, and only make it deterministic if that is small and clearly the cause.'].join('\n') },
  'code-review': { source: 'Inspired by mattpocock/skills code-review (MIT) and obra/superpowers requesting-code-review (MIT)', description: 'How the reviewer agent judges a change', roles: ['reviewer'], body: [
    'Review the diff on two separate axes, and keep them apart in your findings.',
    'SPEC: does the change do what the ticket asks, including the edge cases the ticket implies (empty, large, concurrent, failing dependency)? Is anything asked for missing? Is anything added that was not asked for?',
    'STANDARDS: does it follow how this repository does things (its docs, config, and neighbouring code)? Is it correct, readable and tested?',
    '- Look hardest at what the tests do NOT cover. A passing run is not evidence the change is right.',
    '- Smells worth naming when they matter: a name that hides what the thing does, duplicated logic, a function doing several jobs, a change that touches far more than the ticket needs.',
    '- Security belongs to the security reviewer if there is one; still flag anything obvious (input reaching a shell, query or HTML; secrets in code).',
    '- Do not nitpick style the repository has no rule for, or anything a linter already enforces. Every finding must say why it matters.',
    '- Approve when there are no blocking problems. Ask for changes only for defects you can point to in the diff.'].join('\n') },
  'security-review': { source: 'Inspired by anthropics/claude-code-security-review (MIT) and Trail of Bits skills (CC-BY-SA, ideas only)', description: 'Reviewing a change for security problems', roles: ['security'], body: [
    'Review the diff for vulnerabilities an attacker could use. Report only issues you can point to and explain; a vague worry is not a finding.',
    '- Untrusted input reaching something dangerous: a shell command, SQL or other query, file path, HTML (XSS), a URL fetched by the server (SSRF), a deserialiser, a template.',
    '- Authentication and authorisation: a new endpoint or action without a check; checking who someone is but not whether they may do this; IDs taken from the request without verifying ownership.',
    '- Secrets: keys, tokens or passwords in code, config, logs or error messages; secrets sent to places they should not go.',
    '- Insecure defaults: a setting that is safe only if someone remembers to change it; failing open when a check errors; disabled TLS or signature verification.',
    '- Dependencies: a new package that is unknown, unmaintained, or fetched from an odd source; versions loosened.',
    '- When you find one, look for the SAME mistake elsewhere in the diff and nearby code before you report.',
    '- Mark severity honestly: blocker = exploitable now; major = exploitable with some condition; minor = hardening. Do not inflate.'].join('\n') },
  'ui-design': { source: 'Inspired by anthropics/skills frontend-design (own wording)', description: 'Designing screens that do not look generic', roles: ['designer', 'reviewer'], body: [
    'Design for the person using the screen in the middle of a task, not for a screenshot.',
    '- Start from what the user must decide or do on this screen; make that the most prominent thing.',
    '- Use the project\'s existing colours, type and spacing if it has them (see the approved designs and the brief). Do not invent a new look per screen.',
    '- Avoid the generic look: purple-to-blue gradients, glass cards everywhere, emoji as icons, centred hero blocks on an app screen, the same rounded card repeated for everything.',
    '- Choose a point of view for the type and colour and keep to it: one accent, a restrained palette, a real type hierarchy.',
    '- Show real states: empty, loading, error, long text, many rows. A design with only the happy path is unfinished.',
    '- Design the narrow (phone) layout properly, not only the wide one. Write the real copy; "Lorem ipsum" hides layout problems.'].join('\n') },
  'accessibility': { source: 'Original, based on WCAG 2.2', description: 'Accessible by default: contrast, keyboard, labels, targets', roles: ['designer', 'builder', 'reviewer'], body: [
    'Build it so it works without a mouse and without perfect eyesight.',
    '- Text contrast at least 4.5:1 (3:1 for large text); do not rely on colour alone to show state.',
    '- Everything clickable is reachable and usable with the keyboard, with a visible focus indicator.',
    '- Every form control has a label; images that carry meaning have alt text; icon-only buttons have an accessible name.',
    '- Touch targets at least 44x44 px. No content that needs sideways scrolling at 320px width.',
    '- Respect reduced-motion. Use real buttons and links, not clickable divs.'].join('\n') },
  'writing-plans': { source: 'Inspired by obra/superpowers writing-plans (MIT)', description: 'Turning a brief into a plan an engineer can follow', roles: ['planner'], body: [
    'Write the plan for an engineer who has not seen this codebase or the brief.',
    '- First map the files: which are created or changed, and what each is responsible for. Follow the structure the repository already has.',
    '- Split the work into tasks that each deliver something independently testable. Fold setup, config and docs into the task that needs them; split only where a reviewer could sensibly accept one task and reject its neighbour.',
    '- Each step is one action with a checkable result ("write the failing test", "run it and see it fail", "make it pass").',
    '- Name exact files, functions and behaviours. No "handle errors appropriately" or "add tests": say which errors and which tests.',
    '- Put the riskiest or most uncertain task first, and state what each task depends on.'].join('\n') },
  'ticket-slicing': { source: 'Inspired by mattpocock/skills to-tickets (MIT)', description: 'Cutting work into small tickets an agent can finish', roles: ['planner', 'spec-writer'], body: [
    'A ticket is ONE reviewable pull request of work that an AI agent can finish in one go.',
    '- Slice vertically: each ticket delivers a thin working path through the layers, not "the database layer" then "the UI layer".',
    '- If a ticket needs more than about five files or two separate behaviours, split it.',
    '- Every ticket says what to build, where in the code, how to check it, and what is out of scope.',
    '- State dependencies explicitly, and make as few as you can.',
    '- Prefer many small tickets to few large ones: big tickets burn the agent\'s plan and fail more often.'].join('\n') },
  'spec-writing': { source: 'Original', description: 'Turning a vague request into acceptance criteria', roles: ['spec-writer'], body: [
    'Make the request precise enough that two engineers would build the same thing, without inventing requirements.',
    '- Restate the goal in one sentence a stranger would understand.',
    '- Write acceptance criteria as observable checks ("When X, the user sees Y"), including the empty, error and boundary cases.',
    '- List what is OUT of scope, so the agent does not add extras.',
    '- Name the files or areas most likely involved, based on the repository context you are given.',
    '- Where the request is genuinely ambiguous, state your assumption explicitly as an assumption; do not present a guess as a requirement.',
    '- Keep it short: a few lines per section. Do not rewrite the original request, only add to it.'].join('\n') },
  'skill-writing': { source: 'Inspired by anthropics/skills skill-creator (own wording)', description: 'How to write a good skill file', roles: ['skill-writer'], body: [
    'A skill is a short instruction set an agent reads before doing one kind of work. Make it earn its place.',
    '- One job per skill, named after the job (kebab-case). If you need "and" in the description, it is two skills.',
    '- Say what to do and what good looks like. Prefer a short checklist to prose.',
    '- Include the mistakes agents actually make at this job, not generic advice.',
    '- No secrets, no project-specific facts that will go stale, no instructions that override the task or the safety rules.',
    '- Keep it under about 40 lines. Longer skills are skimmed. Say where the ideas came from in the source line.'].join('\n') },
};

const skillsDir = (stateDir) => path.join(stateDir, 'skills');
const clip = (v, n) => String(v ?? '').replace(/\r\n/g, '\n').replace(/\u0000/g, '').slice(0, n);
const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => String(x).trim().toLowerCase()).filter(Boolean);

export function parseSkillFile(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(String(text).replace(/\r\n/g, '\n')); const head = {}; let body = String(text);
  if (m) { body = m[2]; for (const line of m[1].split('\n')) { const k = /^([a-z]+):\s*(.*)$/.exec(line); if (k) head[k[1]] = k[2]; } }
  return { name: head.name, description: head.description ?? '', source: head.source ?? '', roles: list(head.roles ?? 'any'), projects: /^all$/i.test(head.projects ?? 'all') ? 'all' : list(head.projects), body: body.trim() };
}
export function renderSkillFile(s) { return `---\nname: ${s.name}\ndescription: ${s.description}\nsource: ${s.source ?? ''}\nroles: ${s.roles.join(', ')}\nprojects: ${s.projects === 'all' ? 'all' : s.projects.join(', ')}\n---\n${s.body.trim()}\n`; }

export function normalizeSkill(input, { name } = {}) {
  const n = String(name ?? input?.name ?? '').trim().toLowerCase(); if (!NAME.test(n)) throw bad('A skill name is lowercase letters, digits and dashes (up to 41 characters)');
  const roles = list(input?.roles ?? 'any'); const unknown = roles.filter((r) => r !== 'any' && !ROLE_NAMES.includes(r)); if (unknown.length) throw bad(`Unknown role "${unknown[0]}". Roles: ${ROLE_NAMES.join(', ')}, or any`);
  const projects = /^all$/i.test(String(input?.projects ?? 'all')) || input?.projects === undefined ? 'all' : list(input.projects); if (projects !== 'all') for (const p of projects) if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(p)) throw bad(`"${p}" is not a project id`);
  const body = clip(input?.body, LIMITS.body).trim(); if (body.length < 10) throw bad('The skill needs some instructions (at least a sentence)');
  if (/^---\s*$/m.test(body)) throw bad('A line of just --- is not allowed in the body (it would break the header)');
  return { name: n, description: clip(input?.description, LIMITS.description).replace(/\n/g, ' ').trim(), source: clip(input?.source, 200).replace(/\n/g, ' ').trim(), roles: roles.length ? roles : ['any'], projects, body };
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
