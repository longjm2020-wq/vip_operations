import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import {
  db,
  one,
  rows,
  type Row,
} from "../../../packages/database/src/index.js";
import {
  jushuitanScope,
  jushuitanViewport,
  jushuitanLoginActionSchema,
  isJushuitanOrigin,
} from "../../../packages/contracts/src/jushuitan-inventory.js";
import {
  jstLock,
  jstSettings,
  expireJstTasks,
  enqueueJst,
  jstWorkerActor,
  publishJstExport,
} from "../../api/src/modules/inventory/jushuitan.js";
import {
  decryptSecret,
  encryptionReady,
} from "../../api/src/modules/analytics/secrets.js";
import {
  JstExportError,
  type JstTarget,
} from "../../api/src/integrations/jushuitan/export-file.js";
import {
  collectJstState,
  decryptJstState,
  encryptJstState,
  restoreJstState,
} from "./jushuitan-browser-state.js";
import {
  exportJstInventory,
  guardJstContext,
  JstBrowserError,
  verifyJstScope,
} from "./jushuitan-browser-export.js";
import {
  JstLoginInputTracker,
  jstLoginMasks,
} from "./jushuitan-login-input.js";

const activeLogin = "('QUEUED','RUNNING','WAITING','CHECKING')";
const safeError = (e: unknown) =>
  e instanceof JstBrowserError || e instanceof JstExportError
    ? e.message
    : "聚水潭页面操作未完成，请重新登录核验或稍后重试；未发布库存";
