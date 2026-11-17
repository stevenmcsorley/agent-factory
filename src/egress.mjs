import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// Agent containers join an --internal docker network (no route out). The only way out is the allowlisting proxy
// container, which is attached to both that network and the default bridge. Idempotent; recreated on each start so
// allowlist changes take effect.
export async function startEgress({ allow, network = 'factory-agents', name = 'factory-egress', image = 'node:22-bookworm' }) {
  const d = async (...a) => run('docker', a);
  await d('rm', '-f', name);
  const n = await d('network', 'create', '--internal', network);
  if (n.code !== 0 && !/already exists/.test(n.out)) throw new Error(`network create failed: ${n.out}`);
  const r = await d('run', '-d', '--name', name, '--restart', 'unless-stopped', '-e', `ALLOW=${allow.join(',')}`,
    '-v', `${path.join(here, 'egress-proxy.mjs')}:/proxy.mjs:ro`, image, 'node', '/proxy.mjs');
  if (r.code !== 0) throw new Error(`proxy start failed: ${r.out}`);
  const c = await d('network', 'connect', network, name);
  if (c.code !== 0) throw new Error(`network connect failed: ${c.out}`);
  const proxy = `http://${name}:3128`;
  return {
    network,
    env: { HTTPS_PROXY: proxy, https_proxy: proxy, HTTP_PROXY: proxy, http_proxy: proxy, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    logs: async () => (await d('logs', name)).out,
    stop: () => d('rm', '-f', name),
  };
}
