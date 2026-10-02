import nodemailer from "nodemailer";
import { z } from "zod";
import {
  audit,
  command,
  Context,
  fail,
  parse,
  requirePermission,
} from "../../core.js";
import {
  db,
  json,
  one,
  rows,
} from "../../../../../packages/database/src/index.js";
import {
  compassLabels,
  shanghaiDate,
  shiftCompassDate,
} from "../../../../../packages/contracts/src/compass-analytics.js";
import { compassSources } from "./service.js";
import { collectCompassBundle } from "./report-data.js";
import { CompassAIResult, ensureAIAnalysis } from "./ai.js";
import {
  decryptSecret as decryptMailPassword,
  encryptSecret as encryptMailPassword,
} from "./secrets.js";
export { decryptMailPassword, encryptMailPassword };

const publicSettings = (r: any) => ({
  enabled: r.enabled,
  smtpHost: r.smtp_host,
  smtpPort: r.smtp_port,
  smtpUser: r.smtp_user,
  fromEmail: r.from_email,
  recipients: r.recipients,
  passwordConfigured: Boolean(r.password_encrypted),
  encryptionReady: /^[a-f0-9]{64}$/i.test(process.env.COMPASS_MAIL_KEY || ""),
  verifiedAt: r.verified_at,
  updatedAt: r.updated_at,
  schedule: "每天 08:00（北京时间）",
  collector: "本机 Chrome / Codex 定时采集，电脑及应用需要在线",
});
export async function getMailSettings() {
  return publicSettings(
    await one(db, "SELECT * FROM compass_mail_settings WHERE id=1"),
  );
}
export const settingsSchema = z
  .object({
    enabled: z.boolean(),
    smtpHost: z
      .string()
      .trim()
      .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i)
      .max(253),
    smtpPort: z.union([z.literal(465), z.literal(587)]),
    smtpUser: z.email().max(254),
    fromEmail: z.email().max(254),
    recipients: z.array(z.email().max(254)).min(1).max(20),
    password: z.string().max(256).optional(),
  })
  .strict();
