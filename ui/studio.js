// The Studio: where you start things and steer them toward live (or just a prototype).
import { h, icon, api } from './lib.js';
import { intake } from './views.js';

const card = (cls, ...kids) => h('section', { class: `card ${cls ?? ''}` }, ...kids);
const STAGES = [['Idea', 'A brief and its sources', '#/new'], ['Prototype', 'Planned, built and reviewed: a demo you can show', '#/portfolio'], ['Build', 'The plan’s tickets merge, one dependency at a time', '#/portfolio'], ['Staging', 'Checks pass; a human approves going further', '#/scenarios'], ['Production', 'Your deploy scenario runs: DNS, hosting, smoke test', '#/scenarios'], ['Maintain', 'Alerts become tickets; parts get upgraded', '#/library']];

export const studio = {
  async load() { return { projects: await api('/overview').catch(() => []) }; },
  draw({ projects }, ctx) {
    const tile = (title, text, actions, cls = '') => card(`tile-card ${cls}`, h('h2', {}, title), h('p', { class: 'muted small' }, text), h('div', { class: 'row gap-t' }, actions));
    return [h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Studio'), h('p', { class: 'sub' }, 'Start, steer and ship projects. Pick a target for each one: a prototype you can show, or a deployment that goes live when the checks pass and you approve.'))),
      card('', h('div', { class: 'card-h' }, h('h2', {}, 'The path a project takes')), h('div', { class: 'lifecycle' }, STAGES.map(([t, d, href], i) => h('a', { class: 'lc', href }, h('b', {}, `${i + 1}. ${t}`), h('span', { class: 'muted small' }, d)))),
        h('p', { class: 'muted small' }, 'A project can stop at Prototype. Going further is a scenario (see Scenarios) with checks and a human approval, so “can we deploy yet?” always has a visible answer on the Portfolio.')),
      h('div', { class: 'bgrid' },
        tile('Start a new project', 'Write the brief (goal, scope, conventions), attach the PRD and designs, choose prototype or deploy, and let the agent draft a plan you approve.', [h('a', { class: 'btn primary', href: '#/new' }, icon('plus', 14), 'New project')]),
        tile('Connect an existing repo and tracker', 'Bring a repository and track the work in GitHub Issues, Ossicone, Jira or Linear. When a plan is launched its epics are created in your tracker too, with the tickets linked to them, so people and the AI read the same picture.', [h('a', { class: 'btn', href: '#/new', onclick: () => { try { sessionStorage.setItem('np', 'existing'); } catch { /* ignore */ } } }, 'Add a repository')]),
        tile('Run a scenario', 'Prototype only, ship to production, deploy to Cloudflare, or your own workflow, with dry runs and human approval gates.', [h('a', { class: 'btn', href: '#/scenarios' }, 'Open scenarios')]),
        tile('Reuse what you have', 'Parts, themes, forms and skills your other projects already built. The factory tells the agent what exists before it builds.', [h('a', { class: 'btn', href: '#/library' }, 'Open the library')])),
      projects.length ? card('', h('div', { class: 'card-h' }, h('h2', {}, 'Add work to a project'), h('span', { class: 'muted small' }, 'For one specific change. Bigger things belong in a plan.')), intake(projects, ctx.rerender)) : null];
  },
};
