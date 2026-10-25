import type { RequestHandler, Request } from "express";
import {
  createStudio,
  type Studio,
  type StudioUser,
} from "../../../../../packages/aigc-engine/index.mjs";
import { db, rows } from "../../../../../packages/database/src/index.js";
import { actorFor } from "../auth/service.js";
import {
  StudioDatabase,
  maxAssetBytes,
  objectStorageReady,
} from "./persistence.js";
import { engineConfig, visibleSettings, saveSettings } from "./config.js";
import type { Actor } from "../../core.js";

const PREFIX = "/api/v1/aigc";
const asUser = (actor: Actor): StudioUser => ({
  id: actor.id,
  username: actor.username,
  displayName: actor.displayName,
  role: actor.permissions.includes("aigc.manage") ? "super_admin" : "operator",
});
async function permittedUsers(): Promise<StudioUser[]> {
  const users = await rows(
    db,
    `SELECT u.id::text,u.username,u.display_name,
    bool_or(p.code='aigc.manage' OR r.code='SUPER_ADMIN') AS manage
    FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id
    JOIN role_permissions rp ON rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id
    WHERE u.status='ACTIVE' GROUP BY u.id HAVING bool_or(p.code='aigc.use' OR r.code='SUPER_ADMIN') ORDER BY u.id`,
  );
  return users.map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: u.manage ? "super_admin" : "operator",
  }));
}
function statusCode(error: any) {
  return error.statusCode || error.getStatus?.() || 500;
}
function safeMessage(error: any, studio?: Studio) {
  let message =
    error.name === "ZodError"
      ? error.issues.map((i: any) => i.message).join("；")
      : String(error.message || "AIGC 请求失败");
  for (const secret of [
    studio?.config.openrouterApiKey,
    studio?.config.opentalkingApiKey,
    ...Object.values(studio?.config.videoSecrets || {}),
  ])
    if (typeof secret === "string" && secret.length > 4)
      message = message.split(secret).join("[已隐藏]");
  return message.replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]").slice(0, 1000);
}
export function createAigcService() {
  let studio: Studio | undefined,
    persistence: StudioDatabase | undefined,
    starting = false,
    closed = false,
    refreshing = false;
  let lastRefresh = 0;
  async function initialize() {
    if (starting || studio || closed) return;
    starting = true;
    const candidate = new StudioDatabase();
    try {
      if (
        !(await candidate.acquire(() => {
          if (persistence !== candidate) return;
          studio?.stop();
          studio = undefined;
          persistence = undefined;
          void candidate.close();
        }))
      )
        return;
      persistence = candidate;
      const config = await engineConfig();
      const created = await createStudio({
        config,
        persistence: candidate,
        users: await permittedUsers(),
      });
      if (closed) {
        created.stop();
        await candidate.close();
        return;
      }
      studio = created;
      lastRefresh = Date.now();
      studio.start();
    } catch {
      // This optional module must never prevent inventory/login/the main app booting.
      await candidate.close();
      persistence = undefined;
    } finally {
      starting = false;
    }
  }
  async function refresh() {
    if (!studio || !persistence || refreshing) return;
    refreshing = true;
    try {
      await persistence.heartbeat();
      await studio.syncUsers(await permittedUsers());
      Object.assign(studio.config, await engineConfig());
      lastRefresh = Date.now();
    } catch {
      studio?.stop();
      studio = undefined;
      await persistence?.close();
      persistence = undefined;
    } finally {
      refreshing = false;
    }
  }
  const timer = setInterval(() => {
    if (!studio) void initialize();
    else void refresh();
  }, 10_000);
  timer.unref();
  const gc = setInterval(() => {
    void persistence?.collectGarbage().catch(() => {});
  }, 3_600_000);
  gc.unref();
  void initialize();

  const middleware: RequestHandler = async (req, res, next) => {
    if (!(req.path === PREFIX || req.path.startsWith(`${PREFIX}/`)))
      return next();
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const suffix = req.path.slice(PREFIX.length) || "/";
    const callback =
      /^\/(generation-reference|enhancement-source)\/[\w-]+$/.test(suffix) &&
      ["GET", "HEAD"].includes(req.method);
    try {
      let actor: Actor | undefined;
      if (!callback) {
        actor = await actorFor(req.cookies?.session);
        if (!actor.permissions.includes("aigc.use"))
          return res.status(403).json({ error: "没有 AIGC 使用权限" });
        if (
          !["GET", "HEAD"].includes(req.method) &&
          (req.get("Origin") !== process.env.APP_ORIGIN ||
            req.get("X-CSRF-Token") !== actor.csrfToken)
        )
          return res.status(403).json({ error: "请刷新页面后重试" });
      }
      if (
        ["/platform", "/auth", "/license", "/update"].some(
          (p) => suffix === p || suffix.startsWith(`${p}/`),
        ) ||
        /\/admin\/(pricing|payments|orders|users|charges|console|live-pricing|depth\/pricing|digital-human\/gpu)(\/|$)/.test(
          suffix,
        )
      )
        return res.status(404).json({ error: "未提供此接口" });
      if (
        (suffix.startsWith("/admin/") || suffix === "/services") &&
        !actor?.permissions.includes("aigc.manage")
      )
        return res.status(403).json({ error: "没有 AIGC 服务管理权限" });
      if (suffix === "/status" && req.method === "GET") {
        return res.json({
          ready: Boolean(studio),
          storage: objectStorageReady() ? "object" : "database",
          maxUploadBytes: maxAssetBytes(),
          compile: Boolean(studio?.config.openrouterApiKey),
          image: Boolean(
            studio?.config.videoSecrets?.VIDEO_RELAY_API_KEY ||
            studio?.config.videoSecrets?.XYLP_IMAGE_TT25_KEY ||
            studio?.config.videoSecrets?.XYLP_IMAGE_BANANA_PRO_KEY ||
            studio?.config.videoSecrets?.XHAI_API_KEY,
          ),
          video: Boolean(
            studio?.config.xaiApiKey ||
            studio?.config.videoSecrets?.VIDEO_RELAY_API_KEY ||
            studio?.config.videoSecrets?.XHAI_API_KEY,
          ),
          digital: Boolean(studio?.config.opentalkingBaseUrl),
          model: "openai/gpt-6.1-sol",
          manage: actor?.permissions.includes("aigc.manage"),
        });
      }
      if (!studio)
        return res
          .status(503)
          .json({ error: "AIGC 正在连接持久存储或交接任务，请稍后重试" });
      // Stop submissions if authorization/configuration cannot be refreshed.
      if (Date.now() - lastRefresh > 15_000) {
        await refresh();
        if (!studio)
          throw Object.assign(new Error("AIGC 暂时无法同步账号权限"), {
            statusCode: 503,
          });
      }
      if (suffix === "/services") {
        if (req.method === "GET") return res.json(await visibleSettings());
        if (req.method === "PUT") {
          if (
            Object.values<any>(studio.store.data.jobs).some((job) =>
              ["running", "waiting_provider", "queued"].includes(job.status),
            ) ||
            Object.values<any>(
              studio.store.data.digitalHuman?.operations || {},
            ).some((op) =>
              [
                "submitting",
                "queued",
                "generating",
                "starting",
                "ready",
                "uncertain",
              ].includes(op.status),
            )
          )
            return res
              .status(409)
              .json({ error: "请先等待生成任务结束，再修改服务配置" });
          const input = await jsonBody(req);
          if (
            input?.opentalkingBaseUrl !==
              (studio.config.opentalkingBaseUrl || "") &&
            (Object.values<any>(
              studio.store.data.digitalHuman?.avatars || {},
            ).some((a) => !a.deletedAt) ||
              Object.values<any>(
                studio.store.data.digitalHuman?.operations || {},
              ).some((op) => op.remoteId))
          )
            return res
              .status(409)
              .json({
                error:
                  "已有数字人形象或远端任务，请保持原推理服务地址，避免将旧任务编号发送到另一服务",
              });
          const result = await saveSettings(actor!.id, input);
          Object.assign(studio.config, await engineConfig());
          return res.json(result);
        }
        return res.status(405).json({ error: "不支持此方法" });
      }
      const url = new URL(req.originalUrl, "http://localhost");
      url.pathname = `/api${suffix}`;
      await studio.handle(req, res, url, actor ? asUser(actor) : undefined);
    } catch (error: any) {
      const code = error.name === "ZodError" ? 400 : statusCode(error);
      if (!res.headersSent)
        res.status(code).json({ error: safeMessage(error, studio) });
      else res.destroy();
    }
  };
  return {
    middleware,
    close: async () => {
      closed = true;
      clearInterval(timer);
      clearInterval(gc);
      studio?.stop();
      studio = undefined;
      await persistence?.close();
    },
  };
}
async function jsonBody(req: Request) {
  if (!req.is("application/json"))
    throw Object.assign(new Error("请使用 JSON 请求"), { statusCode: 415 });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const bytes of req) {
    size += bytes.length;
    if (size > 32_768)
      throw Object.assign(new Error("设置内容过长"), { statusCode: 413 });
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("JSON 格式不正确"), { statusCode: 400 });
  }
}
