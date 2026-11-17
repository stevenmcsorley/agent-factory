// Tiny allowlisting CONNECT proxy (runs inside the factory-egress container). HTTPS only; everything else denied.
// ALLOW="api.anthropic.com,registry.npmjs.org" ; a host matches if it equals an entry or is a subdomain of it.
import http from 'node:http';
import net from 'node:net';

export const hostAllowed = (host, allow) => {
  const h = host.toLowerCase().replace(/\.$/, '');
  return allow.some((a) => h === a || h.endsWith(`.${a}`));
};

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const allow = (process.env.ALLOW ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const server = http.createServer((req, res) => { console.log(`DENY non-CONNECT ${req.method} ${req.url}`); res.writeHead(403).end('forbidden'); });
  server.on('connect', (req, sock, head) => {
    const [host, port = '443'] = req.url.split(':');
    if (port !== '443' || !hostAllowed(host, allow)) { console.log(`DENY ${req.url}`); sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const up = net.connect(+port, host, () => { console.log(`ALLOW ${req.url}`); sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.write(head); up.pipe(sock); sock.pipe(up); });
    up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
  });
  server.listen(3128, () => console.log(`egress proxy up, allow=${allow.join(',')}`));
}
