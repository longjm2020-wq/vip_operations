import { pathToFileURL } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { BrowserRpcServer } from './assistant-browser-bridge.js';
import { BrowserRpcLines, encodeBrowserRpc } from './assistant-browser-rpc.js';

/** Standalone VM entry. Bundle only this dependency graph, never the worker/API entry. */
export function runBrowserRpc(input:Readable,output:Writable) {
  return new Promise<void>(resolve => {
    let ended = false;
    const send = (line:string) => new Promise<void>((done,reject) => {
      if (ended || output.destroyed) { reject(Error('BROWSER_RPC_CLOSED')); return; }
      output.write(line,error => error ? reject(Error('BROWSER_RPC_CLOSED')) : done());
    });
    const server = new BrowserRpcServer(reply => send(encodeBrowserRpc(reply)));
    const stop = () => {
      if (ended) return;
      ended = true; clearTimeout(deadline);
      input.removeListener('data',data); input.removeListener('end',stop); input.removeListener('error',stop); output.removeListener('error',stop);
      input.pause(); input.destroy();
      void server.close().finally(resolve);
    };
    const lines = new BrowserRpcLines(value => { void server.accept(value).catch(stop); });
    const data = (chunk:string) => { try { lines.push(chunk); } catch { stop(); } };
    // VM-local hard deadline also works if a controller dies without running its finally.
    const deadline = setTimeout(stop,30 * 60 * 1000);
    input.setEncoding('utf8'); input.on('data',data); input.once('end',stop); input.once('error',stop); output.once('error',stop);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Credentials are never accepted as RPC arguments or read by this entry point.
  await runBrowserRpc(process.stdin,process.stdout);
}
