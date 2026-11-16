import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { chromium, type Browser, type BrowserContext } from '@playwright/test';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { IndependentBrowserPage, browserObservationUrl, isolatedBrowserEnvironment, isolatedBrowserLaunch, requiresBrowserHandoff } from '../../apps/worker/src/assistant-browser-page.js';
import { createPublicBrowserProxy } from '../../apps/worker/src/assistant-browser-proxy.js';

let browser: Browser, server: Server, proxy: Awaited<ReturnType<typeof createPublicBrowserProxy>>, directory: string, port: number;
let html = '', privateHits = 0;
const contexts: BrowserContext[] = [];
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xuti-browser-test-'));
  server = createServer((req, res) => { if (req.url === '/private-probe') privateHits++; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('test address'); port = address.port;
  proxy = await createPublicBrowserProxy({
    resolve: async (host) => { if (host !== 'browser-fixture.example') throw Error('test host denied'); return [{ address: '8.8.8.8', family: 4 }]; },
    dial: () => connect({ host: '127.0.0.1', port }),
  });
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const options = isolatedBrowserLaunch(proxy, directory);
  // Branded Windows Chrome checks the OS default directory's identity before it
  // accepts CDP. Its actual user-data-dir is still Playwright's new temporary dir.
  const windowsPaths = process.platform === 'win32' ? Object.fromEntries(['LOCALAPPDATA', 'APPDATA', 'USERPROFILE'].filter(key => process.env[key]).map(key => [key, process.env[key]!])) : {};
  browser = await chromium.launch({ ...options, env: { ...options.env, ...windowsPaths }, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
}, 30000);
afterEach(async () => { for (const context of contexts.splice(0)) await context.close(); });
afterAll(async () => {
  await browser?.close(); await proxy?.close();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function fixture(body: string) {
  html = '<!doctype html><meta charset="utf-8"><title>隔离浏览器测试</title>' + body;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block', acceptDownloads: false }); contexts.push(context);
  const page = await context.newPage();
  const driver = new IndependentBrowserPage(context, page, async () => {});
  await page.goto('http://browser-fixture.example/', { waitUntil: 'domcontentloaded' });
  return { context, page, driver };
}
const signal = () => new AbortController().signal;
describe('isolated Chromium page execution', () => {
  it('supports real history, reload, viewport sizing and direct Chinese input in the same context', async () => {
    const { driver, page, context } = await fixture('<input style="position:absolute;left:300px;top:400px;width:150px;height:40px"><h1>第一页</h1>');
    await context.addCookies([{name:'session',value:'kept',url:'http://browser-fixture.example/'}]);
    await driver.navigate({kind:'resize',viewport:{width:700,height:900}},async()=>true,signal());
    await driver.navigate({kind:'goto',url:'http://browser-fixture.example/second'},async()=>true,signal());
    expect(await driver.frame()).toMatchObject({width:700,height:900,canGoBack:true,canGoForward:false});
    await driver.navigate({kind:'back'},async()=>true,signal());
    expect(page.url()).toBe('http://browser-fixture.example/');
    expect(await driver.frame()).toMatchObject({canGoForward:true});
    await driver.navigate({kind:'forward'},async()=>true,signal());
    expect(page.url()).toBe('http://browser-fixture.example/second');
    await page.locator('h1').evaluate(el=>{el.textContent='本地改动';});
    await driver.navigate({kind:'reload'},async()=>true,signal());
    expect(await page.locator('h1').innerText()).toBe('第一页');
    expect((await context.cookies()).find(c=>c.name==='session')?.value).toBe('kept');
    await driver.frame();
    await driver.manual({kind:'click',x:375/700*1000,y:420/900*1000},async()=>true,signal());
    await driver.frame();
    await driver.manual({kind:'type',text:'中文粘贴与输入'},async()=>true,signal());
    expect(await page.locator('input').inputValue()).toBe('中文粘贴与输入');
    await driver.frame();
    await driver.manual({kind:'key',key:'HOME'},async()=>true,signal());
    await driver.frame();
    await driver.manual({kind:'key',key:'DELETE'},async()=>true,signal());
    expect(await page.locator('input').inputValue()).toBe('文粘贴与输入');
  },30000);
  it('does not inherit application secrets and requires the Chromium sandbox and proxy', () => {
    const env = isolatedBrowserEnvironment('C:/isolated', { PATH: 'safe-path', DATABASE_URL: 'postgres://secret', COMPASS_MAIL_KEY: 'secret', OPENAI_API_KEY: 'secret', HOME: 'real-profile' });
    expect(env).toEqual(expect.objectContaining({ PATH: 'safe-path', HOME: 'C:/isolated', USERPROFILE: 'C:/isolated' }));
    expect(JSON.stringify(env)).not.toContain('secret'); expect(JSON.stringify(env)).not.toContain('real-profile');
    const options = isolatedBrowserLaunch(proxy, directory);
    expect(options.chromiumSandbox).toBe(true); expect(options.args).not.toContain('--no-sandbox');
    expect(options.args).toContain('--proxy-bypass-list=<-loopback>'); expect(options.args).toContain('--disable-quic');
    expect(browserObservationUrl('https://example.com/callback?code=secret&token=private#auth')).toBe('https://example.com/callback');
  });
  it('forces actual loopback requests through the rejecting proxy without direct fallback', async () => {
    const { page } = await fixture('<h1>代理测试</h1>'); privateHits = 0;
    const result = await page.evaluate(async (url) => { try { const response = await fetch(url); return response.status; } catch { return 'blocked'; } }, `http://127.0.0.1:${port}/private-probe`);
    expect(result).toBe('blocked'); expect(privateHits).toBe(0);
  });
  it('excludes hidden content and entered values, pauses password pages, and never sends their image to AI', async () => {
    const { driver } = await fixture('<h1>登录验证</h1><p hidden>hidden-private</p><input type="password" value="password-private"><textarea>typed-private</textarea><div contenteditable="true">editable-private</div><button>登录</button>');
    const observation = await driver.observe();
    expect(observation.sensitive).toBe(true); expect(observation.image).toBeUndefined();
    expect(observation.text).not.toMatch(/hidden-private|password-private|typed-private|editable-private/);
    expect(JSON.stringify(observation.controls)).not.toMatch(/password-private|typed-private|editable-private/);
    expect(observation.controls.find(c => c.name === '登录')?.disabled).toBe(true);
    expect((await driver.frame()).jpeg.length).toBeGreaterThan(100);
  });
  it('uses current element refs, rechecks sensitive actions, and permits ordinary search input', async () => {
    const { driver, page } = await fixture('<input type="search" aria-label="搜索关键词"><button type="button" onclick="document.querySelector(\'h1\').textContent=\'打开成功\'">查看列表</button><h1>入口</h1>');
    const first = await driver.observe(), old = first.controls.find(c => c.name === '查看列表')!;
    const second = await driver.observe();
    await expect(driver.execute({ kind: 'click', ref: old.ref, description: '打开列表' }, async () => true, signal())).rejects.toThrow();
    const input = second.controls.find(c => c.name === '搜索关键词')!;
    await driver.execute({ kind: 'fill', ref: input.ref, value: '普通查询', description: '填写搜索' }, async () => true, signal());
    expect(await page.locator('input').inputValue()).toBe('普通查询');
    const third = await driver.observe(), button = third.controls.find(c => c.name === '查看列表')!;
    await page.locator('button').evaluate(el => { el.textContent = '发送消息'; });
    await expect(driver.execute({ kind: 'click', ref: button.ref, description: '打开列表' }, async () => true, signal())).rejects.toThrow('BROWSER_HANDOFF');
    expect(await page.locator('h1').innerText()).toBe('入口');
  });
  it('checks authorization immediately before real input and allows paused manual typing only with a current frame lease', async () => {
    const { driver, page } = await fixture('<input type="text" aria-label="普通字段"><button type="button" onclick="document.querySelector(\'h1\').textContent=\'changed\'">查看列表</button><h1>unchanged</h1>');
    const observation = await driver.observe(), target = observation.controls.find(c => c.name === '查看列表')!;
    const current = vi.fn(async () => false);
    await expect(driver.execute({ kind: 'click', ref: target.ref, description: '打开列表' }, current, signal())).rejects.toThrow();
    expect(current).toHaveBeenCalledTimes(1); expect(await page.locator('h1').innerText()).toBe('unchanged');
    await page.locator('input').focus();
    await driver.frame();
    await expect(driver.manual({ kind: 'type', text: 'not-entered' }, async () => false, signal())).rejects.toThrow();
    expect(await page.locator('input').inputValue()).toBe('');
    await driver.manual({ kind: 'type', text: 'user-entered' }, async () => true, signal());
    expect(await page.locator('input').inputValue()).toBe('user-entered');
    const after = await driver.observe(); expect(after.text).not.toContain('user-entered');
  });
  it('keeps cookies in separate contexts and treats submissions as handoff', async () => {
    const a = await fixture('<p>账号A</p>');
    await a.context.addCookies([{ name: 'session', value: 'account-a', url: 'http://browser-fixture.example/' }]);
    const b = await fixture('<p>账号B</p>');
    expect(await b.context.cookies()).toEqual([]);
    expect(requiresBrowserHandoff({ name: '确认', href: '', submit: true, sensitive: false })).toBe(true);
    expect(requiresBrowserHandoff({ name: '搜索', href: '', submit: true, sensitive: false })).toBe(false);
  });
});
