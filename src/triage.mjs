// The agent's two non-code answers, parsed from its final message:
//   NEEDS_INFO: <1-3 specific questions>   (first line; it made no changes because the ticket is genuinely open-ended)
//   Assumptions: <bullets>                  (it proceeded, and says what it assumed so the reviewer can check)
export function parseNeedsInfo(out) {
  const t = String(out ?? '').trim();
  const m = /^NEEDS_INFO:?\s*([\s\S]*)$/.exec(t); // first line only: a mention deeper in a normal summary is not a request for information
  if (!m) return null;
  const q = m[1].trim();
  return (q || 'The agent needs more information to proceed but did not say what.').slice(0, 1500);
}
export function parseAssumptions(out) {
  const m = /(?:^|\n)[ \t]*(?:#{1,4}[ \t]*)?(?:\*\*)?Assumptions?:?(?:\*\*)?[ \t]*\n?([\s\S]*)$/i.exec(String(out ?? ''));
  if (!m) return null;
  const body = m[1].trim().replace(/\n{3,}/g, '\n\n').slice(0, 1200);
  return body.length >= 3 ? body : null;
}
