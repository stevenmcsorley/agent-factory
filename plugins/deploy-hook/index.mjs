// Deploy-hook plugin: scenario step "deploy-hook.trigger" POSTs to a hook URL. The scenario must list the hook's host in allowHosts.
// Example step: { "id": "deploy", "type": "deploy-hook.trigger", "url": "https://api.netlify.com/build_hooks/abc", "bearer": "{{secret:AF_DEPLOY_HOOK_TOKEN}}" }
export function register(api) {
  api.registerStep('trigger', {
    describe: (a) => `POST ${a.url} to trigger a deployment`,
    run: async (a, ctx) => { const r = await api.safeFetch(ctx.scenario, { method: a.method ?? 'POST', url: a.url, headers: a.bearer ? { Authorization: `Bearer ${a.bearer}` } : {}, body: a.body }, ctx.fetch); if (r.status >= 300) throw new Error(`the hook answered ${r.status}`); return { status: r.status, body: r.body }; },
  });
}
