// Cloudflare plugin: scenario steps "cloudflare.dns" and "cloudflare.pages-deploy".
// Needs: the scenario lists "api.cloudflare.com" in allowHosts and "AF_CLOUDFLARE_TOKEN" in secrets; the token needs Zone:DNS:Edit and (for Pages) Pages:Edit.
// Dry runs call plan(), which only READS (zone and record lookups) so you see exactly what a real run would change. Not verified against live Cloudflare yet.
const API = 'https://api.cloudflare.com/client/v4';
export function register(api) {
  const cf = async (ctx, method, path, body) => {
    const token = api.secret('AF_CLOUDFLARE_TOKEN'); if (!token) throw new Error('AF_CLOUDFLARE_TOKEN is not set (add it to the secrets file)');
    const r = await api.safeFetch(ctx.scenario, { method, url: `${API}${path}`, headers: { Authorization: `Bearer ${token}` }, body }, ctx.fetch);
    if (!r.body?.success) throw new Error(`Cloudflare ${method} ${path.split('?')[0]} failed (${r.status}): ${(r.body?.errors ?? []).map((e) => e.message).join('; ') || JSON.stringify(r.body).slice(0, 200)}`);
    return r.body.result;
  };
  const zoneId = async (ctx, zone) => { const z = await cf(ctx, 'GET', `/zones?name=${encodeURIComponent(zone)}&status=active`); if (!z?.length) throw new Error(`No active Cloudflare zone named ${zone} for this token`); return z[0].id; };
  const wanted = (a) => ({ type: a.recordType ?? 'CNAME', name: a.name, content: a.content, ttl: 1, proxied: a.proxied !== false });
  const diff = async (ctx, a) => {
    const id = await zoneId(ctx, a.zone); const w = wanted(a); const have = await cf(ctx, 'GET', `/zones/${id}/dns_records?type=${w.type}&name=${encodeURIComponent(w.name)}`); const cur = have?.[0];
    if (!cur) return { id, action: 'create', record: w }; if (cur.content === w.content && !!cur.proxied === w.proxied) return { id, action: 'none', record: w }; return { id, action: 'update', recordId: cur.id, from: { content: cur.content, proxied: cur.proxied }, record: w };
  };
  api.registerStep('dns', {
    describe: (a) => `ensure ${a.recordType ?? 'CNAME'} ${a.name} → ${a.content} (proxied: ${a.proxied !== false}) in zone ${a.zone}`,
    validate: (a) => { for (const k of ['zone', 'name', 'content']) if (!a[k]) throw new Error(`cloudflare.dns needs "${k}"`); },
    plan: async (a, ctx) => { const d = await diff(ctx, a); return { change: d.action, ...(d.from ? { from: d.from } : {}), to: d.record }; },
    run: async (a, ctx) => { const d = await diff(ctx, a); if (d.action === 'none') return { change: 'none', detail: 'the record is already correct' }; const rec = d.action === 'create' ? await cf(ctx, 'POST', `/zones/${d.id}/dns_records`, d.record) : await cf(ctx, 'PUT', `/zones/${d.id}/dns_records/${d.recordId}`, d.record); return { change: d.action, recordId: rec?.id ?? d.recordId, name: d.record.name }; },
  });
  api.registerStep('pages-deploy', {
    describe: (a) => `trigger a Cloudflare Pages deployment of ${a.project} (account ${a.accountId})`,
    run: async (a, ctx) => { const d = await cf(ctx, 'POST', `/accounts/${a.accountId}/pages/projects/${a.project}/deployments`); return { deploymentId: d?.id, url: d?.url, environment: d?.environment }; },
  });
}
