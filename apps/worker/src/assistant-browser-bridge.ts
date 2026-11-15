import { randomUUID } from 'node:crypto';
import { BrowserHandoff, BrowserUnavailable, openIndependentBrowser, type BrowserDriver } from './assistant-browser-page.js';
import { classifyBrowserStartupFailure } from './assistant-browser-diagnostics.js';
import { browserIsolationDiagnostics } from './assistant-browser-isolation.js';
import { browserRpcRequest, browserRpcResult, type BrowserRpcReply } from './assistant-browser-rpc.js';

/** One instance is one account's disposable VM process, with no model or database API. */
export class BrowserRpcServer {
  private readonly lifetime = new AbortController();
  private driver?: BrowserDriver;
  private opening?: Promise<BrowserDriver>;
  private active?: { id:number; controller:AbortController };
  private grant?: { id:number; nonce:string; expires:number; settle:(value:boolean)=>void };
  private lastId = 0;
  private initialized = false;
  private closed = false;
  constructor(
    private readonly send:(reply:BrowserRpcReply)=>Promise<void>,
    private readonly open:typeof openIndependentBrowser = openIndependentBrowser,
    private readonly grantMs = 2000,
  ) {}

  async accept(input:unknown):Promise<void> {
    if (this.closed) return;
    const parsed = browserRpcRequest.safeParse(input);
    if (!parsed.success) { await this.close(); return; }
    const request = parsed.data;
    if (request.op === 'grant') {
      const pending = this.grant;
      if (pending?.id === request.id && pending.nonce === request.nonce)
        pending.settle(request.allow && Date.now() < pending.expires && !this.active?.controller.signal.aborted);
      return;
    }
    if (request.op === 'cancel') {
      if (this.active?.id === request.id) { this.active.controller.abort(); this.grant?.settle(false); }
      return;
    }
    if (request.id <= this.lastId || this.active) { await this.close(); return; }
    this.lastId = request.id;
    if (request.op === 'close') { await this.close(); await this.send({v:1,id:request.id,kind:'result',value:null}); return; }
    const controller = new AbortController();
    this.active = {id:request.id,controller};
    const signal = AbortSignal.any([this.lifetime.signal,controller.signal]);
    try {
      let value:unknown = null;
      if (request.op === 'open') {
        if (this.initialized) throw new BrowserUnavailable();
        this.initialized = true;
        this.opening = this.open(request.state ?? undefined,this.lifetime.signal);
        const driver = await this.opening;
        this.driver = driver;
        if (this.closed) { await driver.close(); return; }
      } else {
        if (!this.driver) throw new BrowserUnavailable();
        if (request.op === 'observe') value = await this.driver.observe();
        else if (request.op === 'frame') { const frame = await this.driver.frame(); value = {...frame,jpeg:frame.jpeg.toString('base64')}; }
        else if (request.op === 'state') value = await this.driver.state();
        else if (request.op === 'diagnostics') value = await browserIsolationDiagnostics();
        else {
          const current = () => this.permission(request.id,signal);
          if (request.op === 'execute') await this.driver.execute(request.action,current,signal);
          else await this.driver.manual(request.action,current,signal);
        }
      }
      signal.throwIfAborted();
      value = browserRpcResult(request.op,value);
      if (this.active?.id === request.id) this.active = undefined;
      await this.send({v:1,id:request.id,kind:'result',value});
    } catch (error) {
      if (this.closed) return;
      const code = signal.aborted ? 'CANCELED' : request.op === 'open' ? classifyBrowserStartupFailure(error)
        : error instanceof BrowserUnavailable ? 'UNAVAILABLE' : error instanceof BrowserHandoff ? 'HANDOFF' : 'HANDOFF';
      if (this.active?.id === request.id) this.active = undefined;
      await this.send({v:1,id:request.id,kind:'error',code}).catch(() => this.close());
    } finally {
      if (this.grant?.id === request.id) this.grant.settle(false);
      if (this.active?.id === request.id) this.active = undefined;
    }
  }

  private permission(id:number,signal:AbortSignal) {
    if (signal.aborted || this.closed || this.active?.id !== id || this.grant) return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
      const nonce = randomUUID(), expires = Date.now() + this.grantMs;
      const finish = (value:boolean) => {
        if (this.grant?.nonce !== nonce) return;
        this.grant = undefined;
        clearTimeout(timer); signal.removeEventListener('abort',abort);
        resolve(value && !signal.aborted && !this.closed);
      };
      const abort = () => finish(false);
      const timer = setTimeout(abort,this.grantMs);
      this.grant = {id,nonce,expires,settle:finish};
      signal.addEventListener('abort',abort,{once:true});
      void this.send({v:1,id,kind:'guard',nonce}).catch(abort);
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true; this.lifetime.abort(); this.active?.controller.abort(); this.grant?.settle(false);
    await this.driver?.close().catch(() => {});
    // If a launch completes late, it is disposed without accepting any session commands.
    if (this.opening && !this.driver) void this.opening.then(driver => driver.close()).catch(() => {});
  }
}
