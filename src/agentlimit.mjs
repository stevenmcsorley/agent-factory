// The agent CLI exits cleanly when the account's usage limit is hit; its only sign is a line in the output ("You've hit your usage limit ... try again at 4:12 AM").
// Without this check the factory sees "no error", runs the tests on whatever half-finished change is in the folder, and opens a pull request for it (seen for real: a PR holding just a dependency bump).
// The pattern is deliberately strict: an agent describing rate limiting in someone's code must never match.
const LIMIT = /(?:you['’]ve|you have) (?:hit|reached) your (?:\w+ )?(?:usage )?limit|usage limit (?:reached|exceeded)|(?:out of|exceeded your) (?:usage|credits|quota)/i;

export function parseUsageLimit(out) {
  const text = String(out ?? '');
  const m = LIMIT.exec(text); if (!m) return null;
  const line = text.slice(Math.max(0, text.lastIndexOf('\n', m.index) + 1)).split('\n')[0].replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const at = /try again (?:at|in|after) ([^.\n]{1,40})/i.exec(text)?.[1]?.trim();
  return { message: line, retryAt: at || null };
}
