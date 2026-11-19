import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext, type ElementHandle, type Frame, type LaunchOptions, type Page } from '@playwright/test';
import type { BrowserAction, BrowserManualAction, BrowserNavigationAction, BrowserObservation, BrowserViewport } from '../../../packages/contracts/src/assistant-browser.js';
import { createPublicBrowserProxy, publicBrowserUrl } from './assistant-browser-proxy.js';

export class BrowserHandoff extends Error {
  constructor(public readonly note: string) { super('BROWSER_HANDOFF'); }
}
export class BrowserUnavailable extends Error { constructor() { super('BROWSER_UNAVAILABLE'); } }
export type BrowserDriver = {
  observe(): Promise<BrowserObservation>;
  frame(): Promise<{ jpeg: Buffer; width: number; height: number; url: string; title: string; canGoBack?: boolean; canGoForward?: boolean; revision?: string }>;
  execute(action: BrowserAction, current: () => Promise<boolean>, signal: AbortSignal): Promise<void>;
  manual(action: BrowserManualAction, current: () => Promise<boolean>, signal: AbortSignal, expectedRevision?: string): Promise<void>;
  navigate(action: BrowserNavigationAction, current: () => Promise<boolean>, signal: AbortSignal): Promise<void>;
  state(): Promise<unknown>;
  close(): Promise<void>;
};
const viewport = { width: 1280, height: 800 };
const keys = { ENTER: 'Enter', TAB: 'Tab', SHIFT_TAB: 'Shift+Tab', BACKSPACE: 'Backspace', ESC: 'Escape', CTRL_A: 'ControlOrMeta+A', ARROW_LEFT: 'ArrowLeft', ARROW_RIGHT: 'ArrowRight', ARROW_UP: 'ArrowUp', ARROW_DOWN: 'ArrowDown', DELETE: 'Delete', HOME: 'Home', END: 'End', PAGE_UP: 'PageUp', PAGE_DOWN: 'PageDown' } as const;
const controlSelector = 'a[href],button,input,textarea,select,[role="button"],[role="link"],[role="tab"],[role="option"],[role="checkbox"],[role="combobox"],[contenteditable="true"]';
const sensitiveSelector = 'input[type="password"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"],input[name*="password" i],input[name*="otp" i],input[name*="token" i],input[name*="secret" i],input[type="file"]';

