import type { BrowserViewport } from '../../../packages/contracts/src/assistant-browser.js';
import { BrowserHandoff, BrowserUnavailable, type BrowserDriver } from './assistant-browser-page.js';
import { BrowserRpcLines, browserRpcReply, browserRpcRequest, browserRpcResult, encodeBrowserRpc, type BrowserRpcRequest, type BrowserRpcError } from './assistant-browser-rpc.js';

/** Implemented by an authenticated ephemeral exec. No URL, shell, or eval parameter. */
export type BrowserRpcTransport = {
  write(line:string):Promise<void>;
  subscribe(chunk:(value:string)=>void,closed:()=>void):()=>void;
  close():Promise<void>;
};
type Pending = {
  id:number; op:BrowserRpcRequest['op']; current?:()=>Promise<boolean>; signal?:AbortSignal;
  grantUsed:boolean; canceled:boolean; settle:(error:Error|null,value?:unknown)=>void;
};
function failure(code:BrowserRpcError):Error {
  if (code === 'HANDOFF') return new BrowserHandoff('页面已变化或需要人工确认，请核对独立浏览器当前画面后继续');
  if (code === 'CANCELED') return new DOMException('BROWSER_CANCELED','AbortError');
  if (code === 'UNAVAILABLE' || code === 'PROTOCOL') return new BrowserUnavailable();
  return Object.assign(new Error(code),{code});
}

/** Fixed RPC driver: one in-flight call and no retries of potentially dispatched inputs. */
export class RemoteBrowserDriver implements BrowserDriver {
  private nextId = 0;
  private pending?:Pending;
  private closed = false;
  private closing?:Promise<void>;
  private unsubscribe:()=>void = () => {};
  private readonly abort:()=>void;
  constructor(private readonly transport:BrowserRpcTransport, private readonly lifetime:AbortSignal, private readonly timeoutMs=35000) {
    this.abort = () => { this.safeClose(); };
    const lines = new BrowserRpcLines(value => this.receive(value));
    this.unsubscribe = transport.subscribe(chunk => {
      if (this.closed) return;
      try { lines.push(chunk); } catch { this.safeClose(); }
    },() => { this.safeClose(); });
    lifetime.addEventListener('abort',this.abort,{once:true});
    if (lifetime.aborted) this.abort();
  }
  async initialize(state:unknown, viewport?:BrowserViewport) { await this.call({op:'open',state:state ?? null,viewport}); return this; }
  async observe() { return browserRpcResult('observe',await this.call({op:'observe'})) as Awaited<ReturnType<BrowserDriver['observe']>>; }
  async frame() {
    const value = browserRpcResult('frame',await this.call({op:'frame'})) as {jpeg:string;width:number;height:number;url:string;title:string;revision?:string};
    return {...value,jpeg:Buffer.from(value.jpeg,'base64')};
  }
  async state() { return this.call({op:'state'}); }
  async diagnostics() { return this.call({op:'diagnostics'}); }
  async execute(action:Parameters<BrowserDriver['execute']>[0],current:()=>Promise<boolean>,signal:AbortSignal) {
    await this.call({op:'execute',action},current,signal);
  }
  async manual(action:Parameters<BrowserDriver['manual']>[0],current:()=>Promise<boolean>,signal:AbortSignal,expectedRevision?:string) {
    await this.call({op:'manual',action,...expectedRevision?{expectedRevision}:{}},current,signal);
  }
  async navigate(action:Parameters<BrowserDriver['navigate']>[0],current:()=>Promise<boolean>,signal:AbortSignal) {
    await this.call({op:'navigate',action},current,signal);
  }

  private async call(request:Omit<Extract<BrowserRpcRequest,{op:'open'}>,'v'|'id'> | Omit<Extract<BrowserRpcRequest,{op:'execute'}>,'v'|'id'> | Omit<Extract<BrowserRpcRequest,{op:'manual'}>,'v'|'id'> | Omit<Extract<BrowserRpcRequest,{op:'navigate'}>,'v'|'id'> | {op:'observe'|'frame'|'state'|'diagnostics'},current?:()=>Promise<boolean>,signal?:AbortSignal):Promise<unknown> {
    if (this.closed || this.pending || this.nextId >= 2147483646) throw new BrowserUnavailable();
    this.lifetime.throwIfAborted(); signal?.throwIfAborted();
    const id = ++this.nextId;
    const line = encodeBrowserRpc(browserRpcRequest.parse({v:1,id,...request}));
    return new Promise((resolve,reject) => {
      const settle = (error:Error|null,value?:unknown) => {
        if (this.pending?.id !== id) return;
        this.pending = undefined; clearTimeout(timer); signal?.removeEventListener('abort',abort);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => {
        if (this.pending?.id !== id) return;
        this.pending.canceled = true;
        // Wait for a canceled acknowledgement before accepting another command.
        void this.transport.write(encodeBrowserRpc({v:1,id,op:'cancel'})).catch(() => this.safeClose());
      };
      const timer = setTimeout(() => { settle(new BrowserUnavailable()); this.safeClose(); },this.timeoutMs);
      this.pending = {id,op:request.op,current,signal,grantUsed:false,canceled:false,settle};
      signal?.addEventListener('abort',abort,{once:true});
      void this.transport.write(line).catch(() => this.safeClose());
    });
  }

  private receive(input:unknown) {
    const parsed = browserRpcReply.safeParse(input), pending = this.pending;
    if (!parsed.success || !pending || parsed.data.id !== pending.id) { this.safeClose(); return; }
    const reply = parsed.data;
    if (reply.kind === 'guard') {
      if (!pending.current || pending.grantUsed) { this.safeClose(); return; }
      pending.grantUsed = true;
      const deadline = Date.now() + 1500;
      let timer:ReturnType<typeof setTimeout>;
      const check = Promise.race([Promise.resolve().then(pending.current).catch(() => false),new Promise<boolean>(resolve => { timer=setTimeout(() => resolve(false),1500); })]);
      void check.then(allowed => {
        clearTimeout(timer!);
        const allow = allowed === true && !this.closed && this.pending === pending && !pending.canceled && !pending.signal?.aborted && Date.now() < deadline;
        if (!this.closed) return this.transport.write(encodeBrowserRpc({v:1,id:reply.id,op:'grant',nonce:reply.nonce,allow}));
      }).catch(() => this.safeClose());
      return;
    }
    if (pending.canceled || pending.signal?.aborted) { pending.settle(failure('CANCELED')); return; }
    if (reply.kind === 'error') { pending.settle(failure(reply.code)); return; }
    try { pending.settle(null,browserRpcResult(pending.op,reply.value)); }
    catch { pending.settle(new BrowserUnavailable()); this.safeClose(); }
  }

  private safeClose() { void this.close().catch(() => {}); }

  close():Promise<void> {
    if (this.closing) return this.closing;
    if (this.closed) return Promise.resolve();
    this.closed = true; this.lifetime.removeEventListener('abort',this.abort); this.unsubscribe();
    this.pending?.settle(new BrowserUnavailable());
    // Closing the authenticated ephemeral channel must kill and destroy its one VM.
    this.closing = this.transport.close();
    return this.closing;
  }
}

export async function openRemoteBrowser(transport:BrowserRpcTransport,saved:unknown,signal:AbortSignal,initialViewport?:BrowserViewport) {
  const driver = new RemoteBrowserDriver(transport,signal);
  try { return await driver.initialize(saved, initialViewport); }
  catch (error) { await driver.close().catch(() => {}); throw error; }
}
