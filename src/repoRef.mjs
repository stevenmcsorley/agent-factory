// People paste whatever is in their browser or clone box. Turn any of these into the canonical repo path (and say which host it points to):
//   owner/name · https://github.com/owner/name · .../name.git · .../name/tree/main · git@github.com:owner/name.git · ssh://git@host/owner/name.git
//   https://gitlab.com/group/sub/project/-/merge_requests/3 · https://bitbucket.org/ws/repo/src/main
const KNOWN = { 'github.com': 'github', 'www.github.com': 'github', 'gitlab.com': 'gitlab', 'www.gitlab.com': 'gitlab', 'bitbucket.org': 'bitbucket', 'www.bitbucket.org': 'bitbucket' };
const GH_STOP = new Set(['tree', 'blob', 'pull', 'pulls', 'issues', 'actions', 'commit', 'commits', 'releases', 'wiki', 'settings', 'compare']);

export function normalizeRepo(input, hostKind) {
  const raw = String(input ?? '').trim();
  if (!raw) return { repo: '', host: null, origin: null };
  let host = null, origin = null, path = raw;
  const ssh = /^(?:ssh:\/\/)?(?:[\w.-]+@)([\w.-]+)[:/](.+)$/.exec(raw);          // git@github.com:owner/name.git  or  ssh://git@host/owner/name.git
  if (/^https?:\/\//i.test(raw)) { try { const u = new URL(raw); host = u.hostname.toLowerCase(); origin = u.origin; path = u.pathname; } catch { return { repo: raw, host: null, origin: null }; } }
  else if (ssh) { host = ssh[1].toLowerCase(); path = ssh[2]; }
  else if (/^[\w.-]+\.[a-z]{2,}\//i.test(raw)) { const i = raw.indexOf('/'); host = raw.slice(0, i).toLowerCase(); path = raw.slice(i); } // github.com/owner/name without a scheme
  let segs = path.split(/[?#]/)[0].split('/').filter(Boolean);
  const kind = (host && KNOWN[host]) || null; const effective = kind ?? hostKind ?? null;
  const dash = segs.indexOf('-'); if (dash > 0) segs = segs.slice(0, dash);                                   // GitLab: group/project/-/merge_requests/3
  if (effective === 'github' || effective === 'bitbucket') { const stop = segs.findIndex((s, i) => i >= 2 && (GH_STOP.has(s) || ['src', 'branches', 'pull-requests', 'commits'].includes(s))); segs = segs.slice(0, 2); if (stop >= 0) segs = segs.slice(0, 2); }
  else { const stop = segs.findIndex((s, i) => i >= 2 && ['tree', 'blob', 'merge_requests', 'issues', 'pipelines', 'commits', 'raw'].includes(s)); if (stop >= 0) segs = segs.slice(0, stop); }
  if (segs.length) segs[segs.length - 1] = segs.at(-1).replace(/\.git$/i, '');
  return { repo: segs.join('/'), host: kind, origin: host && !kind ? origin : null };
}