export function isolatedBrowserEnvironment(directory: string, source: NodeJS.ProcessEnv = process.env) {
  const result: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'LANG', 'LC_ALL', 'TZ']) {
    if (source[key]) result[key] = source[key]!;
  }
  return { ...result, HOME: directory, USERPROFILE: directory, LOCALAPPDATA: directory, APPDATA: directory, TEMP: directory, TMP: directory, TMPDIR: directory };
}
export function browserObservationUrl(raw: string) {
  if (raw === 'about:blank') return '';
  try { const url = publicBrowserUrl(raw); url.search = ''; url.hash = ''; return url.href; } catch { return ''; }
}
export function isolatedBrowserLaunch(proxy: { server: string; username: string; password: string }, directory: string): LaunchOptions {
  return {
    headless: true, chromiumSandbox: true, timeout: 30000,
    env: isolatedBrowserEnvironment(directory),
    proxy: { server: proxy.server, username: proxy.username, password: proxy.password, bypass: '<-loopback>' },
    args: ['--proxy-bypass-list=<-loopback>', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-features=WebRtcHideLocalIpsWithMdns'],
  };
}

type Control = BrowserObservation['controls'][number] & { href: string; submit: boolean; sensitive: boolean };
type Binding = { handle: ElementHandle<HTMLElement>; frame: Frame; url: string; pageUrl: string; name: string; role: string };
export function requiresBrowserHandoff(control: Pick<Control, 'name' | 'type' | 'href' | 'submit' | 'sensitive'>) {
  return control.sensitive || /^(?:password|file|hidden)$/i.test(control.type || '') ||
    /(?:支付|付款|转账|下单|购买|删除|清空|注销|退出登录|发送|发布|上传|下载|授权|验证码|密码|登录|登陆|绑定|充值|退款|提交订单|确认订单|checkout|pay\b|purchase|buy\b|delete|remove\b|send\b|publish|upload|download|authorize|sign\s*(?:in|out)|log\s*(?:in|out)|password|verification\s*code)/i.test(control.name) ||
    /^(?:javascript|file|mailto|tel|data):/i.test(control.href) ||
    (control.submit && !/(?:搜索|查询|筛选|查找|search|filter|find)/i.test(control.name));
}

/** DOM code is fixed application code; no model-generated script or selector is executed. */
async function collect(frame: Frame, prefix: string) {
  return frame.evaluate(({ prefix, controlSelector, sensitiveSelector }) => {
    const visible = (element: Element) => {
      const box = element.getBoundingClientRect(), style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0 && !element.closest('[hidden],[aria-hidden="true"],[inert]') && box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth;
    };
    const normalize = (text: string | null) => (text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const dialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog[open]')].filter(visible);
    const depth = (element: Element) => { let z = 0; for (let e: Element | null = element; e; e = e.parentElement) { const n = Number.parseInt(getComputedStyle(e).zIndex); if (Number.isFinite(n)) z = Math.max(z, n); } return z; };
    dialogs.sort((a, b) => depth(a) - depth(b));
    const root: Element = dialogs.at(-1) || document.body;
    if (!root) return { text: '', controls: [], sensitive: false };
    const controls: Control[] = [];
    for (const element of [...root.querySelectorAll(controlSelector)].slice(0, 1500)) {
      if (!visible(element) || controls.length >= 100) continue;
      const el = element as HTMLElement;
      const input = element as HTMLInputElement;
      const readable = element.matches('input,textarea,select,[contenteditable]') ? '' : el.innerText;
      const name = normalize(element.getAttribute('aria-label') || (element.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ') || (input.labels ? [...input.labels].map((label) => label.textContent).join(' ') : '') || readable || element.getAttribute('title') || element.getAttribute('placeholder'));
      const role = element.getAttribute('role') || element.tagName.toLowerCase();
      const ref = prefix + '_' + controls.length;
      element.setAttribute('data-xuti-browser-ref', ref);
      controls.push({ ref, role, name: name || role, disabled: input.disabled || element.getAttribute('aria-disabled') === 'true', type: input.type || undefined, href: element.getAttribute('href') || '', submit: !!input.form && (input.type === 'submit' || (element.tagName === 'BUTTON' && !element.getAttribute('type'))), sensitive: element.matches(sensitiveSelector) || /(?:验证码|密码|口令|银行卡|安全码|身份证|password|otp|one.time|credit.card|secret|token)/i.test([name, input.name, input.autocomplete].join(' ')) });
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let text = '', count = 0, node: Node | null;
    while ((node = walker.nextNode()) && count++ < 4000 && text.length < 12000) {
      const parent = node.parentElement;
      if (!parent || !visible(parent) || parent.closest('script,style,noscript,textarea,input,select,[contenteditable],[data-private],[data-sensitive]')) continue;
      const part = normalize(node.textContent); if (part) text += part + '\n';
    }
    return { text: text.slice(0, 12000), controls, sensitive: controls.some((control) => control.sensitive) };
  }, { prefix, controlSelector, sensitiveSelector });
}

export class IndependentBrowserPage implements BrowserDriver {
  private page: Page;
  private bindings = new Map<string, Binding>();
  private blocked = false;
  private closed = false;
  private manualView?: { page: Page; url: string; at: number; key: string };
  private pageRevision = randomUUID();
  private readonly pageIds = new WeakMap<Page, string>();
  private frameIdentity?: { hash: string; revision: string; at: number };
  constructor(private readonly context: BrowserContext, page: Page, private readonly cleanup: () => Promise<void>) {
    this.page = page;
    const configure = (candidate: Page) => {
      this.pageIds.set(candidate, randomUUID());
      candidate.on('download', (download) => { this.blocked = true; void download.cancel().catch(() => {}); });
      candidate.on('dialog', (dialog) => { this.blocked = true; void dialog.dismiss().catch(() => {}); });
      candidate.on('filechooser', () => { this.blocked = true; });
      candidate.on('framenavigated', (frame) => {
        this.invalidateView();
        if (frame !== candidate.mainFrame() || frame.url() === 'about:blank') return;
        try { publicBrowserUrl(frame.url()); } catch { this.blocked = true; void candidate.close().catch(() => {}); }
      });
    };
    configure(page);
    context.on('page', (candidate) => {
      configure(candidate);
      if (context.pages().length > 4) { this.blocked = true; void candidate.close().catch(() => {}); return; }
      this.page = candidate;
      this.invalidateView();
    });
  }
  private invalidateView() {
    this.pageRevision = randomUUID();
    this.frameIdentity = undefined;
    this.manualView = undefined;
  }
  private async viewKey(page: Page) {
    const revision = this.pageRevision;
    const scroll = await page.evaluate(() => [window.scrollX, window.scrollY]);
    if (revision !== this.pageRevision || page !== this.currentPage()) throw new BrowserHandoff('页面正在切换，请等待新画面后再操作');
    return JSON.stringify([this.pageIds.get(page), revision, page.url(), page.viewportSize() || viewport, scroll]);
  }
  private currentPage() {
    if (this.closed || !this.context.browser()?.isConnected()) throw new BrowserUnavailable();
    if (this.page.isClosed()) this.page = this.context.pages().filter((page) => !page.isClosed()).at(-1)!;
    if (!this.page) throw new BrowserUnavailable();
    return this.page;
  }
  private async releaseBindings() {
    const old = this.bindings; this.bindings = new Map();
    await Promise.allSettled([...old.values()].map(({ handle }) => handle.dispose()));
  }
  private masks(allInputs: boolean) {
    return this.currentPage().frames().map((frame) => frame.locator(allInputs ? 'input,textarea,select,[contenteditable],[data-private],[data-sensitive]' : sensitiveSelector + ',[data-private],[data-sensitive]'));
  }
  async frame() {
    const page = this.currentPage();
    const url = page.url();
    const key = await this.viewKey(page);
    const session = await this.context.newCDPSession(page);
    const history = await session.send('Page.getNavigationHistory').finally(() => session.detach());
    const jpeg = await page.screenshot({ type: 'jpeg', quality: 65, timeout: 5000, mask: this.masks(false), maskColor: '#333333' });
    if (page !== this.currentPage() || page.url() !== url || await this.viewKey(page) !== key) throw new BrowserHandoff('页面正在切换，请等待新画面后再操作');
    const at = Date.now(), hash = createHash('sha256').update(key).update(jpeg).digest('hex');
    if (!this.frameIdentity || this.frameIdentity.hash !== hash || at - this.frameIdentity.at >= 15000)
      this.frameIdentity = { hash, revision: randomUUID(), at };
    this.manualView = { page, url, at, key };
    return { jpeg, revision: this.frameIdentity.revision, ...(page.viewportSize() || viewport), url: page.url(), title: (await page.title()).slice(0, 200), canGoBack: history.currentIndex > 0, canGoForward: history.currentIndex < history.entries.length - 1 };
  }
  async observe(): Promise<BrowserObservation> {
    const page = this.currentPage();
    await this.releaseBindings();
    if (this.blocked) { this.blocked = false; throw new BrowserHandoff('网页出现文件、弹窗确认或不支持的页面操作，请接管核对后继续'); }
    const snapshotId = randomUUID(), controls: BrowserObservation['controls'] = [];
    let text = '', sensitive = false;
    for (const [index, frame] of page.frames().slice(0, 10).entries()) {
      if (frame.isDetached()) continue;
      const data = await collect(frame, snapshotId + '_' + index);
      sensitive ||= data.sensitive;
      text += data.text + '\n';
      for (const item of data.controls) {
        if (controls.length >= 100) break;
        const handle = await frame.locator(`[data-xuti-browser-ref="${item.ref}"]`).elementHandle();
        if (!handle) continue;
        this.bindings.set(item.ref, { handle: handle as ElementHandle<HTMLElement>, frame, url: frame.url(), pageUrl: page.url(), name: item.name, role: item.role });
        controls.push({ ref: item.ref, role: item.role, name: item.name, disabled: item.disabled || requiresBrowserHandoff(item), type: item.type });
      }
    }
    const jpeg = sensitive ? undefined : await page.screenshot({ type: 'jpeg', quality: 55, timeout: 5000, mask: this.masks(true), maskColor: '#333333' });
    return { snapshotId, url: browserObservationUrl(page.url()), title: (await page.title()).slice(0, 200), text: text.slice(0, 12000), controls, sensitive, image: jpeg?.toString('base64') };
  }
  async execute(action: BrowserAction, current: () => Promise<boolean>, signal: AbortSignal) {
    const guard = async () => { signal.throwIfAborted(); if (!await current()) throw Error('BROWSER_ACTION_STALE'); signal.throwIfAborted(); this.invalidateView(); };
    const page = this.currentPage();
    if (action.kind === 'goto') { const url = publicBrowserUrl(action.url); await guard(); await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 20000 }); }
    else if ('ref' in action) {
      const binding = this.bindings.get(action.ref);
      if (!binding || binding.pageUrl !== page.url() || binding.url !== binding.frame.url() || binding.frame.isDetached()) throw new BrowserHandoff('页面已变化，请核对当前画面后继续');
      const metadata = await binding.handle.evaluate((element, sensitiveSelector) => {
        const input = element as HTMLInputElement;
        const readable = element.matches('input,textarea,select,[contenteditable]') ? '' : element.innerText;
        const name = (element.getAttribute('aria-label') || (element.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ') || (input.labels ? [...input.labels].map(label => label.textContent).join(' ') : '') || readable || element.getAttribute('title') || element.getAttribute('placeholder') || element.getAttribute('role') || element.tagName.toLowerCase()).replace(/\s+/g, ' ').trim().slice(0, 160);
        const visible = (target: Element) => { const box = target.getBoundingClientRect(), style = getComputedStyle(target); return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0 && !target.closest('[hidden],[aria-hidden="true"],[inert]'); };
        const depth = (target: Element) => { let z = 0; for (let e: Element | null = target; e; e = e.parentElement) { const n = Number.parseInt(getComputedStyle(e).zIndex); if (Number.isFinite(n)) z = Math.max(z, n); } return z; };
        const dialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog[open]')].filter(visible).sort((a, b) => depth(a) - depth(b));
        const inScope = !dialogs.length || dialogs.at(-1)!.contains(element);
        return { name, type: input.type, href: element.getAttribute('href') || '', submit: !!input.form && (input.type === 'submit' || (element.tagName === 'BUTTON' && !element.getAttribute('type'))), sensitive: element.matches(sensitiveSelector) || /(?:验证码|密码|口令|银行卡|安全码|身份证|password|otp|one.time|credit.card|secret|token)/i.test([name, input.name, input.autocomplete].join(' ')), connected: element.isConnected && visible(element) && inScope };
      }, sensitiveSelector);
      if (!metadata.connected || requiresBrowserHandoff({ ...metadata, name: metadata.name || binding.name })) throw new BrowserHandoff('这一步涉及登录、敏感资料或提交操作，请接管完成后继续');
      if (metadata.name !== binding.name) throw new BrowserHandoff('页面控件已变化，请核对当前画面后继续');
      if (action.kind === 'click') {
        await binding.handle.click({ trial: true, timeout: 1500 }); await guard();
        await binding.handle.click({ timeout: 500, noWaitAfter: true });
      } else if (action.kind === 'fill') {
        if (metadata.type && !['text', 'search', 'email', 'tel', 'url', 'number'].includes(metadata.type)) throw new BrowserHandoff('该字段需要人工核对，请接管填写');
        await guard(); await binding.handle.fill(action.value, { timeout: 500 });
      } else { await guard(); await binding.handle.selectOption(action.value, { timeout: 500 }); }
    } else if (action.kind === 'key') {
      if (action.key === 'ENTER') {
        const search = await page.evaluate(() => { const element = document.activeElement as HTMLInputElement | null; return element?.type === 'search' || element?.closest('[role="search"]') !== null && !!element?.closest('[role="search"]'); });
        if (!search) throw new BrowserHandoff('按回车可能提交当前表单，请接管确认');
      }
      await guard(); await page.keyboard.press(keys[action.key]);
    } else if (action.kind === 'scroll') { await guard(); await page.mouse.wheel(0, (action.direction === 'down' ? 1 : -1) * action.amount * 400); }
    else if (action.kind === 'wait') { await guard(); await browserPause(action.seconds * 1000, signal); }
    await this.releaseBindings();
  }
  async manual(action: BrowserManualAction, current: () => Promise<boolean>, signal: AbortSignal, expectedRevision?: string) {
    const page = this.currentPage();
    const view = this.manualView;
    if (!view || view.page !== page || view.url !== page.url() || Date.now() - view.at > 15000 || (expectedRevision && expectedRevision !== this.frameIdentity?.revision) || await this.viewKey(page) !== view.key) throw new BrowserHandoff('接管画面已变化，请等待最新画面再操作');
    signal.throwIfAborted(); if (!await current()) throw Error('BROWSER_ACTION_STALE'); signal.throwIfAborted();
    if (this.manualView !== view || (expectedRevision && expectedRevision !== this.frameIdentity?.revision) || await this.viewKey(page) !== view.key) throw new BrowserHandoff('接管画面已变化，请等待最新画面再操作');
    this.invalidateView();
    const size = page.viewportSize() || viewport;
    if (action.kind === 'click') await page.mouse.click(action.x / 1000 * size.width, action.y / 1000 * size.height);
    else if (action.kind === 'type') await page.keyboard.insertText(action.text);
    else if (action.kind === 'key') await page.keyboard.press(keys[action.key]);
    else await page.mouse.wheel(0, (action.direction === 'down' ? 1 : -1) * action.amount * 400);
    await this.releaseBindings();
  }
  async navigate(action: BrowserNavigationAction, current: () => Promise<boolean>, signal: AbortSignal) {
    const page = this.currentPage();
    const url = action.kind === 'goto' ? publicBrowserUrl(action.url).href : undefined;
    signal.throwIfAborted(); if (!await current()) throw Error('BROWSER_ACTION_STALE'); signal.throwIfAborted();
    this.invalidateView();
    await this.releaseBindings();
    const options = { waitUntil: 'domcontentloaded' as const, timeout: 20000 };
    if (action.kind === 'goto') await page.goto(url!, options);
    else if (action.kind === 'back') await page.goBack(options);
    else if (action.kind === 'forward') await page.goForward(options);
    else if (action.kind === 'reload') await page.reload(options);
    else await page.setViewportSize(action.viewport);
    signal.throwIfAborted();
  }
  state() { this.currentPage(); return this.context.storageState({ indexedDB: true }); }
  async close() { if (this.closed) return; this.closed = true; await this.releaseBindings(); await this.cleanup(); }
}

export async function browserPause(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(Error('BROWSER_CANCELED')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function openIndependentBrowser(saved: unknown, signal: AbortSignal, initialViewport?: BrowserViewport): Promise<BrowserDriver> {
  const directory = await mkdtemp(join(tmpdir(), 'xuti-browser-'));
  const proxy = await createPublicBrowserProxy({ signal }).catch(async (error) => { await rm(directory, { recursive: true, force: true }); throw error; });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch(isolatedBrowserLaunch(proxy, directory));
    signal.throwIfAborted();
    // Only server-created, owner-bound encrypted storage is restored; no file paths are accepted.
    const storageState = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved as Exclude<Parameters<typeof browser.newContext>[0], undefined>['storageState'] : undefined;
    const context = await browser.newContext({ viewport: initialViewport ?? viewport, locale: 'zh-CN', acceptDownloads: false, serviceWorkers: 'block', permissions: [], storageState });
    context.setDefaultTimeout(3000);
    await context.route('**/*', async (route) => {
      try { publicBrowserUrl(route.request().url()); await route.continue(); }
      catch { await route.abort('blockedbyclient').catch(() => {}); }
    });
    const page = await context.newPage();
    const abort = () => { void browser?.close().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); throw Error('BROWSER_CANCELED'); }
    return new IndependentBrowserPage(context, page, async () => {
      signal.removeEventListener('abort', abort);
      await browser?.close().catch(() => {}); await proxy.close();
      await rm(directory, { recursive: true, force: true });
    });
  } catch (error) {
    await browser?.close().catch(() => {}); await proxy.close(); await rm(directory, { recursive: true, force: true }); throw error;
  }
}
