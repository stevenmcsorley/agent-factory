// Ticket clarity gate: refuse to spend an agent run on a ticket that gives it nothing concrete to build.
// Deterministic on purpose (free, testable, explainable). A ticket passes if it is long enough AND has at least one anchor:
// a `code identifier`, a file path, a list of criteria, or requirement language. Tunable via config.gate.
const ANCHORS = [
  [/`[^`\n]{2,}`/, 'a `code identifier`'],
  [/\b[\w./-]+\.(?:m?js|ts|tsx|jsx|py|go|rs|java|rb|php|css|html|json|ya?ml|md|sql|sh)\b/i, 'a file name'],
  [/^\s*(?:[-*]|\d+[.)])\s+\S/m, 'a list of criteria'],
  [/\b(?:should|must|shall|expect(?:ed)?|returns?|throws?|when|given|accept(?:ance)?|so that)\b/i, 'requirement wording (should/must/returns/when…)'],
];

export function assessTicket(t, { minWords = 12, requireAnchor = true } = {}) {
  const text = `${t.title ?? ''}\n${t.body ?? ''}`;
  const words = (text.match(/\S+/g) ?? []).length;
  const problems = [];
  if (words < minWords) problems.push(`it is very short (${words} words, need at least ${minWords})`);
  if (requireAnchor && !ANCHORS.some(([re]) => re.test(text)))
    problems.push(`it has nothing concrete to build against — add one of: ${ANCHORS.map(([, n]) => n).join('; ')}`);
  return { ok: problems.length === 0, problems };
}

export function clarificationComment(problems) {
  return [`agent-factory did not start work on this ticket: ${problems.join('; and ')}.`,
    ``, `Please say **what** should change and **how to tell it is done** (e.g. name the function/file and the expected behaviour), then re-add the \`agent-ready\` label.`].join('\n');
}
