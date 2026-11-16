import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BrowserRpcServer } from '../../apps/worker/src/assistant-browser-bridge.js';
import { RemoteBrowserDriver, type BrowserRpcTransport } from '../../apps/worker/src/assistant-browser-remote.js';
import { BrowserRpcLines, browserRpcRequest, browserRpcLimit, encodeBrowserRpc, type BrowserRpcReply } from '../../apps/worker/src/assistant-browser-rpc.js';
import type { BrowserDriver } from '../../apps/worker/src/assistant-browser-page.js';

function fixture() {
  const lifetime = new AbortController();
  let receive:(chunk:string)=>void = () => {}, closed:()=>void = () => {};
  const requests:unknown[] = [], replies:BrowserRpcReply[] = [], dispatches:string[] = [];
  const driver:BrowserDriver = {
    observe:vi.fn(async () => ({snapshotId:randomUUID(),url:'https://example.com/',title:'Example',text:'Hello',controls:[]})),
    frame:vi.fn(async () => ({jpeg:Buffer.from([255,216,255,217]),width:1280,height:800,url:'https://example.com/',title:'Example'})),
    state:vi.fn(async () => ({cookies:[],origins:[]})),
    execute:vi.fn(async (action,current,signal) => { if (!await current()) throw Error('BROWSER_ACTION_STALE'); signal.throwIfAborted(); dispatches.push(action.kind); }),
    manual:vi.fn(async (action,current,signal) => { if (!await current()) throw Error('BROWSER_ACTION_STALE'); signal.throwIfAborted(); dispatches.push('manual:'+action.kind); }),
    navigate:vi.fn(async (action,current,signal) => { if (!await current()) throw Error('BROWSER_ACTION_STALE'); signal.throwIfAborted(); dispatches.push('navigate:'+action.kind); }),
    close:vi.fn(async () => {}),
  };
  const open=vi.fn(async (_saved:unknown,_signal:AbortSignal) => driver);
  const server = new BrowserRpcServer(async reply => {
    replies.push(reply); receive(encodeBrowserRpc(reply));
  },open,100);
  const transport:BrowserRpcTransport = {
    write:vi.fn(async line => { const value:unknown=JSON.parse(line); requests.push(value); void server.accept(value); }),
    subscribe:(onChunk,onClose) => {receive=onChunk;closed=onClose;return () => {receive=()=>{};};},
    close:vi.fn(async () => {await server.close();closed();}),
  };
  const client=new RemoteBrowserDriver(transport,lifetime.signal,500);
  return {client,server,driver,open,transport,lifetime,requests,replies,dispatches,receive:(value:string)=>receive(value)};
}
const click={kind:'click' as const,ref:'bound-ref',description:'点击目标'};

