import { randomUUID } from 'node:crypto';
import { browserStepLabels, type BrowserAction, type BrowserManualAction, type BrowserObservation, type BrowserRecentStep } from '../../../packages/contracts/src/assistant-browser.js';
import type { BrowserCapturedFrame, BrowserRun } from '../../api/src/modules/workspace/assistant-browser.js';
import { BrowserHandoff, BrowserUnavailable, browserObservationUrl, browserPause, openIndependentBrowser, type BrowserDriver } from './assistant-browser-page.js';

export type BrowserStore = {
  currentBrowserTask(run: BrowserRun): Promise<BrowserRun | null>;
  browserActionCurrent(run: BrowserRun, manual?: boolean): Promise<boolean>;
  loadBrowserSession(run: BrowserRun): Promise<unknown>;
  saveBrowserSession(run: BrowserRun, state: unknown): Promise<boolean>;
  publishBrowserFrame(run: BrowserRun, frame: { frameId: string; jpeg: Buffer; width: number; height: number; url: string; title: string }): Promise<boolean>;
  takeBrowserManualAction(run: BrowserRun): Promise<{ id: string; action: BrowserManualAction } | null>;
  finishBrowserTask(run: BrowserRun, status: 'DONE' | 'NEEDS_USER' | 'FAILED', note: string, finalFrame?: BrowserCapturedFrame): Promise<boolean>;
  recordBrowserStep(run: BrowserRun, description: string): Promise<boolean>;
  planBrowserStep(run: BrowserRun, observation: BrowserObservation, signal: AbortSignal): Promise<BrowserAction>;
};

function failureCode(error: unknown) {
  if (!error || typeof error !== 'object') return '';
  if ('code' in error && typeof error.code === 'string') return error.code;
  if ('getResponse' in error && typeof error.getResponse === 'function') {
    try {
      const response: unknown = error.getResponse();
      if (response && typeof response === 'object' && 'error' in response && response.error && typeof response.error === 'object' && 'code' in response.error && typeof response.error.code === 'string') return response.error.code;
    } catch { /* Only a known fixed code may leave this boundary. */ }
  }
  return '';
}
export function safeBrowserFailure(error: unknown) {
  if (error instanceof BrowserHandoff) return error.note;
  const code = failureCode(error);
  const known: Record<string, string> = {
    AI_NOT_READY: '智能服务尚未启用并验证，请完成配置后继续',
    VISION_REQUIRED: '当前模型不支持浏览器画面，请更换支持图片的模型后重新发起',
    BROWSER_AI_RESULT: '智能服务未返回有效操作，已暂停，请核对当前页面后继续',
    BROWSER_FINAL_FRAME_UNAVAILABLE: '未能保存最终画面，已暂停，请核对当前页面后继续',
    BROWSER_STALE_CONTROL: '页面控件已变化，已暂停，请核对当前页面后继续',
    BROWSER_PROVIDER_BUDGET: '智能服务额度达到限制，请调整额度后继续',
    BROWSER_PROVIDER_CREDITS: '智能服务余额不足，请处理后继续',
    BROWSER_PROVIDER_AUTH: '智能服务凭据无效，请检查配置后继续',
    BROWSER_PROVIDER_PERMISSION: '智能服务因权限或服务保护规则拒绝请求，请检查后继续',
    BROWSER_PROVIDER_PRIVACY: '智能服务的数据使用设置不兼容，请检查配置后继续',
    BROWSER_PROVIDER_REGION: '智能服务当前地区不可用，请检查配置后继续',
    BROWSER_PROVIDER_POLICY: '智能服务未接受本次操作，请核对任务后继续',
    BROWSER_PROVIDER_RATE_LIMIT: '智能服务请求频率受限，已暂停，请稍后继续',
    BROWSER_PROVIDER_UNAVAILABLE: '智能服务暂时不可用，已暂停，请稍后继续',
    BROWSER_PROVIDER_HTTP: '智能服务请求未成功，已暂停，请检查服务状态后继续',
  };
  return known[code] || '独立浏览器操作未完成，已暂停；请核对当前画面后继续，未自动重试该操作';
}

