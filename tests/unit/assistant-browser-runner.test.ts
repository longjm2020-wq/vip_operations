import { describe, expect, it, vi } from 'vitest';
import type { BrowserRun } from '../../apps/api/src/modules/workspace/assistant-browser.js';
import type { BrowserAction } from '../../packages/contracts/src/assistant-browser.js';
import type { BrowserDriver } from '../../apps/worker/src/assistant-browser-page.js';
import { runIndependentBrowser, safeBrowserFailure, type BrowserStore } from '../../apps/worker/src/assistant-browser-runner.js';

function setup() {
  const initial: BrowserRun = { id:'task',userId:'1',profileId:'profile',profileVersion:1,leaseId:'lease',epoch:0,instruction:'打开目标页面',initialUrl:'',url:'',status:'RUNNING',step:0,expiresAt:new Date(Date.now()+60000).toISOString() };
  let state: BrowserRun | null = { ...initial };
  const controller = new AbortController();
  const driver: BrowserDriver = {
    observe:vi.fn(async()=>({snapshotId:'snapshot',url:'https://example.com/',title:'示例',text:'已显示',controls:[]})),
    frame:vi.fn(async()=>({jpeg:Buffer.from('jpeg'),width:1280,height:800,url:'https://example.com/',title:'示例'})),
    execute:vi.fn(async(_action,current,signal)=>{signal.throwIfAborted();if(!await current())throw Error('stale');}),
    manual:vi.fn(async(_action,current,signal)=>{signal.throwIfAborted();if(!await current())throw Error('stale');}),
    state:vi.fn(async()=>({cookies:[],origins:[]})), close:vi.fn(async()=>{}),
  };
  const current=(run:BrowserRun)=>!!state&&state.leaseId===run.leaseId&&state.epoch===run.epoch;
  const store: BrowserStore = {
    currentBrowserTask:vi.fn(async()=>state?{...state}:null),
    browserActionCurrent:vi.fn(async(run,manual)=>current(run)&&(manual?['PAUSED','NEEDS_USER'].includes(state!.status):state!.status==='RUNNING')),
    loadBrowserSession:vi.fn(async()=>({cookies:[{name:'isolated-cookie'}],origins:[]})),
    saveBrowserSession:vi.fn(async(run)=>current(run)),
    publishBrowserFrame:vi.fn(async(run)=>current(run)),
    takeBrowserManualAction:vi.fn(async()=>null),
    finishBrowserTask:vi.fn(async(run,status)=>{if(!current(run))return false;if(status==='NEEDS_USER')state={...state!,status,epoch:state!.epoch+1};else state=null;return true;}),
    recordBrowserStep:vi.fn(async(run)=>{if(!current(run))return false;state!.step++;return true;}),
    planBrowserStep:vi.fn<BrowserStore['planBrowserStep']>(async()=>({kind:'done',description:'已核验目标页面'})),
  };
  const open=vi.fn(async()=>driver);
  return {initial,controller,driver,store,open,getState:()=>state,setState:(value:BrowserRun|null)=>{state=value;},run:()=>runIndependentBrowser(initial,store,controller.signal,open)};
}
describe('independent browser lease execution',()=>{
  it('restores only the owned profile and saves before ending and closing its context',async()=>{
    const f=setup();let screenshots=0;
    f.driver.frame=vi.fn(async()=>({jpeg:Buffer.from('jpeg'),width:1280,height:800,url:'https://example.com/',title:++screenshots===1?'执行前':'最终结果'}));
    await f.run();
    expect(f.open).toHaveBeenCalledWith({cookies:[{name:'isolated-cookie'}],origins:[]},expect.any(AbortSignal));
    expect(f.store.saveBrowserSession).toHaveBeenCalled();
    expect(f.store.finishBrowserTask).toHaveBeenCalledWith(expect.objectContaining({epoch:0}),'DONE','已核验目标页面',expect.objectContaining({frameId:expect.any(String),jpeg:Buffer.from('jpeg'),title:'最终结果'}));
    expect(f.driver.frame).toHaveBeenCalledTimes(2);
    expect(f.driver.close).toHaveBeenCalledTimes(1);
  });
  it('does not complete when the final screenshot fails and does not reuse a live frame',async()=>{
    const f=setup();let screenshots=0;
    f.driver.frame=vi.fn(async()=>{if(++screenshots>1)throw Error('capture failed');return {jpeg:Buffer.from('old-frame'),width:1280,height:800,url:'https://example.com/',title:'旧画面'};});
    f.store.takeBrowserManualAction=vi.fn(async()=>{f.setState(null);return null;});
    await f.run();
    expect(vi.mocked(f.store.finishBrowserTask).mock.calls.some(call=>call[1]==='DONE')).toBe(false);
    expect(f.store.finishBrowserTask).toHaveBeenCalledWith(expect.any(Object),'NEEDS_USER',expect.any(String));
    expect(f.store.planBrowserStep).toHaveBeenCalledTimes(1);
    expect(f.driver.close).toHaveBeenCalledTimes(1);
  });
  it('discards a pending model action on stop and closes the context without dispatch',async()=>{
    const f=setup();let started!:()=>void;const pending=new Promise<void>(resolve=>{started=resolve;});
    f.store.planBrowserStep=vi.fn<BrowserStore['planBrowserStep']>(async(_run,_obs,signal)=>{started();return new Promise<BrowserAction>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('canceled')),{once:true}));});
    const run=f.run();await pending;f.setState(null);await run;
    expect(f.driver.execute).not.toHaveBeenCalled();expect(f.driver.close).toHaveBeenCalledTimes(1);
    expect(f.store.finishBrowserTask).not.toHaveBeenCalled();
  });
  it('pause aborts old planning; resume observes again instead of replaying the old action',async()=>{
    const f=setup();let started!:()=>void;const pending=new Promise<void>(resolve=>{started=resolve;});let planned=0;
    f.store.planBrowserStep=vi.fn<BrowserStore['planBrowserStep']>(async(_run,_obs,signal)=>{if(planned++===0){started();return new Promise<BrowserAction>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('canceled')),{once:true}));}return {kind:'done',description:'重新观察后完成'};});
    f.store.takeBrowserManualAction=vi.fn(async()=>{f.setState({...f.getState()!,status:'RUNNING',epoch:2});return null;});
    const run=f.run();await pending;f.setState({...f.getState()!,status:'PAUSED',epoch:1});await run;
    expect(f.driver.execute).not.toHaveBeenCalled();expect(f.driver.observe).toHaveBeenCalledTimes(2);
    expect(f.store.finishBrowserTask).toHaveBeenCalledTimes(1);
    expect(f.store.finishBrowserTask).toHaveBeenCalledWith(expect.objectContaining({epoch:2}),'DONE','重新观察后完成',expect.any(Object));
  });
  it('does not submit an input after its manual epoch changes, and cannot overwrite resume',async()=>{
    const f=setup();f.setState({...f.initial,status:'PAUSED',epoch:1});
    f.store.takeBrowserManualAction=vi.fn<BrowserStore['takeBrowserManualAction']>(async()=>{f.setState({...f.getState()!,status:'RUNNING',epoch:2});return {id:'manual',action:{kind:'type',text:'private-test-password'}};});
    const inputs:string[]=[];
    f.driver.manual=vi.fn(async(action,current)=>{if(!await current())throw Error('stale');if(action.kind==='type')inputs.push(action.text);});
    await f.run();expect(inputs).toEqual([]);
    expect(f.store.finishBrowserTask).toHaveBeenLastCalledWith(expect.objectContaining({epoch:2}),'DONE','已核验目标页面',expect.any(Object));
    expect(JSON.stringify(vi.mocked(f.store.finishBrowserTask).mock.calls)).not.toContain('private-test-password');
  });
  it('shuts down a paused browser as FAILED instead of advertising a resumable missing context',async()=>{
    const f=setup();f.setState({...f.initial,status:'NEEDS_USER',epoch:1});
    f.store.takeBrowserManualAction=vi.fn(async()=>{f.controller.abort();return null;});
    await f.run();expect(f.store.finishBrowserTask).toHaveBeenCalledWith(expect.objectContaining({epoch:1}),'FAILED',expect.any(String));expect(f.driver.close).toHaveBeenCalledTimes(1);
  });
  it('stops on revoked permission without calling another model or entering inputs',async()=>{
    const f=setup();f.store.browserActionCurrent=vi.fn(async()=>false);
    f.store.planBrowserStep=vi.fn<BrowserStore['planBrowserStep']>(async()=>({kind:'click',ref:'old',description:'点击入口'}));
    await f.run();expect(f.store.planBrowserStep).toHaveBeenCalledTimes(1);expect(f.driver.execute).not.toHaveBeenCalled();expect(f.getState()).toBeNull();
  });
  it('does not expose arbitrary browser errors or URLs through status text',()=>{
    expect(safeBrowserFailure(Error('https://private.example/?password=secret'))).not.toContain('secret');
    expect(safeBrowserFailure({code:'BROWSER_PROVIDER_AUTH',message:'Bearer secret'})).toContain('凭据');
    expect(safeBrowserFailure({code:'BROWSER_PROVIDER_AUTH',message:'Bearer secret'})).not.toContain('secret');
    expect(safeBrowserFailure({getResponse:()=>({error:{code:'BROWSER_PROVIDER_BUDGET',message:'Bearer secret'}})})).toContain('额度');
  });
  it('carries the dispatched step to the next planner call without values, model descriptions or URL tokens',async()=>{
    const f=setup();let calls=0;
    f.driver.observe=vi.fn(async()=>({snapshotId:'snapshot',url:'https://example.com/result?token=callback-secret#code',title:'结果页面',text:'当前结果',controls:[]}));
    f.store.planBrowserStep=vi.fn<BrowserStore['planBrowserStep']>(async()=>calls++===0?{kind:'fill',ref:'field',value:'private-entered-value',description:'模型描述含private-entered-value'}:{kind:'done',description:'当前页面已核验'});
    await f.run();
    const observations=vi.mocked(f.store.planBrowserStep).mock.calls.map(call=>call[1]);
    expect(observations[0].recentSteps).toEqual([]);
    expect(observations[1].recentSteps).toEqual([{kind:'fill',description:'已派发非敏感字段填写',url:'https://example.com/result',title:'结果页面'}]);
    expect(JSON.stringify(observations[1].recentSteps)).not.toMatch(/private-entered-value|callback-secret|模型描述/);
  });
});
