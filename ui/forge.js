// Views for the local forge: review a pull request (diff, comments, merge, close) and publish the project to a real remote.
import { h, api, ago, act } from './lib.js';

const card = (...kids) => h('section', { class: 'card' }, ...kids);
const TAG = { open: 'ok', merged: 'live', closed: '' };

// A unified diff, coloured by line type. Capped so a huge change cannot freeze the page.
function diffView(text) {
  const lines = text.split('\n'); const cap = 4000; const box = h('pre', { class: 'diff' });
  for (const l of lines.slice(0, cap)) { const c = l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') ? 'd-meta' : l.startsWith('@@') ? 'd-hunk' : l[0] === '+' ? 'd-add' : l[0] === '-' ? 'd-del' : ''; box.append(h('span', { class: `dl ${c}` }, `${l}\n`)); }
  if (lines.length > cap) box.append(h('span', { class: 'dl d-meta' }, `… ${lines.length - cap} more lines not shown`));
  return box;
}

export function prRowsLocal(prs, { open }) {
  if (!prs.length) return card(h('div', { class: 'empty' }, h('b', {}, 'No pull requests yet'), h('p', {}, 'When the factory finishes a ticket, its branch appears here for you to review and merge.')));
  return card(h('ul', { class: 'plain' }, prs.map((x) => h('li', { class: 'row between' }, h('button', { class: 'linklike', onclick: () => open(x.number) }, `#${x.number} ${x.title}`), h('small', { class: 'muted' }, x.branch)))));
}

export function prPage(d, { id, back, rerender }) {
  const pr = d.pr; const text = h('textarea', { rows: 3, placeholder: 'Comment for the factory. If you re-queue the ticket, it reads these.' });
  const post = (action, body, msg) => act(async () => { await api(`/projects/${id}/prs/${pr.number}/${action}`, { method: 'POST', body }); }, msg, rerender);
  const merge = act(async () => { if (!confirm(`Merge #${pr.number} into ${pr.base}?`)) return; await api(`/projects/${id}/prs/${pr.number}/merge`, { method: 'POST', body: {} }); }, 'Merged', rerender);
  const open = pr.state === 'open';
  return [h('button', { class: 'btn', onclick: back }, 'Back'),
    card(h('div', { class: 'row between' }, h('h1', {}, `#${pr.number} ${pr.title}`), h('span', { class: `stamp ${TAG[pr.state] ?? ''}` }, pr.state)),
      h('p', { class: 'small muted' }, `${pr.branch} → ${pr.base} · opened ${ago(pr.createdAt)}`),
      pr.stale ? h('div', { class: 'note warn' }, 'The branch has changed since the factory last verified it. Merge is blocked until it is re-run.') : null,
      h('pre', { class: 'log-pre' }, pr.body || ''),
      open ? h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', disabled: pr.stale, onclick: merge }, 'Merge'), h('button', { class: 'btn', onclick: post('close', {}, 'Closed') }, 'Close without merging'))
        : pr.state === 'merged' ? h('p', { class: 'small muted' }, `Merged as ${String(pr.mergedSha).slice(0, 10)}.`) : null),
    card(h('h2', {}, `Files changed (${d.files.length})`), h('ul', { class: 'plain' }, d.files.map((f) => h('li', { class: 'row between' }, h('code', {}, f.path), h('span', { class: 'small mono' }, f.added === null ? 'binary' : `+${f.added} −${f.removed}`)))),
      d.diff ? diffView(d.diff) : h('p', { class: 'muted small' }, d.note ?? 'No changes.'), d.truncated ? h('p', { class: 'small muted' }, 'The diff was cut at 400 KB.') : null),
    card(h('h2', {}, `Comments (${pr.comments.length})`), h('ul', { class: 'plain' }, pr.comments.map((c) => h('li', { class: 'cmt' }, h('div', { class: 'small muted' }, `${c.author}${c.at ? ` · ${ago(c.at)}` : ''}`), h('div', {}, c.body)))),
      text, h('div', { class: 'row gap-t' }, h('button', { class: 'btn', onclick: () => { if (!text.value.trim()) return; return post('comment', { text: text.value }, 'Comment added')(); } }, 'Comment')))];
}

// Where should this code go when it is ready? Set a target, then publish (a push of the base branch; never forced).
export function publishCard(st, { id, rerender }) {
  const kind = h('select', {}, ['github', 'gitlab', 'bitbucket', 'git'].map((k) => h('option', { value: k }, { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket', git: 'Any git remote' }[k])));
  const repo = h('input', { placeholder: 'owner/name' }); const tmpl = h('input', { placeholder: 'https://git.example.com/{repo}.git (any git remote only)' });
  const set = act(async () => { await api(`/projects/${id}/publish-target`, { method: 'POST', body: { kind: kind.value, repo: repo.value.trim(), ...(kind.value === 'git' ? { fields: { remoteTemplate: tmpl.value.trim() } } : {}) } }); }, 'Publish target saved', rerender);
  const go = (switchHost) => act(async () => { let feedbackAuthors; if (switchHost) { const u = prompt('Which usernames on the new host may comment on pull requests? (comma separated)'); if (!u) return; feedbackAuthors = u.split(',').map((x) => x.trim()).filter(Boolean); } const r = await api(`/projects/${id}/publish`, { method: 'POST', body: { switchHost, feedbackAuthors } }); if (r.upToDate) throw new Error('Already up to date: nothing to push'); }, 'Published', rerender);
  return card(h('h2', {}, 'Publish'), h('p', { class: 'small muted' }, 'Push the base branch to a real repository when you are ready (to deploy, or to share). The factory never force-pushes, and never publishes on its own.'),
    st.target ? [h('p', {}, `Target: ${st.target.kind} · ${st.target.repo}`), h('p', { class: 'small muted' }, st.upToDate ? 'The target already has everything on this machine.' : st.remote ? 'There are local changes the target does not have yet.' : 'The target has nothing yet.'),
      st.open ? h('p', { class: 'small muted' }, `${st.open} pull request${st.open > 1 ? 's are' : ' is'} still open and will not be included until merged.`) : null,
      h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', disabled: st.upToDate, onclick: go(false) }, 'Publish'), h('button', { class: 'btn', onclick: go(true) }, 'Publish and switch this project to it'))]
      : h('div', { class: 'two' }, h('div', {}, h('label', {}, 'Where'), kind), h('div', {}, h('label', {}, 'Repository'), repo), h('div', {}, h('label', {}, 'Remote template'), tmpl), h('div', { class: 'row gap-t' }, h('button', { class: 'btn', onclick: set }, 'Set publish target'))));
}
