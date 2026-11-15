import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request } from 'node:http';
import { connect, createServer as createTcpServer, type Server } from 'node:net';
import { browserPublicAddress, createPublicBrowserProxy, publicBrowserUrl } from '../../apps/worker/src/assistant-browser-proxy.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function listen(server: Server) {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanup.push(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('test server');
  return address.port;
}
type Proxy = Awaited<ReturnType<typeof createPublicBrowserProxy>>;
function httpThrough(proxy: Proxy, url: string, authenticate = true) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const endpoint = new URL(proxy.server);
    const req = request({ host: endpoint.hostname, port: endpoint.port, path: url, headers: authenticate ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64') } : {} }, (res) => {
      let body = ''; res.setEncoding('utf8'); res.on('data', (chunk) => body += chunk); res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject); req.end();
  });
}
describe('isolated browser network boundary', () => {
  it.each(['127.0.0.1','0.0.0.0','10.2.3.4','172.16.0.1','192.168.1.1','169.254.169.254','100.100.100.200','198.18.0.1','192.0.2.1','203.0.113.2','224.0.0.1','255.255.255.255','::1','fe80::1','fd00::1','::ffff:127.0.0.1','64:ff9b::7f00:1','2002:7f00:1::','2001:db8::1','3fff::1'])('rejects nonpublic address %s', (value) => expect(browserPublicAddress(value)).toBe(false));
  it.each(['8.8.8.8','1.1.1.1','2606:4700:4700::1111','2001:4860:4860::8888'])('permits global address %s', (value) => expect(browserPublicAddress(value)).toBe(true));
  it.each(['http://2130706433/','http://0x7f000001/','http://127.1/','http://example.com:8080/','https://user:secret@example.com/','file:///etc/passwd','http://db.railway.internal/','http://localhost./','http://[::ffff:127.0.0.1]/'])('blocks URL %s', (url) => expect(() => publicBrowserUrl(url)).toThrow());
  it('requires proxy authentication before doing any DNS or network work', async () => {
    const resolve = vi.fn(), dial = vi.fn();
    const proxy = await createPublicBrowserProxy({ resolve, dial }); cleanup.push(proxy.close);
    expect((await httpThrough(proxy, 'http://example.com/', false)).status).toBe(407);
    expect(resolve).not.toHaveBeenCalled(); expect(dial).not.toHaveBeenCalled();
  });
  it('rejects mixed public/private DNS answers without opening a socket', async () => {
    const dial = vi.fn();
    const proxy = await createPublicBrowserProxy({ resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }], dial }); cleanup.push(proxy.close);
    expect((await httpThrough(proxy, 'http://public.example/')).status).toBe(403);
    expect(dial).not.toHaveBeenCalled();
  });
  it('pins the actual HTTP socket to the checked address and strips proxy credentials', async () => {
    const upstream = createServer((req, res) => res.end(JSON.stringify({ host: req.headers.host, authorization: req.headers['proxy-authorization'] || null, path: req.url })));
    const port = await listen(upstream);
    const resolve = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
    const dial = vi.fn((_address: string, _port: number, _family: number) => connect({ host: '127.0.0.1', port }));
    const proxy = await createPublicBrowserProxy({ resolve, dial }); cleanup.push(proxy.close);
    const result = await httpThrough(proxy, 'http://public.example/observed?q=1');
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ host: 'public.example', authorization: null, path: '/observed?q=1' });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(dial).toHaveBeenCalledWith('8.8.8.8', 80, 4);
  });
  it('pins HTTPS CONNECT, forwards its buffered head, and closes tunnels on abort', async () => {
    const upstream = createTcpServer((socket) => socket.on('data', (chunk) => socket.write(chunk)));
    const port = await listen(upstream), controller = new AbortController();
    const dial = vi.fn((_address: string, _port: number, _family: number) => connect({ host: '127.0.0.1', port }));
    const proxy = await createPublicBrowserProxy({ signal: controller.signal, resolve: async () => [{ address: '1.1.1.1', family: 4 }], dial }); cleanup.push(proxy.close);
    const endpoint = new URL(proxy.server);
    const client = connect({ host: endpoint.hostname, port: Number(endpoint.port) });
    client.on('error', () => {});
    const seen = new Promise<string>((done) => { let text = ''; client.on('data', (chunk) => { text += chunk.toString(); if (text.includes('buffered-probe')) done(text); }); });
    client.write(`CONNECT public.example:443 HTTP/1.1\r\nHost: public.example:443\r\nProxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n\r\nbuffered-probe`);
    expect(await seen).toContain('200 Connection Established');
    expect(dial).toHaveBeenCalledWith('1.1.1.1', 443, 4);
    const ended = new Promise<void>((done) => client.once('close', () => done()));
    controller.abort(); await ended;
  });
});