/** One lease owns one context. Pause aborts planning; stop closes its sockets and browser. */
export async function runIndependentBrowser(
  initial: BrowserRun,
  store: BrowserStore,
  signal: AbortSignal,
  open: (saved: unknown, signal: AbortSignal) => Promise<BrowserDriver> = openIndependentBrowser,
) {
  const lifetime = new AbortController();
  const combined = AbortSignal.any([signal, lifetime.signal]);
  let run = initial, driver: BrowserDriver | undefined;
  let operation: AbortController | undefined, checking = false, ended = false;
  let frameAt = 0, sessionAt = 0, navigated = !initial.initialUrl;
  const recentSteps: BrowserRecentStep[] = [];
  let pendingStep: BrowserRecentStep['kind'] | undefined;
  const refresh = async () => {
    const latest = await store.currentBrowserTask(run);
    if (!latest) { ended = true; lifetime.abort(); return null; }
    if (latest.epoch < run.epoch) return run;
    if (latest.epoch !== run.epoch || latest.status !== run.status) { operation?.abort(); frameAt = 0; }
    run = latest;
    return latest;
  };
  const timer = setInterval(() => {
    if (checking || combined.aborted) return;
    checking = true;
    void refresh().catch(() => lifetime.abort()).finally(() => { checking = false; });
  }, 1000);
  const perform = async <T>(work: (snapshot: BrowserRun, phase: AbortSignal) => Promise<T>) => {
    const controller = new AbortController(); operation = controller;
    try { return await work({ ...run }, AbortSignal.any([combined, controller.signal])); }
    finally { if (operation === controller) operation = undefined; }
  };
  const capture = async (snapshot: BrowserRun) => {
    if (!driver || Date.now() - frameAt < 2000) return;
    const frame = await driver.frame();
    if (combined.aborted) return;
    if (await store.publishBrowserFrame(snapshot, { ...frame, frameId: randomUUID() })) frameAt = Date.now();
  };
  const save = async (snapshot: BrowserRun, force = false) => {
    if (!driver || (!force && Date.now() - sessionAt < 10000)) return;
    const state = await driver.state();
    if (combined.aborted) return;
    if (await store.saveBrowserSession(snapshot, state)) sessionAt = Date.now();
  };
  try {
    const saved = await store.loadBrowserSession(run);
    combined.throwIfAborted();
    if (!await refresh()) return;
    driver = await open(saved, combined);
    while (!combined.aborted) {
      if (!await refresh()) break;
      const before = { ...run };
      try {
        await perform(async (snapshot, phase) => {
          const current = async (manual = false) => {
            const valid = await store.browserActionCurrent(snapshot, manual);
            if (!valid) await store.finishBrowserTask(snapshot, 'FAILED', '任务状态或账号权限已变化，浏览器操作已停止');
            return valid;
          };
          if (snapshot.status === 'PAUSED' || snapshot.status === 'NEEDS_USER') {
            const input = await store.takeBrowserManualAction(snapshot);
            phase.throwIfAborted();
            if (input) {
              // Consumed once by the store before dispatch; never replay after interruption.
              await driver!.manual(input.action, () => current(true), phase);
              frameAt = 0;
              await save(snapshot, true);
            }
            await capture(snapshot);
            await save(snapshot);
            await browserPause(400, phase);
            return;
          }
          if (snapshot.status !== 'RUNNING') { ended = true; lifetime.abort(); return; }
          if (!navigated) {
            await driver!.execute({ kind: 'goto', url: snapshot.initialUrl, description: '打开指定网页' }, () => current(), phase);
            navigated = true;
            pendingStep = 'goto';
            phase.throwIfAborted();
            await store.recordBrowserStep(snapshot, '已打开指定网页，正在观察');
            frameAt = 0;
            return;
          }
          await capture(snapshot);
          const observation = await driver!.observe();
          phase.throwIfAborted();
          if (pendingStep) {
            recentSteps.push({ kind: pendingStep, description: browserStepLabels[pendingStep], url: browserObservationUrl(observation.url), title: observation.title.slice(0, 200) });
            pendingStep = undefined;
            if (recentSteps.length > 8) recentSteps.splice(0, recentSteps.length - 8);
          }
          observation.recentSteps = recentSteps.map(step => ({ ...step }));
          const action = await store.planBrowserStep(snapshot, observation, phase);
          phase.throwIfAborted();
          if (!await current()) return;
          if (action.kind === 'handoff') {
            await save(snapshot, true);
            await store.finishBrowserTask(snapshot, 'NEEDS_USER', action.description);
            frameAt = 0;
            return;
          }
          if (action.kind === 'done') {
            await save(snapshot, true);
            phase.throwIfAborted();
            const finalFrame = { ...await driver!.frame(), frameId: randomUUID() };
            phase.throwIfAborted();
            if (await store.finishBrowserTask(snapshot, 'DONE', action.description, finalFrame)) { ended = true; lifetime.abort(); }
            return;
          }
          await driver!.execute(action, () => current(), phase);
          pendingStep = action.kind;
          phase.throwIfAborted();
          // A fresh observation is required after every actual mutation; no action batches.
          await store.recordBrowserStep(snapshot, action.description);
          frameAt = 0;
          await save(snapshot);
          await browserPause(300, phase);
        });
      } catch (error) {
        if (combined.aborted) break;
        const latest = await refresh();
        if (!latest) break;
        // Never replace the user's pause, resume or stop with a late failure.
        if (latest.epoch !== before.epoch || latest.status !== before.status) continue;
        if (error instanceof BrowserUnavailable) {
          await store.finishBrowserTask(before, 'FAILED', '独立浏览器页面已关闭，请核对结果后重新发起');
          ended = true; lifetime.abort(); break;
        }
        if (['FORBIDDEN', 'UNAUTHENTICATED'].includes(failureCode(error))) {
          await store.finishBrowserTask(before, 'FAILED', '账号权限已变化，浏览器操作已停止');
          ended = true; lifetime.abort(); break;
        }
        await store.finishBrowserTask(before, 'NEEDS_USER', safeBrowserFailure(error));
        frameAt = 0;
        await browserPause(400, combined);
      }
    }
  } catch {
    // A dead browser has no usable handoff surface. Do not advertise a resumable task.
    if (!ended) await store.finishBrowserTask(run, 'FAILED', '独立浏览器连接已中断；未自动重试操作，请核对结果后重新发起').catch(() => {});
  } finally {
    clearInterval(timer);
    operation?.abort();
    lifetime.abort();
    if (!ended) await store.finishBrowserTask(run, 'FAILED', '独立浏览器执行已结束；未自动重试操作，请核对结果后重新发起').catch(() => {});
    await driver?.close().catch(() => {});
  }
}
