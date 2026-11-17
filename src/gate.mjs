// Pre-flight check on a ticket. It is deliberately NARROW: it only stops tickets that are too short to act on at all, because deciding
// whether a request is "clear enough" is a judgement call that belongs to the agent, not to a word-matching rule (which wrongly refused
// perfectly good tickets like "add a blank text file in the root directory"). The agent proceeds on reasonable assumptions, or asks a
// specific question when a ticket is truly open-ended; see buildPrompt()/triage.mjs. This function also returns non-blocking TIPS.
const ANCHORS = [
  [/`[^`\n]{2,}`/, 'a `code identifier`'],
  [/\b[\w./-]+\.(?:m?js|ts|tsx|jsx|py|go|rs|java|rb|php|css|html|json|ya?ml|md|sql|sh|txt)\b/i, 'a file name'],
  [/^\s*(?:[-*]|\d+[.)])\s+\S/m, 'a list of criteria'],
  [/\b(?:should|must|shall|expect(?:ed)?|returns?|throws?|when|given|accept(?:ance)?|so that|says?|contains?)\b/i, 'the expected behaviour'],
];

export function assessTicket(t, { minWords = 5, requireAnchor = false } = {}) {
  const text = `${t.title ?? ''}\n${t.body ?? ''}`;
  const words = (text.match(/\S+/g) ?? []).length;
  const problems = [], tips = [];
  if (words < minWords) problems.push(`it is too short to act on (${words} word${words === 1 ? '' : 's'}; say what should change)`);
  const anchored = ANCHORS.some(([re]) => re.test(text));
  if (!anchored) {
    const hint = `naming the file or function and the expected behaviour helps the agent get it right first time`;
    (requireAnchor ? problems : tips).push(requireAnchor ? `it has nothing concrete to build against; add one of: ${ANCHORS.map(([, n]) => n).join('; ')}` : hint);
  }
  return { ok: problems.length === 0, problems, tips };
}

export function clarificationComment(problems) {
  return [`agent-factory did not start work on this ticket: ${problems.join('; and ')}.`,
    ``, `Say what should change (and, if you can, how to tell it is done), then use Requeue in the Agent Factory inbox, or re-add the \`agent-ready\` label.`].join('\n');
}