describe('private browser RPC',() => {
  it('carries the published picture revision through manual RPC without accepting arbitrary identifiers',async()=>{
    const f=fixture();await f.client.initialize(null);const revision=randomUUID();
    await f.client.manual({kind:'click',x:100,y:100},async()=>true,new AbortController().signal,revision);
    expect(f.driver.manual).toHaveBeenCalledWith({kind:'click',x:100,y:100},expect.any(Function),expect.any(AbortSignal),revision);
    expect(browserRpcRequest.safeParse({v:1,id:9,op:'manual',action:{kind:'click',x:100,y:100},expectedRevision:'not-an-id'}).success).toBe(false);
    await f.client.close();
  });
  it('uses a typed navigation operation with a fresh permission check and never accepts internal URLs',async()=>{
    const f=fixture();await f.client.initialize(null);
    const current=vi.fn(async()=>true);
    await f.client.navigate({kind:'goto',url:'https://example.com/'},current,new AbortController().signal);
    await f.client.navigate({kind:'resize',viewport:{width:1920,height:900}},current,new AbortController().signal);
    expect(f.dispatches).toEqual(['navigate:goto','navigate:resize']);expect(current).toHaveBeenCalledTimes(2);
    await expect(f.client.navigate({kind:'reload'},async()=>false,new AbortController().signal)).rejects.toThrow('BROWSER_HANDOFF');
    expect(browserRpcRequest.safeParse({v:1,id:9,op:'navigate',action:{kind:'goto',url:'file:///secret'}}).success).toBe(false);
    expect(browserRpcRequest.safeParse({v:1,id:10,op:'navigate',action:{kind:'resize',viewport:{width:2561,height:900}}}).success).toBe(false);
    await f.client.close();
  });
  it('opens one owned session, returns bounded observations/frames and asks permission at dispatch',async () => {
    const f=fixture(); const state={cookies:[{name:'session',value:'owned-secret'}],origins:[]};
    await f.client.initialize(state);
    expect(f.open).toHaveBeenCalledWith(state,expect.any(AbortSignal));
    await expect(f.client.observe()).resolves.toMatchObject({title:'Example'});
    await expect(f.client.frame()).resolves.toMatchObject({jpeg:Buffer.from([255,216,255,217])});
    const current=vi.fn(async () => true);
    await f.client.execute(click,current,new AbortController().signal);
    expect(current).toHaveBeenCalledTimes(1);expect(f.dispatches).toEqual(['click']);
    expect(f.replies.some(reply => reply.kind==='guard')).toBe(true);
    await f.client.close();expect(f.driver.close).toHaveBeenCalledTimes(1);
  });
  it('denies a changed task and never dispatches or repeats it',async () => {
    const f=fixture();await f.client.initialize(null);
    await expect(f.client.execute(click,async()=>false,new AbortController().signal)).rejects.toThrow('BROWSER_HANDOFF');
    expect(f.dispatches).toEqual([]);
    await f.client.close();
  });
  it('pause invalidates the in-flight challenge; a late approval cannot revive it',async () => {
    const f=fixture();await f.client.initialize(null);
    let approve!:(allowed:boolean)=>void, checked!:()=>void;
    const began=new Promise<void>(resolve=>{checked=resolve;});
    const phase=new AbortController();
    const action=f.client.execute(click,async()=>{checked();return new Promise<boolean>(resolve=>{approve=resolve;});},phase.signal);
    await began;phase.abort();await expect(action).rejects.toThrow('BROWSER_CANCELED');
    approve(true);await new Promise(resolve=>setTimeout(resolve,0));
    expect(f.dispatches).toEqual([]);
    await expect(f.client.observe()).resolves.toMatchObject({title:'Example'});
    await f.client.close();
  });
  it('expires an unanswered grant and keeps a missing reply from causing input',async () => {
    const f=fixture();await f.client.initialize(null);
    await expect(f.client.execute(click,async()=>new Promise<boolean>(()=>{}),new AbortController().signal)).rejects.toThrow('BROWSER_HANDOFF');
    expect(f.dispatches).toEqual([]);await f.client.close();
  });
  it('rejects repeated request IDs, arbitrary code, file paths and extra fields',async () => {
    for(const input of [
      {v:1,id:1,op:'eval',code:'process.env'},
      {v:1,id:1,op:'open',state:'/etc/passwd'},
      {v:1,id:1,op:'execute',action:{...click,script:'unsafe'}},
      {v:1,id:1,op:'manual',action:{kind:'type',text:'secret'},userId:'someone'},
    ]) expect(browserRpcRequest.safeParse(input).success).toBe(false);
    const f=fixture();await f.client.initialize(null);
    await f.server.accept({v:1,id:1,op:'observe'});
    expect(f.driver.close).toHaveBeenCalledTimes(1);expect(f.driver.observe).not.toHaveBeenCalled();
    await f.client.close();
  });
  it('treats unknown replies and an oversized incomplete frame as fatal without outputting their data',async () => {
    const f=fixture();await f.client.initialize(null);
    f.receive('{"v":1,"id":999,"kind":"error","code":"secret raw failure"}\n');
    await expect(f.client.observe()).rejects.toThrow('BROWSER_UNAVAILABLE');
    const lines=new BrowserRpcLines(()=>{});
    expect(()=>lines.push('x'.repeat(browserRpcLimit+1))).toThrow('BROWSER_RPC_LIMIT');
    await f.client.close();
  });
  it('never forwards a raw browser error or credentials through an error reply',async () => {
    const f=fixture();await f.client.initialize(null);
    f.driver.observe=vi.fn(async()=>{throw Error('cookie=SECRET https://private.example/?token=SECRET');});
    await expect(f.client.observe()).rejects.toThrow('BROWSER_HANDOFF');
    expect(JSON.stringify(f.replies)).not.toContain('SECRET');
    await f.client.close();
  });
  it('closes its disposable runtime on lifetime stop and does not replay a manual action',async () => {
    const f=fixture();await f.client.initialize(null);await f.client.frame();
    await f.client.manual({kind:'type',text:'private-input'},async()=>true,new AbortController().signal);
    f.lifetime.abort();await f.client.close();
    expect(f.dispatches).toEqual(['manual:type']);expect(f.transport.close).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.replies)).not.toContain('private-input');
    await expect(f.client.manual({kind:'type',text:'private-input'},async()=>true,new AbortController().signal)).rejects.toThrow('BROWSER_UNAVAILABLE');
  });
  it('contains background cleanup rejection while awaited close reports an unconfirmed destroy',async () => {
    const f=fixture();await f.client.initialize(null);
    f.transport.close=vi.fn(async()=>{await f.server.close();throw Error('DESTROY_UNCONFIRMED');});
    f.lifetime.abort();
    await expect(f.client.close()).rejects.toThrow('DESTROY_UNCONFIRMED');
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(f.transport.close).toHaveBeenCalledTimes(1);
  });
});
