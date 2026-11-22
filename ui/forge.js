// Views for the local forge: review a pull request (diff, comments, merge, close) and publish the project to a real remote.
import { h, icon, api, ago, act } from './lib.js';
import { diffViewer } from './diff.js';

const card = (...kids) => h('section', { class: 'card' }, ...kids);
const TAG = { open: 'ok', merged: 'live', closed: '' };

export function prRowsLocal(prs, { open }) {
  if (!prs.length) return card(h('div', { class: 'empty' }, h('b', {}, 'No pull requests yet'), h('p', {}, 'When the factory finishes a ticket, its branch appears here for you to review and merge.')));
  return card(h('ul', { class: 'plain' }, prs.map((x) => h('li', { class: 'row between' }, h('button', { class: 'linklike', onclick: () => open(x.number) }, `#${x.number} ${x.title}`), h('small', { class: 'muted' }, x.branch)))));
}

export function prPage(d, { id, back, rerender }) {
  const pr = d.pr; const text = h('textarea', { rows: 3, placeholder: 'Comment for the factory. If you re-queue the ticket, it reads these.' });
  const post = (action, body, msg) => act(async () => { await api(`/projects/${id}/prs/${pr.number}/${action}`, { method: 'POST', body: typeof body === 'function' ? body() : body }); }, msg, rerender);
  const merge = act(async () => { if (!confirm(`Merge #${pr.number} into ${pr.base}? Its ticket closes with it.`)) return; await api(`/projects/${id}/prs/${pr.number}/merge`, { method: 'POST', body: {} }); }, 'Merged', rerender);
  const open = pr.state === 'open';
  return [h('button', { class: 'btn', onclick: back }, 'Back'),
    card(h('div', { class: 'row between' }, h('h1', {}, `#${pr.number} ${pr.title}`), h('span', { class: `stamp ${TAG[pr.state] ?? ''}` }, pr.state)),
      h('p', { class: 'small muted' }, `${pr.branch} → ${pr.base} · opened ${ago(pr.createdAt)}`),
      pr.stale ? h('div', { class: 'note warn' }, 'The branch has changed since the factory last verified it. Merge is blocked until it is re-run.') : null,
      h('pre', { class: 'log-pre' }, pr.body || ''),
      open ? h('div', { class: 'row gap-t' }, h('button', { class: 'btn primary', disabled: pr.stale, onclick: merge }, 'Merge and close the ticket'), h('button', { class: 'btn', title: 'Serve this branch on your machine so you can click around the site before merging', onclick: act(async () => { const r = await api(`/projects/${id}/live`, { method: 'POST', body: { pr: pr.number } }); window.open(r.url, '_blank', 'noopener'); }, 'Preview opened in a new tab (only this machine can see it)', rerender) }, icon('play', 13), 'Preview this branch'), h('button', { class: 'btn danger', title: 'The ticket is NOT done: it goes back to failed, and anything waiting on it keeps waiting. Your comment below goes on the ticket.', onclick: post('close', () => ({ reason: text.value.trim() || undefined }), 'Rejected: the ticket is marked failed') }, 'Reject (close without merging)'))
        : pr.state === 'merged' ? h('p', { class: 'small muted' }, `Merged as ${String(pr.mergedSha).slice(0, 10)}.`) : null),
    card(h('h2', {}, `Files changed (${d.files.length})`), d.diff ? diffViewer(d.diff) : h('p', { class: 'muted small' }, d.note ?? 'No changes.'), d.truncated ? h('p', { class: 'small muted' }, 'The diff was cut at 400 KB, so the last file may be incomplete.') : null),
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
