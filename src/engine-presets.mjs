// Engine methods for setups (see presets.mjs). Installed on Engine.prototype (see the bottom of engine.mjs).
import { BUILTIN, normalizePreset, OPTIONAL } from './presets.mjs';
const bad = (m, status = 400) => Object.assign(new Error(m), { status });

export const presetMethods = {
  _allPresets() { const out = {}; for (const [k, v] of Object.entries(BUILTIN)) out[k] = { name: k, builtin: true, ...v }; for (const [k, v] of Object.entries(this.cfg.presets ?? {})) out[k] = { name: k, builtin: false, ...v }; return out; },
  presets() { return { presets: Object.values(this._allPresets()), active: this.cfg.preset ?? null, newProject: this.cfg.newProjectPreset ?? null, current: this._currentSetup() }; },
  // What the factory is set up as right now, in the same shape as a setup, so "save the current setup" is exact.
  _currentSetup() { const a = this.cfg.agent; const roles = {}; for (const [r, v] of Object.entries(this.cfg.roles ?? {})) if (v?.agent && Object.keys(v.agent).length) roles[r] = { ...v.agent }; return { agent: { model: a.model ?? null, reasoningEffort: a.reasoningEffort ?? null }, roles }; },
  savePreset(input = {}) {
    const name = String(input.name ?? '').toLowerCase(); if (BUILTIN[name]) throw bad(`"${name}" is a built-in setup. Choose another name.`);
    const base = input.fromCurrent ? { ...this._currentSetup(), projectRoles: input.projectRoles ?? {} } : input; const p = normalizePreset({ ...base, name: input.name, label: input.label, description: input.description }, { name: input.name });
    this.cfg.presets = { ...(this.cfg.presets ?? {}), [p.name]: (({ name: _n, ...rest }) => rest)(p) }; this._persist(); this._audit({ what: 'preset', action: 'saved', name: p.name }); return this._allPresets()[p.name];
  },
  deletePreset(name) { if (BUILTIN[name]) throw bad('A built-in setup cannot be deleted'); if (!this.cfg.presets?.[name]) throw bad(`No setup called "${name}"`, 404); delete this.cfg.presets[name]; if (!Object.keys(this.cfg.presets).length) delete this.cfg.presets; if (this.cfg.preset === name) delete this.cfg.preset; if (this.cfg.newProjectPreset === name) delete this.cfg.newProjectPreset; this._persist(); this._audit({ what: 'preset', action: 'deleted', name }); return { deleted: true }; },
  // Make the factory match a setup: default model and effort, and each role's model and effort (replacing earlier per-role choices). Optionally also switch the optional roles on or off for some projects.
  applyPreset(name, { projects, makeDefault } = {}) {
    const p = this._allPresets()[name]; if (!p) throw bad(`No setup called "${name}"`, 404);
    const ag = this.settings().agent; const fit = (v = {}) => ({ ...(ag.acceptsModel && v.model !== undefined ? { model: v.model } : {}), ...(ag.acceptsEffort && v.reasoningEffort !== undefined ? { reasoningEffort: v.reasoningEffort } : {}) });   // an agent type with no model or effort setting simply skips those keys
    const ids = projects === 'all' ? this.cfg.projects.map((x) => x.id) : Array.isArray(projects) ? projects : []; for (const id of ids) this.project(id);   // an unknown project id is refused before anything changes
    if (p.agent && Object.keys(fit(p.agent)).length) this.setSettings({ agent: fit(p.agent) });
    const clear = {}; for (const r of Object.keys(this.cfg.roles ?? {})) if (this.cfg.roles[r]?.agent) clear[r] = { agent: { model: null, reasoningEffort: null } };
    const set = { ...clear }; for (const [r, v] of Object.entries(p.roles ?? {})) if (Object.keys(fit(v)).length) set[r] = { agent: { model: null, reasoningEffort: null, ...fit(v) } };
    if (Object.keys(set).length) this.setRoles(set);
    for (const id of ids) this._applyProjectRoles(this.project(id), p.projectRoles);
    this.cfg.preset = name; if (makeDefault) this.cfg.newProjectPreset = name; this._persist(); this._audit({ what: 'preset', action: 'applied', name, projects: ids.length, makeDefault: !!makeDefault });
    return { applied: name, projects: ids, ...this.presets() };
  },
  _applyProjectRoles(proj, projectRoles = {}) { const next = { ...(proj.roles ?? {}) }; for (const r of OPTIONAL) if (typeof projectRoles[r] === 'boolean') next[r] = { enabled: projectRoles[r] }; if (Object.keys(next).length) proj.roles = next; },
  setNewProjectPreset(name) { if (name !== null && !this._allPresets()[name]) throw bad(`No setup called "${name}"`, 404); if (name === null) delete this.cfg.newProjectPreset; else this.cfg.newProjectPreset = name; this._persist(); this._audit({ what: 'preset', action: 'new-project-default', name }); return { newProject: name }; },
  // Every project created from now on starts with the default setup's optional roles.
  _applyNewProjectDefaults(proj) { const n = this.cfg.newProjectPreset; const p = n ? this._allPresets()[n] : null; if (p) this._applyProjectRoles(proj, p.projectRoles); },
};
