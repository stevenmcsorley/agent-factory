// When may a project be worked on? A project can carry a schedule:
//   startAt        ISO date or datetime: nothing runs before it ("start this one on Monday")
//   windows        [{ days: [0..6] (0 = Sunday, empty = every day), from: "22:00", to: "06:00" }]  a window may cross midnight
//   hoursPerDay    most agent time per local day, counted from the runs already recorded ("5 hours a day")
//   priority       1 (first) to 9 (last): who goes first when many projects are due
//   stopWhenDone   pause the project by itself when its plan has no open tickets left
// Pure functions of (schedule, now, usedMsToday), so every answer is testable and the UI can say exactly why something is not running.
const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const bad = (m) => Object.assign(new Error(m), { status: 400 });
const mins = (s) => { const m = HHMM.exec(s); return Number(m[1]) * 60 + Number(m[2]); };

export function normalizeSchedule(input) {
  if (input === null || input === undefined || input === false) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw bad('schedule must be an object');
  const out = {};
  if (input.startAt) { const t = Date.parse(input.startAt); if (!Number.isFinite(t)) throw bad('startAt must be a date, like 2026-12-01 or 2026-12-01T09:00'); out.startAt = String(input.startAt).slice(0, 40); }
  if (input.hoursPerDay !== undefined && input.hoursPerDay !== null && input.hoursPerDay !== '') { const h = Number(input.hoursPerDay); if (!Number.isFinite(h) || h <= 0 || h > 24) throw bad('hoursPerDay must be more than 0 and at most 24'); out.hoursPerDay = Math.round(h * 100) / 100; }
  if (input.priority !== undefined && input.priority !== null && input.priority !== '') { const p = Number(input.priority); if (!Number.isInteger(p) || p < 1 || p > 9) throw bad('priority must be a whole number from 1 (first) to 9'); out.priority = p; }
  if (input.windows !== undefined) {
    if (!Array.isArray(input.windows) || input.windows.length > 14) throw bad('windows must be a list of up to 14');
    out.windows = input.windows.map((w) => {
      if (!HHMM.test(w?.from ?? '') || !HHMM.test(w?.to ?? '')) throw bad('each window needs from and to as HH:MM (24 hour)');
      if (w.from === w.to) throw bad('a window cannot start and end at the same time');
      const days = [...new Set((Array.isArray(w.days) ? w.days : []).map(Number))]; if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw bad('days are 0 (Sunday) to 6 (Saturday)');
      return { days: days.sort(), from: w.from, to: w.to };
    });
  }
  if (input.stopWhenDone !== undefined) out.stopWhenDone = !!input.stopWhenDone;
  return Object.keys(out).length ? out : null;
}

const startMs = (s) => { const t = Date.parse(s); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`).getTime() : t; };   // a bare date means local midnight

// Is `now` inside one of the windows? Returns the end of the current window (ms) or the start of the next one.
function windowState(windows, now) {
  const d = new Date(now), minute = d.getHours() * 60 + d.getMinutes(), day = d.getDay();
  for (const w of windows) {
    const a = mins(w.from), b = mins(w.to), has = (x) => !w.days.length || w.days.includes(x);
    const inside = a < b ? has(day) && minute >= a && minute < b : (has(day) && minute >= a) || (has((day + 6) % 7) && minute < b);   // after midnight the window belongs to the day it started on
    if (inside) return { inside: true };
  }
  let next = Infinity;
  for (let k = 0; k <= 7; k++) for (const w of windows) {
    const day = new Date(now); day.setDate(day.getDate() + k); day.setHours(0, 0, 0, 0);
    if (w.days.length && !w.days.includes(day.getDay())) continue;
    const t = day.getTime() + mins(w.from) * 60_000; if (t > now && t < next) next = t;
  }
  return { inside: false, next: Number.isFinite(next) ? next : null };
}

// -> { allowed, reason?, code?, nextAt? }
export function scheduleState(schedule, now = Date.now(), usedMsToday = 0) {
  if (!schedule) return { allowed: true };
  if (schedule.startAt && now < startMs(schedule.startAt)) return { allowed: false, code: 'not-started', reason: `starts ${new Date(startMs(schedule.startAt)).toLocaleString()}`, nextAt: new Date(startMs(schedule.startAt)).toISOString() };
  if (schedule.windows?.length) { const w = windowState(schedule.windows, now); if (!w.inside) return { allowed: false, code: 'outside-window', reason: w.next ? `outside its working hours; next window ${new Date(w.next).toLocaleString()}` : 'outside its working hours', ...(w.next ? { nextAt: new Date(w.next).toISOString() } : {}) }; }
  if (schedule.hoursPerDay && usedMsToday >= schedule.hoursPerDay * 3_600_000) { const t = new Date(now); t.setHours(24, 0, 0, 0); return { allowed: false, code: 'hours-used', reason: `used its ${schedule.hoursPerDay} hour${schedule.hoursPerDay === 1 ? '' : 's'} for today`, nextAt: t.toISOString() }; }
  return { allowed: true };
}

// Agent time a project has used since local midnight, from finished run records ({ project, started, finished }).
export function usedToday(runs, projectId, now = Date.now()) {
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0); const from = midnight.getTime();
  let ms = 0;
  for (const r of runs) { if (r.project !== projectId || !r.started || !r.finished) continue; const a = Date.parse(r.started), b = Date.parse(r.finished); if (b > from && b > a) ms += b - Math.max(a, from); }
  return ms;
}
