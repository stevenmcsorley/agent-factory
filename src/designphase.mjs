// Pure helpers for the design stage: which pages a ticket builds, how a page name maps to a design's area, and a cheap structural check of a built page
// against its approved design (headings and navigation). No I/O, so it can be tested without a factory.
const clean = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;|’/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();

export const htmlFiles = (text) => [...new Set([...String(text ?? '').matchAll(/`([a-z0-9][\w-]*\.html)`/gi)].map((m) => m[1].toLowerCase()))];
export const areaOfPage = (f) => String(f).replace(/\.html$/i, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'home';
export const pageOfArea = (a) => `${a}.html`;
// The pages a ticket builds: what its "Creates:" or "Builds:" lines name. (That is where a plan says what a ticket brings into existence.)
export function ticketPages(body) { const out = []; for (const l of String(body ?? '').split('\n')) if (/^\s*(creates|builds)\b/i.test(l)) out.push(...htmlFiles(l)); return [...new Set(out)]; }
export const planTickets = (plan) => (plan?.epics ?? []).flatMap((e) => e.tickets ?? []);
export const planPages = (plan) => [...new Set(planTickets(plan).flatMap((t) => ticketPages(t.body)))];

const tags = (html, re) => [...String(html ?? '').matchAll(re)].map((m) => clean(m[1])).filter(Boolean);
export const headingsOf = (html) => tags(html, /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi);
export const navLinksOf = (html) => { const nav = /<nav\b[\s\S]*?<\/nav>/i.exec(String(html ?? ''))?.[0] ?? ''; return tags(nav, /<a\b[^>]*>([\s\S]*?)<\/a>/gi); };
// How far the built page is from the design in structure: headings and navigation labels the design has and the page lacks. Words only; it says nothing about looks.
export function conformance(designHtml, builtHtml) {
  const dh = headingsOf(designHtml), bh = new Set(headingsOf(builtHtml)); const dn = navLinksOf(designHtml), bn = new Set(navLinksOf(builtHtml));
  const missingHeadings = dh.filter((h) => !bh.has(h)); const missingNav = dn.filter((n) => !bn.has(n));
  return { designHeadings: dh.length, designNav: dn.length, missingHeadings, missingNav, ok: !missingHeadings.length && !missingNav.length };
}
