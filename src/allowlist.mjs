// A ticket can say exactly which files may change, in a fenced block:
//   ```allowed-files
//   src/billing/**
//   test/billing.test.js
//   ```
// The factory then refuses any change that touches something else (the agent gets one chance to put it back). It also bounds what an agent can reach
// when the ticket came from someone you trust less. Globs: * within a folder, ** across folders, a trailing / for a whole folder.
import { globToRegExp } from './ignore.mjs';

export function parseAllowedFiles(body) {
  const m = /```allowed-files[ \t]*\n([\s\S]*?)```/i.exec(String(body ?? '')); if (!m) return null;
  const patterns = m[1].split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean).slice(0, 40)
    .filter((p) => p.length <= 120 && !p.includes('..') && !/[\0\\]/.test(p)).map((p) => p.replace(/^\.\//, '').replace(/^\//, ''));
  return patterns.length ? patterns : null;
}
export function outsideAllowlist(files, patterns) {
  const res = patterns.map(globToRegExp);
  return files.filter((f) => !res.some((re) => re.test(f)));
}