export async function saveMailSettings(c: Context, input: unknown) {
  requirePermission(c.actor, "analytics.manage");
  const b = parse(settingsSchema, input);
  if (b.smtpUser.toLowerCase() !== b.fromEmail.toLowerCase())
    fail("INVALID_SENDER", "发件地址需与 SMTP 账号一致", 400);
  const recipients = [...new Set(b.recipients.map((v) => v.toLowerCase()))];
  return command(c, "compass.mail-settings", b, async (tx) => {
    const old = await one(
      tx,
      "SELECT * FROM compass_mail_settings WHERE id=1 FOR UPDATE",
    );
    const credentialsChanged =
      Boolean(b.password) ||
      old!.smtp_host !== b.smtpHost ||
      old!.smtp_port !== b.smtpPort ||
      old!.smtp_user !== b.smtpUser;
    const encrypted = b.password
      ? encryptMailPassword(b.password)
      : credentialsChanged
        ? null
        : old!.password_encrypted;
    if (b.enabled && !encrypted)
      fail(
        "MAIL_PASSWORD_MISSING",
        "请填写 QQ 邮箱 SMTP 授权码或其他邮件服务密码",
        400,
      );
    const result = await one(
      tx,
      "UPDATE compass_mail_settings SET enabled=$1,smtp_host=$2,smtp_port=$3,smtp_user=$4,from_email=$5,recipients=$6::jsonb,password_encrypted=$7,verified_at=CASE WHEN $8 THEN NULL ELSE verified_at END,updated_by=$9::bigint,version=version+1,updated_at=now() WHERE id=1 RETURNING *",
      b.enabled,
      b.smtpHost,
      b.smtpPort,
      b.smtpUser,
      b.fromEmail,
      JSON.stringify(recipients),
      encrypted,
      credentialsChanged,
      c.actor.id,
    );
    await audit(
      tx,
      c,
      "COMPASS_MAIL_SETTINGS",
      "compass_mail_settings",
      1,
      publicSettings(old),
      publicSettings(result),
    );
    return publicSettings(result);
  });
}
function transport(settings: any) {
  if (!settings?.password_encrypted)
    fail("MAIL_PASSWORD_MISSING", "尚未配置发件授权码", 400);
  return nodemailer.createTransport({
    host: settings.smtp_host,
    port: settings.smtp_port,
    secure: settings.smtp_port === 465,
    requireTLS: true,
    auth: {
      user: settings.smtp_user,
      pass: decryptMailPassword(settings.password_encrypted),
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  });
}
function mailError(error: any) {
  if (error?.code === "EAUTH")
    return "邮件服务认证失败，请检查 SMTP 是否开启及邮箱授权码";
  if (error?.code === "EENVELOPE")
    return "邮件服务拒绝收件地址，请检查邮箱或发件权限";
  if (["ETIMEDOUT", "ECONNECTION", "ESOCKET", "EDNS"].includes(error?.code))
    return "无法连接邮件服务，请检查网络及 SMTP 地址/端口";
  return "邮件发送未确认，请检查发件服务后重试";
}
export async function testMail() {
  const settings = await one(
      db,
      "SELECT * FROM compass_mail_settings WHERE id=1",
    ),
    smtp = transport(settings);
  try {
    await smtp.verify();
    const verified = await one(
      db,
      "UPDATE compass_mail_settings SET verified_at=now() WHERE id=1 AND version=$1 RETURNING verified_at",
      settings!.version,
    );
    if (!verified) fail("SETTINGS_CHANGED", "邮件配置已变更，请重新验证", 409);
    return { verified: true, verifiedAt: verified.verified_at };
  } catch (e: any) {
    if (e.getStatus) throw e;
    fail("SMTP_FAILED", mailError(e), 400);
  } finally {
    smtp.close();
  }
}
const esc = (value: any) =>
  String(value ?? "—").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const num = (value: any) =>
  value == null
    ? "—"
    : Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const pct = (value: any) =>
  value == null ? "—" : (Number(value) * 100).toFixed(2) + "%";
export function buildCompassEmail(
  date: string,
  snapshots: any[],
  windows: any[],
  ai?: CompassAIResult,
) {
  const style = snapshots.find((s) => s.dimension === "style"),
    s = style.summary;
  const top = style.top.slice(0, 5),
    contribution =
      s.salesAmount && top[0]
        ? Number(top[0].salesAmount) / Number(s.salesAmount)
        : null;
  const observations = [
    `近 7 天销售额 ¥${num(s.salesAmount)}，净销售额 ¥${num(s.netSalesAmount)}，销售 ${num(s.salesQty)} 件。`,
    `期间退货 ${num(s.returnsQty)} 件，退货金额 ¥${num(s.returnsAmount)}，退货件数 / 销售量为 ${pct(s.returnRate)}。`,
    `截至 ${date} 平台可售库存 ${num(s.saleableStock)} 件；库存采用当天快照。`,
    top[0]
      ? `销量金额首位款号 ${top[0].code}，销售額 ¥${num(top[0].salesAmount)}，占近 7 天款号销售额 ${pct(contribution)}。`
      : "期间没有可排名记录。",
  ];
  const table = (data: any[], labels: string[], cells: (r: any) => any[]) =>
    `<table style="border-collapse:collapse;width:100%"><thead><tr>${labels.map((l) => `<th style="padding:10px;text-align:left;background:#fff2e5">${esc(l)}</th>`).join("")}</tr></thead><tbody>${data
      .map(
        (r) =>
          `<tr>${cells(r)
            .map(
              (v) =>
                `<td style="padding:10px;border-bottom:1px solid #eee">${esc(v)}</td>`,
            )
            .join("")}</tr>`,
      )
      .join("")}</tbody></table>`;
  const aiLines =
    ai?.state === "READY" && ai.content
      ? [
          `AI 经营分析 · ${ai.responseModel} · ${ai.provider} · ${ai.generatedAt?.toISOString() || ""}`,
          ai.content.summary,
          "经营观察",
          ...ai.content.observations,
          "建议",
          ...ai.content.actions,
          "风险与数据限制",
          ...ai.content.risks,
        ]
      : [ai?.message || "AI 分析尚未开启，本日报使用报表汇总"];
  const aiHtml =
    ai?.state === "READY" && ai.content
      ? `<h2>AI 经营分析</h2><p>模型：${esc(ai.responseModel)} · ${esc(ai.provider)} · 数据截止 ${esc(ai.reportDate)} · AI 建议供经营决策参考</p><p>${esc(ai.content.summary)}</p>${[
          ["经营观察", ai.content.observations],
          ["建议", ai.content.actions],
          ["风险与数据限制", ai.content.risks],
        ]
          .map(
            ([label, items]) =>
              `<h3>${esc(label)}</h3><ul>${(items as string[]).map((v) => `<li>${esc(v)}</li>`).join("")}</ul>`,
          )
          .join("")}`
      : `<p>AI 状态：${esc(aiLines[0])}。以下为报表汇总。</p>`;
  const html = `<div style="font:14px/1.8 sans-serif;color:#33261d;max-width:1000px;margin:auto"><h1>唯品会每日经营分析</h1><p>数据截止：${esc(date)} · 来源：中台·魔方罗盘三张每日明细报表</p>${aiHtml}<h2>报表摘要</h2><ul>${observations.map((v) => `<li>${esc(v)}</li>`).join("")}</ul><h2>款号维度 · 日期比较</h2>${table(windows, ["周期", "销售额", "净销售额", "销售件数", "退货率"], (r) => [`近 ${r.days} 天`, num(r.summary.salesAmount), num(r.summary.netSalesAmount), num(r.summary.salesQty), pct(r.summary.returnRate)])}
    <h2>三个维度 · 近 7 天</h2>${table(snapshots, ["维度", "销售额", "净销售额", "销售件数", "退货件数", "截止日可售库存"], (r) => [compassLabels[r.dimension as keyof typeof compassLabels], num(r.summary.salesAmount), num(r.summary.netSalesAmount), num(r.summary.salesQty), num(r.summary.returnsQty), num(r.summary.saleableStock)])}
    ${snapshots.map((r) => `<h2>${compassLabels[r.dimension as keyof typeof compassLabels]} TOP 10</h2>${table(r.top, ["编码", "销售额", "销售件数", "退货率", "可售库存"], (v) => [v.code, num(v.salesAmount), num(v.salesQty), pct(v.returnRate), num(v.saleableStock)])}`).join("")}
    <p>三个维度各自统计，不相加；UV 和客户数跨日未去重。退货率为当期流量比，不代表同批订单退货率。平台库存不会覆盖 ERP 实物库存。本报告按报表数值生成，未包含成本或利润。</p><p><a href="${esc(process.env.APP_ORIGIN || "")}/analytics/compass">打开经营分析面板</a></p></div>`;
  return {
    subject: `唯品会经营日报 · ${date}`,
    html,
    text: [
      `唯品会经营日报 · 数据截止 ${date}`,
      ...aiLines,
      ...observations,
      `面板：${process.env.APP_ORIGIN || ""}/analytics/compass`,
    ].join("\n"),
  };
}
export async function mailHistory() {
  return rows(
    db,
    "SELECT report_date::text,recipient,status,attempt,error_note,message_id,sent_at,started_at FROM compass_mail_runs ORDER BY id DESC LIMIT 50",
  );
}
export async function sendDailyReport(automatic = false) {
  const date = shiftCompassDate(shanghaiDate(), -1),
    settings = await one(db, "SELECT * FROM compass_mail_settings WHERE id=1");
  if (!settings!.enabled)
    return { state: "DISABLED", message: "每日邮件尚未开启" };
  if (!settings!.verified_at)
    return { state: "WAITING_SMTP", message: "请先保存并验证发件配置" };
  const sources = await compassSources();
  if (
    sources.length !== 3 ||
    sources.some(
      (s) => s.end_date !== date || s.start_date > shiftCompassDate(date, -29),
    )
  )
    return {
      state: "WAITING_DATA",
      message: `等待三张截至 ${date} 的完整近 30 天报表，不会发送旧数据`,
    };
  const previous = await rows(
    db,
    "SELECT recipient,status,attempt,started_at FROM compass_mail_runs WHERE report_date=$1::date",
    date,
  );
  const candidates = (settings!.recipients as string[]).filter((recipient) => {
    const old = previous.find((r) => r.recipient === recipient);
    return (
      !old ||
      (old.status === "SENDING" &&
        Date.now() - old.started_at.getTime() > 300000) ||
      (old.status === "FAILED" &&
        (!automatic ||
          (old.attempt < 3 && Date.now() - old.started_at.getTime() > 1800000)))
    );
  });
  if (!candidates.length)
    return {
      state: previous.some((r) => ["FAILED", "UNKNOWN"].includes(r.status))
        ? "ATTENTION"
        : "COMPLETE",
      reportDate: date,
      results: previous.map((r) => ({
        recipient: r.recipient,
        state: r.status,
      })),
    };
  const bundle = await collectCompassBundle(date);
  if (!bundle)
    return { state: "WAITING_DATA", message: "报表更新中，等待完整数据" };
  const ai = await ensureAIAnalysis(bundle);
  if (ai.state === "PENDING")
    return {
      state: "WAITING_AI",
      message: "AI 正在生成，稍后将发送今日报告",
      reportDate: date,
    };
  const message = buildCompassEmail(date, bundle.snapshots, bundle.windows, ai),
    smtp = transport(settings);
  const results = [];
  try {
    for (const recipient of candidates) {
      const claimed = await db.$transaction(async (tx) => {
        await rows(
          tx,
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text",
          `compass-mail:${date}:${recipient}`,
        );
        const old = await one(
          tx,
          "SELECT * FROM compass_mail_runs WHERE report_date=$1::date AND recipient=$2 FOR UPDATE",
          date,
          recipient,
        );
        if (
          old?.status === "SENDING" &&
          Date.now() - old.started_at.getTime() > 300000
        ) {
          await tx.$executeRawUnsafe(
            "UPDATE compass_mail_runs SET status='UNKNOWN',error_note='上次发送未确认；请核对邮箱后由管理员处理，避免重复发送' WHERE id=$1::bigint",
            old.id,
          );
          return null;
        }
        // Accepted or uncertain sends are never automatically repeated. Retry only a confirmed failure.
        if (old && old.status !== "FAILED") return null;
        return one(
          tx,
          `INSERT INTO compass_mail_runs(report_date,recipient,status,imported_ids,summary) VALUES($1::date,$2,'SENDING',$3::jsonb,$4::jsonb)
        ON CONFLICT(report_date,recipient) DO UPDATE SET status='SENDING',attempt=compass_mail_runs.attempt+1,started_at=now(),error_note='',imported_ids=excluded.imported_ids,summary=excluded.summary RETURNING id`,
          date,
          recipient,
          JSON.stringify(json(bundle.ids)),
          JSON.stringify(
            json({
              metrics: bundle.summary,
              ai: {
                state: ai.state,
                model: ai.model,
                responseId: ai.responseId,
                message: ai.message,
              },
            }),
          ),
        );
      });
      if (!claimed) {
        results.push({ recipient, state: "ALREADY_HANDLED" });
        continue;
      }
      try {
        const sent = await smtp.sendMail({
          ...message,
          from: {
            name: "序缇供应链 · 经营分析",
            address: settings!.from_email,
          },
          to: recipient,
          messageId: `<compass-${date}-${claimed.id}@${settings!.from_email.split("@")[1]}>`,
        });
        if (!sent.accepted?.length)
          throw Object.assign(Error("Rejected"), { code: "EENVELOPE" });
        await db.$executeRawUnsafe(
          "UPDATE compass_mail_runs SET status='ACCEPTED',message_id=$2,sent_at=now() WHERE id=$1::bigint",
          claimed.id,
          String(sent.messageId),
        );
        results.push({ recipient, state: "ACCEPTED" });
      } catch (e: any) {
        // A connection drop during DATA can happen after acceptance; do not blindly retry it.
        const uncertain =
          ["DATA", "CONN"].includes(e.command) &&
          ["ESOCKET", "ETIMEDOUT", "ECONNECTION"].includes(e.code);
        const status = uncertain ? "UNKNOWN" : "FAILED";
        await db.$executeRawUnsafe(
          "UPDATE compass_mail_runs SET status=$2,error_note=$3 WHERE id=$1::bigint",
          claimed.id,
          status,
          mailError(e),
        );
        results.push({ recipient, state: status, message: mailError(e) });
      }
    }
  } finally {
    smtp.close();
  }
  return {
    state: results.some((r) => ["FAILED", "UNKNOWN"].includes(r.state))
      ? "ATTENTION"
      : "COMPLETE",
    reportDate: date,
    ai: { state: ai.state, model: ai.model, message: ai.message },
    results,
  };
}