async function assertJob(job: Row, token: string, login: boolean) {
  const active = await one(
    db,
    login
      ? `SELECT id FROM jushuitan_browser_logins WHERE id=$1::uuid AND claim_token=$2::uuid AND status IN ${activeLogin} AND expires_at>now()`
      : "SELECT id FROM jushuitan_inventory_runs WHERE id=$1::uuid AND claim_token=$2::uuid AND status='RUNNING' AND created_at>now()-interval '30 minutes'",
    job.id,
    token,
  );
  const s = (await jstSettings())!;
  if (!active || s.version !== job.settings_version)
    throw new JstBrowserError("任务已关闭、超时或设置已改变");
  await jstWorkerActor(login ? job.actor_id : job.requested_by);
  if (!login) await jstWorkerActor(s.session_actor_id);
}
async function createContext(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  saved?: ReturnType<typeof decryptJstState>,
) {
  const context = await browser.newContext({
    viewport: jushuitanViewport,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    acceptDownloads: true,
    ...(saved
      ? { storageState: { cookies: saved.cookies, origins: saved.origins } }
      : {}),
  });
  context.setDefaultTimeout(15000);
  context.setDefaultNavigationTimeout(60000);
  await guardJstContext(context);
  if (saved) await restoreJstState(context, saved);
  return context;
}
async function openHome(context: BrowserContext) {
  const page = await context.newPage();
  await page.goto(jushuitanScope.home, { waitUntil: "domcontentloaded" });
  return page;
}
async function runLogin(
  job: Row,
  token: string,
  context: BrowserContext,
  page: Page,
  browser: Awaited<ReturnType<typeof chromium.launch>>,
) {
  const inputs = new JstLoginInputTracker();
  let lastAction: { id: string; error: string | null } | null = null;
  let nextFrame = 0,
    note = "请完成登录，点击核验将打开商品库存并确认序缇杭州总仓";
  while (Date.now() < new Date(job.expires_at).getTime()) {
    await assertJob(job, token, true);
    const official = context
      .pages()
      .filter((p) => !p.isClosed() && isJushuitanOrigin(p.url()));
    page = official.at(-1) ?? page;
    const action = await one(
      db,
      `DELETE FROM jushuitan_browser_actions WHERE id=(SELECT id FROM jushuitan_browser_actions WHERE login_id=$1::uuid ORDER BY id LIMIT 1) RETURNING id,encrypted_payload`,
      job.id,
    );
    if (action) {
      lastAction = { id: String(action.id), error: null };
      try {
        const envelope = JSON.parse(decryptSecret(action.encrypted_payload));
        if (
          envelope.purpose !== "jst-action-v1" ||
          envelope.loginId !== job.id ||
          envelope.actorId !== String(job.actor_id)
        )
          throw Error("Invalid action");
        const a = jushuitanLoginActionSchema.parse(envelope.action);
        if (a.type === "CHECK") {
          await db.$executeRawUnsafe(
            "UPDATE jushuitan_browser_logins SET status='CHECKING',frame_id=NULL,note='正在核验账号、仓库及会话恢复能力' WHERE id=$1::uuid AND claim_token=$2::uuid",
            job.id,
            token,
          );
          const checking = async (text: string) => {
            await db.$executeRawUnsafe(
              "UPDATE jushuitan_browser_logins SET note=$3 WHERE id=$1::uuid AND claim_token=$2::uuid AND status='CHECKING'",
              job.id,
              token,
              text,
            );
          };
          await verifyJstScope(page, checking);
          const state = await collectJstState(context);
          // A saved session must work in a fresh browser context, not only in the current login tab.
          const probe = await createContext(browser, state);
          let verifiedState;
          try {
            await checking("正在新窗口恢复登录并核验杭州总仓");
            const restored = await openHome(probe);
            await verifyJstScope(restored, (text) =>
              checking(`新窗口恢复：${text}`),
            );
            verifiedState = await collectJstState(probe);
          } catch (error) {
            throw new JstBrowserError(
              error instanceof JstBrowserError
                ? `新窗口恢复核验未通过：${error.message}`
                : "新窗口未能加载聚水潭，请稍后重试；当前登录尚未保存",
            );
          } finally {
            await probe.close();
          }
          const encrypted = encryptJstState(
            verifiedState,
            String(job.actor_id),
          );
          await db.$transaction(async (tx) => {
            await jstLock(tx);
            const s = (await jstSettings(tx, true))!;
            const active = await one(
              tx,
              `SELECT id FROM jushuitan_browser_logins WHERE id=$1::uuid AND claim_token=$2::uuid AND status='CHECKING' AND expires_at>now() FOR UPDATE`,
              job.id,
              token,
            );
            if (!active || s.version !== job.settings_version)
              throw new JstBrowserError("登录窗口或设置已改变，请重新打开");
            await jstWorkerActor(job.actor_id, tx);
            await tx.$executeRawUnsafe(
              `UPDATE jushuitan_inventory_settings SET encrypted_session=$1,session_actor_id=$2::bigint,session_status='READY',
              session_saved_at=now(),session_checked_at=now(),error_note='',version=version+1 WHERE id=1`,
              encrypted,
              String(job.actor_id),
            );
            await tx.$executeRawUnsafe(
              "UPDATE jushuitan_browser_logins SET status='SAVED',frame_id=NULL,frame_jpeg=NULL,note='已核验杭州总仓并加密保存登录会话' WHERE id=$1::uuid",
              job.id,
            );
            await tx.$executeRawUnsafe(
              "DELETE FROM jushuitan_browser_actions WHERE login_id=$1::uuid",
              job.id,
            );
          });
          return;
        }
        await assertJob(job, token, true);
        if (a.type === "REFRESH")
          await page.reload({ waitUntil: "domcontentloaded" });
        if (a.type === "CLICK")
          await page.mouse.click(
            a.point.x * jushuitanViewport.width,
            a.point.y * jushuitanViewport.height,
          );
        if (a.type === "DRAG") {
          await page.mouse.move(
            a.from.x * jushuitanViewport.width,
            a.from.y * jushuitanViewport.height,
          );
          await page.mouse.down();
          try {
            await page.mouse.move(
              a.to.x * jushuitanViewport.width,
              a.to.y * jushuitanViewport.height,
              { steps: 20 },
            );
          } finally {
            await page.mouse.up();
          }
        }
        if (a.type === "SCROLL") await page.mouse.wheel(0, a.deltaY);
        if (a.type === "KEY") await page.keyboard.press(a.key);
        if (a.type === "TEXT") {
          await inputs.fill(page, a.targetId, a.value);
        }
        note = "请完成登录，点击核验将打开商品库存并确认序缇杭州总仓";
      } catch (e) {
        note = safeError(e);
        lastAction.error = note;
      }
      nextFrame = 0;
    }
    if (Date.now() >= nextFrame) {
      await assertJob(job, token, true);
      const frameInput = await inputs.current(page);
      const masks = jstLoginMasks(page);
      const jpg = await page.screenshot({
        type: "jpeg",
        quality: 65,
        mask: masks,
        maskColor: "#b9becd",
        timeout: 15000,
      });
      await db.$transaction(async (tx) => {
        await jstLock(tx);
        // Do not mark a submitted but unconsumed input as ready or overwrite its frame token.
        if (
          await one(
            tx,
            "SELECT id FROM jushuitan_browser_actions WHERE login_id=$1::uuid",
            job.id,
          )
        )
          return;
        await tx.$executeRawUnsafe(
          `UPDATE jushuitan_browser_logins SET status='WAITING',frame_id=CASE WHEN frame_jpeg=$4 AND frame_input IS NOT DISTINCT FROM $6::jsonb AND frame_id IS NOT NULL THEN frame_id ELSE $3::uuid END,frame_jpeg=$4,note=$5,frame_input=$6::jsonb,last_action_id=$7::bigint,last_action_error=$8
          WHERE id=$1::uuid AND claim_token=$2::uuid AND status IN ${activeLogin} AND expires_at>now()`,
          job.id,
          token,
          randomUUID(),
          jpg.toString("base64"),
          note,
          frameInput ? JSON.stringify(frameInput) : null,
          lastAction?.id ?? null,
          lastAction?.error ?? null,
        );
      });
      nextFrame = Date.now() + 2500;
    }
    await delay(650);
  }
}
export async function runJushuitanTick() {
  const claimed = await db.$transaction(async (tx) => {
    await jstLock(tx);
    await expireJstTasks(tx);
    if (
      await one(
        tx,
        `SELECT id FROM jushuitan_browser_logins WHERE status IN ('RUNNING','WAITING','CHECKING') UNION ALL SELECT id FROM jushuitan_inventory_runs WHERE status='RUNNING' LIMIT 1`,
      )
    )
      return null;
    let job = await one(
      tx,
      "SELECT * FROM jushuitan_browser_logins WHERE status='QUEUED' ORDER BY created_at LIMIT 1 FOR UPDATE",
    );
    const login = !!job;
    const s = (await jstSettings(tx, true))!;
    if (!job) {
      job = await one(
        tx,
        "SELECT * FROM jushuitan_inventory_runs WHERE status='QUEUED' ORDER BY created_at LIMIT 1 FOR UPDATE",
      );
      if (
        !job &&
        s.enabled &&
        s.session_status === "READY" &&
        (!s.next_sync_at || new Date(s.next_sync_at).getTime() <= Date.now())
      ) {
        await enqueueJst(tx, s, String(s.session_actor_id), true);
        job = await one(
          tx,
          "SELECT * FROM jushuitan_inventory_runs WHERE status='QUEUED' FOR UPDATE",
        );
      }
    }
    if (!job) return null;
    const token = randomUUID();
    await tx.$executeRawUnsafe(
      login
        ? "UPDATE jushuitan_browser_logins SET status='RUNNING',claim_token=$2::uuid,heartbeat_at=now() WHERE id=$1::uuid"
        : "UPDATE jushuitan_inventory_runs SET status='RUNNING',claim_token=$2::uuid,started_at=now(),heartbeat_at=now(),stage='恢复聚水潭登录' WHERE id=$1::uuid",
      job.id,
      token,
    );
    return { job, login, token, settings: s };
  });
  if (!claimed) return;
  const { job, login, token, settings } = claimed;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined,
    deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await assertJob(job, token, login);
    if (!encryptionReady()) throw new JstBrowserError("服务器会话加密未就绪");
    browser = await chromium.launch({ headless: true });
    deadline = setTimeout(
      () => void browser?.close(),
      login ? 20 * 60000 : 29 * 60000,
    );
    heartbeat = setInterval(
      () =>
        void (async () => {
          try {
            await assertJob(job, token, login);
            await db.$executeRawUnsafe(
              `UPDATE ${login ? "jushuitan_browser_logins" : "jushuitan_inventory_runs"} SET heartbeat_at=now() WHERE id=$1::uuid AND claim_token=$2::uuid`,
              job.id,
              token,
            );
          } catch {
            await browser?.close().catch(() => {});
          }
        })(),
      10000,
    );
    // Login starts fresh; it never transfers another administrator's saved session into an interactive window.
    const saved = !login
      ? decryptJstState(
          settings.encrypted_session,
          String(settings.session_actor_id),
        )
      : undefined;
    const context = await createContext(browser, saved),
      page = await openHome(context);
    if (login) await runLogin(job, token, context, page, browser);
    else {
      const targets = (await rows(
        db,
        "SELECT sku_code,barcode,color_name,size_name FROM skus ORDER BY sku_code",
      )) as JstTarget[];
      await db.$executeRawUnsafe(
        "UPDATE jushuitan_inventory_runs SET requested_count=$2 WHERE id=$1::uuid AND claim_token=$3::uuid",
        job.id,
        targets.length,
        token,
      );
      const result = await exportJstInventory(
        page,
        targets,
        () => assertJob(job, token, false),
        async (stage) => {
          await db.$executeRawUnsafe(
            "UPDATE jushuitan_inventory_runs SET stage=$3 WHERE id=$1::uuid AND claim_token=$2::uuid AND status='RUNNING'",
            job.id,
            token,
            stage,
          );
        },
      );
      await assertJob(job, token, false);
      const state = encryptJstState(
        await collectJstState(context),
        String(settings.session_actor_id),
      );
      await publishJstExport(job, token, result.report, result.files, state);
    }
  } catch (e) {
    const note = safeError(e);
    await db.$transaction(async (tx) => {
      await jstLock(tx);
      if (login)
        await tx.$executeRawUnsafe(
          `UPDATE jushuitan_browser_logins SET status='FAILED',frame_id=NULL,frame_jpeg=NULL,note=$3 WHERE id=$1::uuid AND claim_token=$2::uuid AND status IN ${activeLogin}`,
          job.id,
          token,
          note,
        );
      else {
        const changed = await tx.$executeRawUnsafe(
          "UPDATE jushuitan_inventory_runs SET status='FAILED',finished_at=now(),error_note=$3 WHERE id=$1::uuid AND claim_token=$2::uuid AND status='RUNNING'",
          job.id,
          token,
          note,
        );
        if (changed)
          await tx.$executeRawUnsafe(
            `UPDATE jushuitan_inventory_settings SET error_note=$1,session_status=CASE WHEN $2 THEN 'LOGIN_REQUIRED' ELSE session_status END,
          enabled=CASE WHEN $2 THEN false ELSE enabled END WHERE id=1 AND version=$3`,
            note,
            e instanceof JstBrowserError && e.loginRequired,
            job.settings_version,
          );
      }
    });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (deadline) clearTimeout(deadline);
    await browser?.close().catch(() => {});
    if (login)
      await db.$executeRawUnsafe(
        "DELETE FROM jushuitan_browser_actions WHERE login_id=$1::uuid",
        job.id,
      );
  }
}
export function startJushuitanInventory() {
  let pending: Promise<void> | undefined;
  const tick = async () => {
    try {
      await db.$executeRawUnsafe(
        "UPDATE jushuitan_inventory_settings SET worker_heartbeat_at=now(),browser_encryption_ready=$1 WHERE id=1",
        encryptionReady(),
      );
      if (!pending)
        pending = runJushuitanTick()
          .catch(() =>
            console.warn(
              "Jushuitan browser task failed; private state not logged",
            ),
          )
          .finally(() => {
            pending = undefined;
          });
    } catch {
      console.warn("Jushuitan browser worker unavailable");
    }
  };
  const timer = setInterval(() => void tick(), 5000);
  timer.unref();
  void tick();
  return async () => {
    clearInterval(timer);
    await pending;
  };
}
