// Runs INSIDE the visual-check container (image agent-factory-visual), never on the host.
// Reads /work/.factory-visual/spec.json, waits for the project's dev server, loads every route at phone, tablet and desktop widths
// (and a dark pass where the page supports it), and writes screenshots plus report.json into /work/.factory-visual/out/.
// It only observes: it never clicks, types or submits anything.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/work/.factory-visual'; const OUT = path.join(ROOT, 'out');
const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec.json'), 'utf8'));
fs.mkdirSync(OUT, { recursive: true });
const { chromium } = await import('/opt/pw/node_modules/playwright/index.mjs');
const base = `http://127.0.0.1:${spec.port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for the server the project's own command started.
const deadline = Date.now() + (spec.startTimeoutSec ?? 90) * 1000; let up = false;
while (Date.now() < deadline) { try { const r = await fetch(base + (spec.readyPath ?? '/'), { redirect: 'manual' }); if (r.status < 500) { up = true; break; } } catch { /* not yet */ } await sleep(750); }
if (!up) { fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ ok: false, error: `The app did not answer on port ${spec.port} within ${spec.startTimeoutSec ?? 90} seconds` })); process.exit(0); }

// Measured inside the page. Plain function: serialised and run by Playwright.
function measure({ phone }) {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
  const sel = (el) => { const id = el.id ? `#${el.id}` : ''; const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''; return `${el.tagName.toLowerCase()}${id}${cls}`.slice(0, 80); };
  const out = { overflow: null, tapTargets: [], contrast: [] };
  const sw = document.documentElement.scrollWidth, iw = window.innerWidth;
  if (sw > iw + 1) { const wide = [...document.querySelectorAll('body *')].filter((el) => vis(el) && el.getBoundingClientRect().right > iw + 1).slice(0, 5).map(sel); out.overflow = { scrollWidth: sw, innerWidth: iw, elements: wide }; }
  if (phone) {
    for (const el of document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=link]')) {
      if (!vis(el) || el.closest('[aria-hidden=true]')) continue; const r = el.getBoundingClientRect();
      if ((r.width < 44 || r.height < 44) && !(el.tagName === 'A' && getComputedStyle(el).display === 'inline')) out.tapTargets.push({ el: sel(el), w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30) });
    }
    out.tapTargets = out.tapTargets.slice(0, 12);
  }
  const parse = (c) => { const m = /rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?\)/.exec(c); return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const bgOf = (el) => { const layers = []; for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.backgroundImage !== 'none') return null; const c = parse(s.backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } } let bg = { r: 255, g: 255, b: 255, a: 1 }; for (const c of layers.reverse()) bg = over(c, bg); return bg; };
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode());) {
    if (!n.nodeValue.trim()) continue; const el = n.parentElement; if (!el || seen.has(el) || !vis(el) || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName)) continue; seen.add(el);
    const s = getComputedStyle(el); const fg = parse(s.color); const bg = bgOf(el); if (!fg || !bg) continue;
    const top = over(fg, bg); const l1 = lum(top), l2 = lum(bg); const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const size = parseFloat(s.fontSize); const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700); const need = large ? 3 : 4.5;
    if (ratio < need) out.contrast.push({ el: sel(el), ratio: Math.round(ratio * 100) / 100, need, text: n.nodeValue.trim().slice(0, 30) });
  }
  out.contrast = out.contrast.slice(0, 12); return out;
}

const slug = (route) => (route === '/' ? 'home' : route.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/-+$/, '').slice(0, 40) || 'page');
const VIEWPORTS = [{ w: 360, h: 740, phone: true }, { w: 768, h: 1024 }, { w: 1280, h: 800 }];
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const pages = [];
for (const route of spec.routes) {
  for (const vp of VIEWPORTS) {
    for (const scheme of ['light', 'dark']) {
      if (scheme === 'dark' && vp.w === 768) continue;       // keep the run short: dark is checked on the narrowest and widest
      const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, colorScheme: scheme, deviceScaleFactor: 1 });
      const page = await ctx.newPage(); const consoleErrors = []; const failed = [];
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
      page.on('pageerror', (e) => consoleErrors.push(`Uncaught: ${String(e.message ?? e).slice(0, 200)}`));
      page.on('response', (r) => { if (r.url().startsWith(base) && r.status() >= 400) failed.push(`${r.status()} ${new URL(r.url()).pathname}`.slice(0, 120)); });
      let status = null, error = null;
      try { const r = await page.goto(base + route, { waitUntil: 'load', timeout: 30000 }); status = r?.status() ?? null; await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {}); await sleep(400); } catch (e) { error = String(e.message ?? e).slice(0, 200); }
      let m = { overflow: null, tapTargets: [], contrast: [] }; let shot = null;
      if (!error) { try { m = await page.evaluate(measure, { phone: !!vp.phone }); } catch (e) { error = `measure failed: ${String(e.message ?? e).slice(0, 120)}`; }
        shot = `${slug(route)}-${vp.w}-${scheme}.png`; try { await page.screenshot({ path: path.join(OUT, shot), fullPage: true, timeout: 15000 }); } catch { shot = null; } }
      pages.push({ route, width: vp.w, scheme, status, error, shot, consoleErrors: [...new Set(consoleErrors)].slice(0, 5), failedRequests: [...new Set(failed)].slice(0, 5), ...m });
      await ctx.close();
    }
  }
}
await browser.close();
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ ok: true, pages }));
