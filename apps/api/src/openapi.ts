import { OpenAPIObject } from "@nestjs/swagger";
import { z } from "zod";
import { resources } from "./modules/master/service.js";
import {
  poInput,
  receiptInput,
  cmdInput,
} from "./modules/purchases/service.js";
import { styleSelectionInput } from "./modules/style-selections/service.js";
import { id, qty, positive, money, text } from "./core.js";
import { beginSchema, chunkSchema } from "./modules/analytics/service.js";
import { settingsSchema } from "./modules/analytics/mail.js";
import { aiSettingsSchema } from "./modules/analytics/ai.js";
import { loginSchema } from "./modules/auth/service.js";
import { compassProbeRequestSchema } from "./integrations/vip/compass.js";
import { vipControlImportSchema } from "../../../packages/contracts/src/vip-control.js";
import { inventorySkuStyleLookupSchema } from "../../../packages/contracts/src/inventory-import.js";
import { inventoryImageWriteSchema, inventoryImageDeleteSchema, inventoryImageBatchSchema } from "../../../packages/contracts/src/inventory-image.js";
import { replenishmentPolicyWriteSchema } from "../../../packages/contracts/src/inventory-replenishment.js";
import { inventoryCalculationWriteSchema, inventoryCalculationFieldWriteSchema, inventoryCalculationFieldDeleteSchema, inventoryCalculationFieldViewSchema } from "../../../packages/contracts/src/inventory-formula.js";
import { assistantSendSchema, assistantMemorySaveSchema } from "../../../packages/contracts/src/personal-assistant.js";
import { workspaceSaveSchema } from "../../../packages/contracts/src/personal-workspace.js";
import { appearanceSchema } from "../../../packages/contracts/src/appearance.js";
import { agentaiSaveSchema, agentaiTestSchema } from "../../../packages/contracts/src/agentai.js";
import { agentAiAudioInputSchema, agentAiSpeechSchema } from "../../../packages/contracts/src/agentai-audio.js";
import {
  relayProbeSchema,
  relayStationSaveSchema,
  smartApplySchema,
  smartPolicySaveSchema,
} from "../../../packages/contracts/src/smart-models.js";
import {
  listingRequestSchema,
  listingStates,
} from "./integrations/vip/listing.js";
export function enrichOpenApi(doc: OpenAPIObject) {
  const schema = (s: z.ZodType) =>
    z.toJSONSchema(s, { target: "openapi-3.0", io: "input" });
  const set = (
    path: string,
    method: string,
    body?: z.ZodType,
    summary?: string,
  ) => {
    doc.paths[path] ??= {};
    const operation: any = (doc.paths[path] as any)[method] || {
      responses: {
        200: {
          description:
            "成功。响应为 {data,requestId}，列表另含page/pageSize/total",
        },
        400: { description: "输入错误" },
        401: { description: "未登录" },
        403: { description: "权限不足" },
        409: { description: "状态、版本或幂等冲突" },
        422: { description: "业务规则待确认或库存不足" },
      },
    };
    operation.summary = summary || operation.summary;
    operation.security = path.endsWith("/auth/login") ? [] : [{ session: [] }];
    operation.parameters = [
      ...Array.from(path.matchAll(/\{([^}]+)\}/g), (m) => ({
        name: m[1],
        in: "path",
        required: true,
        schema: { type: "string", pattern: "^[1-9][0-9]*$" },
      })),
      ...(method === "get" && !path.includes("{")
        ? [
            {
              name: "page",
              in: "query",
              schema: { type: "integer", minimum: 1, default: 1 },
            },
            {
              name: "pageSize",
              in: "query",
              schema: {
                type: "integer",
                minimum: 1,
                maximum: 100,
                default: 20,
              },
            },
          ]
        : []),
    ];
    if (body)
      operation.requestBody = {
        required: true,
        content: { "application/json": { schema: schema(body) } },
      };
    if (
      ["post", "patch", "delete"].includes(method) &&
      !path.endsWith("/auth/login") &&
      !path.endsWith("/auth/logout")
    )
      operation.parameters.push(
        {
          name: "Idempotency-Key",
          in: "header",
          required: true,
          schema: { type: "string", maxLength: 128 },
        },
        {
          name: "X-CSRF-Token",
          in: "header",
          required: true,
          schema: { type: "string" },
        },
      );
    (doc.paths[path] as any)[method] = operation;
  };
  delete doc.paths["/api/v1/{resource}"];
  delete doc.paths["/api/v1/{resource}/{id}"];
  set("/api/v1/integrations/vip/control", "get", undefined, "按供应商分页查询 VC 导出管控资料（商品/货号维度）");
  doc.paths["/api/v1/integrations/vip/control"]!.get!.parameters!.push(
    { name: "namespace", in: "query", required: true, schema: { type: "string" } },
    { name: "q", in: "query", required: false, schema: { type: "string", maxLength: 100 } },
  );
  set("/api/v1/integrations/vip/control/import", "post", vipControlImportSchema, "导入 VC 原始管控类型和最后一次下架原因，不推算当前管控状态");
  set(
    "/api/v1/integrations/vip/catalog",
    "get",
    undefined,
    "分页查询平台商品及已采集条码的款号状态",
  );
  doc.paths["/api/v1/integrations/vip/catalog"]!.get!.parameters!.push({
    name: "state",
    in: "query",
    required: false,
    schema: { type: "string", enum: [...listingStates] },
  });
  for (const [name, r] of Object.entries(resources)) {
    if (name.endsWith("-mappings"))
      set("/api/v1/" + name + "/{id}", "delete", undefined, "删除未引用映射");
    set("/api/v1/" + name, "get", undefined, "分页查询 " + name);
    set("/api/v1/" + name, "post", r.schema, "创建 " + name);
    set("/api/v1/" + name + "/{id}", "get", undefined, "读取 " + name);
    set(
      "/api/v1/" + name + "/{id}",
      "patch",
      r.schema.partial(),
      "编辑 " + name,
    );
  }
  set("/api/v1/products/{id}/skus", "get");
  set("/api/v1/style-selections", "get", undefined, "分页查询选款登记");
  set("/api/v1/style-selections", "post", styleSelectionInput, "创建选款登记");
  set(
    "/api/v1/style-selections/{id}",
    "patch",
    styleSelectionInput.partial(),
    "编辑选款登记",
  );
  set(
    "/api/v1/products/{id}/skus",
    "post",
    resources.skus.schema.omit({ productId: true }),
  );
  set(
    "/api/v1/auth/login",
    "post",
    loginSchema,
  );
  set("/api/v1/purchase-orders", "post", poInput);
  set(
    "/api/v1/purchase-orders/{id}",
    "patch",
    poInput.extend({ expectedVersion: qty }),
  );
  for (const action of ["submit", "confirm", "cancel"])
    set("/api/v1/purchase-orders/{id}/" + action, "post", cmdInput);
  set("/api/v1/receipts", "post", receiptInput);
  set(
    "/api/v1/receipts/{id}",
    "patch",
    receiptInput
      .pick({ items: true, remark: true })
      .extend({ expectedVersion: qty }),
  );
  for (const action of ["mark-received", "post", "cancel"])
    set("/api/v1/receipts/{id}/" + action, "post", cmdInput);
  set("/api/v1/inventory/summary", "get", undefined, "按条码（商品编码）、货号或款号汇总库存；totals覆盖全部筛选结果。附带只读唯品会条码/款号状态、核验和最后上下架时间；未匹配或歧义不推断状态，款号状态汇总平台全部已采集条码。图片顺序：唯品会商品图（款号视图其次为整款图）及罗盘图 → 用户上传图 → 选款登记档案图（仅款号视图）；imageSources按顺序列出供加载失败时回退，inventoryUserImage为当前行可替换的上传图。");
  doc.paths["/api/v1/inventory/summary"].get!.parameters!.push(
    { name: "dimension", in: "query", schema: { type: "string", enum: ["sku", "article", "style"], default: "sku" } },
    { name: "reportMatch", in: "query", schema: { type: "string", enum: ["all", "matched", "unmatched"], default: "all" }, description: "条码维度按所选经营参考周期的报表匹配情况筛选" },
    { name: "barcodeState", in: "query", schema: { type: "string", enum: ["LISTED", "UNLISTED", "UNPUBLISHED"] }, description: "条码状态；在分页及货号/款号汇总前筛选，库存总计只包含匹配条码。可与styleState组合；省略为全部" },
    { name: "styleState", in: "query", schema: { type: "string", enum: ["LISTED", "UNLISTED", "PARTIAL", "UNPUBLISHED"] }, description: "款号状态；判定覆盖平台同款全部已采集条码，不随库存筛选变化。listingCounts分别返回搜索及罗盘匹配范围内去重的条码/款号总数、各状态数量及other；不受分页和两项状态筛选影响" },
    { name: "referencePeriod", in: "query", schema: { type: "string", enum: ["3d", "7d", "15d", "30d", "3m", "6m", "1y"] }, description: "库存经营参考周期；省略时使用当前账号保存的默认周期，首次为近30天。以最新完整条码报表截止日为终点，月年按日历滚动；日销及退货率按账号配置独立取中位数、众数或平均值。历史日期覆盖不完整时保留人工参考" },
    { name: "q", in: "query", schema: { type: "string", maxLength: 100 }, description: "商品编码、货号、款号、名称或条码关键词" },
    { name: "styleNo", in: "query", schema: { type: "string", maxLength: 150 }, description: "按完整款号精确筛选，忽略首尾空格和字母大小写" },
    ...["warehouseId", "skuId", "productId", "supplierId", "categoryId"].map((name) => ({ name, in: "query" as const, schema: { type: "string" as const, pattern: "^[1-9][0-9]*$" } })),
  );
  set("/api/v1/inventory/images", "post", inventoryImageWriteSchema, "上传或替换款号（colorName为空）或颜色的库存图片；JPG/PNG/WebP且小于500 KB。仅在唯品会无图片时显示，独立保存，不依赖选款登记权限；需库存调整权限");
  set("/api/v1/inventory/images/delete", "post", inventoryImageDeleteSchema, "删除上传的库存图片；不影响唯品会、罗盘或档案图片");
  set("/api/v1/inventory/fulfilment/sku-import/styles", "post", inventorySkuStyleLookupSchema, "导入SKU预览：按款号读取商品档案当前的供应商款式编码（只读），用于显示将更新的编码；未建档款号不返回；需库存查看权限");
  set("/api/v1/inventory/images/batch", "post", inventoryImageBatchSchema, "按款号批量导入库存图片，每次最多8张；逐张返回SAVED、NOT_FOUND或INVALID，部分失败不影响其余图片");
  set("/api/v1/inventory/images/{imageId}", "get", undefined, "读取已登记的库存上传图片；只提供本功能保存的图片");
  set("/api/v1/inventory/replenishment-policy", "get", undefined, "读取当前账号的计算配置及版本号");
  doc.paths["/api/v1/inventory/replenishment-policy"].get!.parameters = [];
  set("/api/v1/inventory/replenishment-policy", "post", replenishmentPolicyWriteSchema, "保存当前账号的计算配置；版本冲突返回409，不修改库存或创建采购单");
  set("/api/v1/inventory/calculation-policy", "get", undefined, "读取当前账号的在仓总库存公式及版本；未配置为null");
  doc.paths["/api/v1/inventory/calculation-policy"].get!.parameters = [];
  set("/api/v1/inventory/calculation-policy", "post", inventoryCalculationWriteSchema, "保存个人库存公式；支持六项聚水潭数量、数字和+-*/括号；版本冲突返回409，null停用。逐SKU计算后汇总，不修改原始库存");
  set("/api/v1/inventory/calculation-fields", "get", undefined, "读取自己创建或已公开的库存计算字段（含个人隐藏项）；不返回其他账号私有字段");
  doc.paths["/api/v1/inventory/calculation-fields"].get!.parameters = [];
  set("/api/v1/inventory/calculation-fields", "post", inventoryCalculationFieldWriteSchema, "新增或编辑计算字段；创建revision=0，更新携带id和revision。创建者及超级管理员可管理公开字段，私有字段仅本人可见。每人20项、公开共40项；版本冲突409");
  set("/api/v1/inventory/calculation-fields/delete", "post", inventoryCalculationFieldDeleteSchema, "删除可管理的计算字段；不删除原始库存；版本冲突409");
  set("/api/v1/inventory/calculation-fields/view", "post", inventoryCalculationFieldViewSchema, "保存个人显示/隐藏设置；仅影响当前账号。revision为viewRevision；隐藏列不参与本账号页面及导出");
  set(
    "/api/v1/inventory/adjustments",
    "post",
    z
      .object({
        skuId: id,
        warehouseId: id,
        quantity: z.number().int().min(-10000000).max(10000000),
        reason: z.enum(["OPENING", "STOCKTAKE", "MANUAL"]),
        remark: text,
      })
      .strict(),
  );
  set(
    "/api/v1/purchase-suggestions/generate",
    "post",
    z
      .object({
        skuIds: z.array(id).min(1).max(100),
        targetStockDays: positive.max(365),
        reopenReason: text.optional(),
      })
      .strict(),
  );
  set(
    "/api/v1/purchase-suggestions/{id}/accept",
    "post",
    z.object({ purchaseQty: positive, reason: text.optional() }).strict(),
  );
  set(
    "/api/v1/purchase-suggestions/{id}/ignore",
    "post",
    z.object({ reason: text, remark: text.optional() }).strict(),
  );
  const user = z.object({
    username: text,
    displayName: text,
    password: z.string().min(12).max(128),
    roleIds: z.array(id).min(1),
    status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
  });
  set("/api/v1/users", "post", user);
  set(
    "/api/v1/users/{id}",
    "patch",
    user.omit({ password: true }).partial({ username: true }),
  );
  set(
    "/api/v1/users/{id}/reset-password",
    "post",
    z.object({ newPassword: z.string().min(12).max(128) }),
  );
  const role = z.object({
    code: text,
    name: text,
    permissionCodes: z.array(text),
  });
  set("/api/v1/roles", "post", role);
  set("/api/v1/roles/{id}", "patch", role.partial({ code: true }));
  doc.info.description =
    "内部ERP v0.1。写请求需当前会话、CSRF及相应幂等键；权限仍在后端校验。魔方罗盘分析来自已导入的每日明细报表，不代表官方指标接口已启用。详细状态和字段见docs/API_SPEC.md。";
  const compass = "/api/v1/analytics/compass";
  set(
    "/api/v1/integrations/vip/compass/probe",
    "post",
    compassProbeRequestSchema,
    "请求单页只读罗盘取数验证；不更新经营分析报表",
  );
  set(
    "/api/v1/integrations/vip/listing/sync",
    "post",
    listingRequestSchema,
    "请求只读核对商品条码上下架状态；不操作平台上下架或ERP库存",
  );
  set(compass + "/imports", "post", beginSchema, "创建或继续罗盘报表导入");
  set(
    compass + "/imports/{id}/chunks",
    "post",
    chunkSchema,
    "分批上传每日明细",
  );
  set(
    compass + "/imports/{id}/finish",
    "post",
    z.object({}).strict(),
    "原子完成报表并更新分析来源",
  );
  set(
    compass + "/mail-settings",
    "post",
    settingsSchema,
    "安全保存每日邮件配置",
  );
  set(
    compass + "/mail-test",
    "post",
    z.object({}).strict(),
    "验证 SMTP 配置，不发信",
  );
  set(
    compass + "/send-daily",
    "post",
    z.object({}).strict(),
    "发送完整且最新的每日报告，同日收件人防重复",
  );
  set("/api/v1/my-workspace", "post", workspaceSaveSchema, "保存本人工作台、日程与待办，按版本检测冲突");
  set("/api/v1/my-workspace/appearance", "get", undefined, "读取本人全站主题偏好");
  set("/api/v1/my-workspace/appearance", "post", appearanceSchema, "按账号保存暗色或亮色主题，检测并发版本冲突");
  set("/api/v1/my-workspace/assistant", "post", assistantSendSchema, "发送消息，按权限查询业务数据并生成待确认日程、记忆或同步操作");
  set("/api/v1/my-workspace/assistant/memory", "get", undefined, "读取本人个人记忆，不调用模型");
  set("/api/v1/my-workspace/assistant/memory", "post", assistantMemorySaveSchema, "保存本人个人记忆，检查版本并发冲突");
  set("/api/v1/my-workspace/assistant/actions", "post", z.object({ id: z.string().uuid() }).strict(), "执行本人待确认同步卡片，复核当前权限并防止重复提交");
  set("/api/v1/my-workspace/assistant/clear", "post", z.object({ version: z.number().int().min(0) }).strict(), "清空本人助理对话，不修改工作台记录");
  const smart = "/api/v1/ai-model-management/smart";
  set(smart, "get", undefined, "读取智选模型四维评估、渠道屏蔽状态与算力中转站列表");
  set(smart + "/policy", "post", smartPolicySaveSchema, "保存智选模型四维权重、自动屏蔽门槛与人工干预");
  set(smart + "/stations", "post", relayStationSaveSchema, "新增或更新算力中转站连接（密钥加密保存）");
  set(smart + "/stations/{id}/sync", "post", z.object({}).strict(), "拉取并按聊天/图片/视频/音频/其他自动分类中转站模型渠道");
  set(smart + "/stations/{id}/probe", "post", relayProbeSchema, "显式测速验证中转站指定聊天模型");
  set(smart + "/stations/{id}/delete", "post", z.object({}).strict(), "删除指定算力中转站");
  set(smart + "/apply", "post", smartApplySchema, "按编排/执行/图像/视频/音频角色一键应用最优已验证模型到全站配置");
  const agentai = "/api/v1/ai-model-management/agentai";
  set(agentai, "get", undefined, "读取指定20型号、能力验证和账号私有价格，不调用模型");
  set(agentai, "post", agentaiSaveSchema, "加密保存AgentAI连接，更换连接使旧价格与验证失效");
  set(agentai + "/sync", "post", z.object({}).strict(), "认证同步指定模型和账号实际价格，不生成内容");
  set(agentai + "/prices", "post", z.object({}).strict(), "读取账号实付价，使用五分钟缓存与ETag，不撤销模型验证");
  set(agentai + "/test", "post", agentaiTestSchema, "单次验证指定聊天模型能力，产生实际API用量");
  const audio = agentai + "/audio";
  set(audio, "get", undefined, "读取本人语音制作任务和可用音色");
  set(audio + "/estimate", "post", agentAiAudioInputSchema, "按实际语音参数获取报价及备用渠道上界");
  set(audio + "/speech", "post", agentAiSpeechSchema, "确认报价后幂等创建语音任务，未知提交不重发");
  set(audio + "/voices/sync", "post", z.object({}).strict(), "核对本人在本站创建的克隆音色");
  set(audio + "/voices", "post", undefined, "上传本人已获授权的录音并创建海螺克隆音色");
  doc.paths[audio + "/voices"]!.post!.requestBody = {
    required: true,
    content: { "multipart/form-data": { schema: { type: "object", required: ["file", "name", "requestId", "consentAgreed", "consentStatementVersion"], properties: {
      file: { type: "string", format: "binary", description: "10至300秒MP3/M4A/WAV，最多20MiB" },
      name: { type: "string", minLength: 1, maxLength: 50 },
      requestId: { type: "string", format: "uuid" },
      previewText: { type: "string", maxLength: 300 },
      consentAgreed: { type: "string", enum: ["true"] },
      consentStatementVersion: { type: "string", enum: ["voice-v1"] },
    } } } },
  };
  set(audio + "/tasks/{id}/refresh", "post", z.object({}).strict(), "查询本人同一供应商任务，不重复生成");
  set(audio + "/tasks/{id}/result", "get", undefined, "按本人任务归属安全代理已完成音频");
  for (const methods of Object.entries(doc.paths).filter(([path]) => path.startsWith(agentai) || path.startsWith(smart)).map(([, methods]) => methods)) {
    for (const operation of Object.values(methods!)) {
      if (!operation || typeof operation !== "object" || !("parameters" in operation)) continue;
      const op = operation as any;
      op.parameters = op.parameters.filter((p: any) => !["page", "pageSize"].includes(p.name));
      const idParameter = op.parameters.find((p: any) => p.in === "path" && p.name === "id");
      if (idParameter) idParameter.schema = { type: "string", format: "uuid" };
    }
  }
  doc.paths[audio + "/tasks/{id}/result"]!.get!.responses = { 200: { description: "音频文件，仅本人可读", content: { "audio/mpeg": { schema: { type: "string", format: "binary" } }, "audio/wav": { schema: { type: "string", format: "binary" } } } } };
  void money;
  set(
    compass + "/ai-settings",
    "post",
    aiSettingsSchema,
    "加密保存指定 OpenRouter 模型的配置，密钥留空保留",
  );
  set(
    compass + "/ai-test",
    "post",
    z.object({}).strict(),
    "使用少量测试内容验证指定模型，会产生 API 费用",
  );
  set(
    compass + "/ai-generate",
    "post",
    z.object({}).strict(),
    "使用全量经营汇总生成并缓存 AI 日报，同数据防重复调用",
  );
  return doc;
}
