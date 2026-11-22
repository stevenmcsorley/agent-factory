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

// When does the limit lift? The CLI prints a clock time ("10:26 PM", meaning the next time that comes round) or a full date ("Nov 22nd, 2026 3:28 AM"), in this machine's local time.
// Returns a timestamp (ms) a couple of minutes after the stated time, or null when it cannot be read (the caller then tries again later rather than guessing a long wait).
export function retryAtMs(text, now = Date.now()) {
  const s = String(text ?? ''); const margin = 2 * 60_000;
  const full = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(s);
  if (full) { const t = new Date(`${full[1]} ${full[2]}, ${full[3]} ${full[4]}:${full[5]} ${full[6].toUpperCase()}`).getTime(); return Number.isFinite(t) ? t + margin : null; }
  const clock = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(s);
  if (clock) { let h = Number(clock[1]) % 12; if (/pm/i.test(clock[3])) h += 12; const d = new Date(now); d.setHours(h, Number(clock[2]), 0, 0); let t = d.getTime(); if (t <= now) t += 24 * 3_600_000; return t + margin; }
  const rel = /(?:in\s+)?(\d+)\s*(minute|min|hour|hr)s?/i.exec(s); if (rel) return now + Number(rel[1]) * (/^h/i.test(rel[2]) ? 3_600_000 : 60_000) + margin;
  return null;
}
