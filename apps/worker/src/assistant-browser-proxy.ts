import { randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { Agent, createServer, request, type IncomingHttpHeaders } from "node:http";
import { connect, isIP, type Socket } from "node:net";
import { browserPublicAddress, publicBrowserUrl } from "../../../packages/contracts/src/public-network.js";

export { browserPublicAddress, publicBrowserUrl } from "../../../packages/contracts/src/public-network.js";

type Address = { address: string; family: number };
type ProxyDependencies = {
  signal?: AbortSignal;
  resolve?: (hostname: string) => Promise<Address[]>;
  dial?: (address: string, port: number, family: number) => Socket;
};
const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
function forwardedHeaders(headers: IncomingHttpHeaders) {
  const result = { ...headers };
  const connection = String(headers.connection || '').split(',').map((name) => name.trim().toLowerCase());
  for (const name of [...connection, 'connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']) delete result[name];
  return result;
}

/** Every socket is connected to a previously checked numeric IP, never re-resolved. */
export async function createPublicBrowserProxy(dependencies: ProxyDependencies = {}) {
  const password = randomBytes(32).toString('hex'), username = 'xuti';
  const expected = Buffer.from('Basic ' + Buffer.from(username + ':' + password).toString('base64'));
  const sockets = new Set<Socket>();
  let closed = false;
  const resolve = dependencies.resolve || ((host: string) => lookup(host, { all: true, verbatim: true }));
  const dial = dependencies.dial || ((address, port, family) => connect({ host: address, port, family }));
  const authorized = (value: string | undefined) => {
    const supplied = Buffer.from(value || '');
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
  const pin = async (url: URL) => {
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await Promise.race([
        resolve(host),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(Error('BROWSER_DNS_TIMEOUT')), 5000); timeout.unref(); }),
      ]);
      if (closed || dependencies.signal?.aborted || !addresses.length || addresses.length > 64 || addresses.some((entry) => !browserPublicAddress(entry.address) || isIP(entry.address) !== entry.family)) throw Error('BROWSER_ADDRESS_BLOCKED');
      return addresses[0];
    } finally { clearTimeout(timeout); }
  };
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.setTimeout(60000, () => socket.destroy());
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 30000 }, (incoming, outgoing) => {
    if (!authorized(incoming.headers['proxy-authorization'])) {
      outgoing.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="Xuti browser"', Connection: 'close' }); outgoing.end(); return;
    }
    void (async () => {
      if (!methods.has(incoming.method || '') || closed) throw Error('BROWSER_METHOD_BLOCKED');
      const url = publicBrowserUrl(incoming.url || '');
      if (url.protocol !== 'http:') throw Error('BROWSER_TUNNEL_REQUIRED');
      const address = await pin(url);
      if (incoming.destroyed || outgoing.destroyed || closed) return;
      const headers = forwardedHeaders(incoming.headers);
      headers.host = url.host;
      // Supply our own connection: http.request cannot perform another DNS lookup.
      const agent = new Agent({ keepAlive: false });
      agent.createConnection = () => track(dial(address.address, 80, address.family));
      const upstream = request({ method: incoming.method, hostname: address.address, family: address.family, port: 80, path: url.pathname + url.search, headers, agent }, (response) => {
        outgoing.writeHead(response.statusCode || 502, forwardedHeaders(response.headers));
        response.on('error', () => outgoing.destroy());
        response.pipe(outgoing);
      });
      upstream.setTimeout(30000, () => upstream.destroy());
      upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      upstream.once('close', () => agent.destroy());
      incoming.once('aborted', () => upstream.destroy());
      outgoing.once('close', () => upstream.destroy());
      incoming.pipe(upstream);
    })().catch(() => { if (!outgoing.headersSent) outgoing.writeHead(403, { Connection: 'close' }); outgoing.end(); });
  });
  server.on('connection', (socket) => {
    if (closed || sockets.size >= 128) { socket.destroy(); return; }
    track(socket);
  });
  server.on('connect', (incoming, stream, head) => {
    const client = stream as Socket;
    if (!authorized(incoming.headers['proxy-authorization'])) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Xuti browser"\r\nConnection: close\r\n\r\n'); return; }
    void (async () => {
      const authority = incoming.url || '';
      if (!/^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+):443$/.test(authority)) throw Error('BROWSER_CONNECT_BLOCKED');
      const url = publicBrowserUrl('https://' + authority);
      const address = await pin(url);
      if (closed || client.destroyed) return;
      const upstream = track(dial(address.address, 443, address.family));
      const timer = setTimeout(() => upstream.destroy(), 10000); timer.unref();
      upstream.once('connect', () => {
        clearTimeout(timer);
        if (closed || client.destroyed) { upstream.destroy(); return; }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      upstream.once('error', () => client.destroy());
      upstream.once('close', () => { clearTimeout(timer); client.destroy(); });
      client.once('close', () => upstream.destroy());
    })().catch(() => client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
  });
  server.on('upgrade', (_request, socket) => socket.destroy()); // HTTPS WebSockets use the checked CONNECT tunnel.
  server.on('clientError', (_error, socket) => socket.destroy());
  const close = async () => {
    if (closed) return;
    closed = true;
    dependencies.signal?.removeEventListener('abort', abort);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  };
  const abort = () => { void close(); };
  dependencies.signal?.throwIfAborted();
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); done(); });
  });
  dependencies.signal?.addEventListener('abort', abort, { once: true });
  if (dependencies.signal?.aborted) { await close(); throw Error('BROWSER_PROXY_CANCELED'); }
  const address = server.address();
  if (!address || typeof address === 'string') { await close(); throw Error('BROWSER_PROXY_UNAVAILABLE'); }
  return { server: `http://127.0.0.1:${address.port}`, username, password, close };
}
