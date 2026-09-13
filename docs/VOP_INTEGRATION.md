# VOP_INTEGRATION · 唯品会隔离接入规格

## 1. 已确定边界

第一阶段不依赖真实VOP，不假设企业认证、自研应用、OAuth方式或API权限已经具备。VOP候选字段和方法在原对话中是设计示意，不构成官方文档。本包不声称核实了任何VOP接口。

核心模块不能导入VOP SDK、原始响应或字段类型；Product/SKU/Sales DTO不暴露vip_*。内部采购供应商不是自动的VOP账户归属。外部原始身份只在integration映射/溯源中持有。

```text
Scheduler/手动命令
  → SyncJob → Redis/BullMQ → Worker
  → VipClient（协议/鉴权/限流）
  → RawRecord（最小必要原始证据）
  → Adapter（校验、字段/状态转换）
  → 标准领域命令（幂等、事务）
  → 核心业务表
```

业务查询读本地库，不因打开页面实时拉VOP。平台库存与内部仓库库存是两种来源，不能直接覆盖余额或与订单扣减重复记账。

## 2. 第一阶段必须交付

1. `integrations/vip`独立模块和 Client/Adapter/Sync 的内部接口。
2. `VIP_MODE=disabled` 为默认；不提供密钥也能正常启动和完成采购入库。
3. DisabledClient明确返回 INTEGRATION_DISABLED，不能返回空列表冒充真实同步成功。
4. 测试fixture只表达内部适配协议，不称作真实VOP字段样本；严格放测试/开发数据源，生产启动拒绝fixture模式。
5. 标准 SalesMetricsProvider 为采购建议输入，UnavailableProvider为生产默认，FixtureProvider用于非生产验收。
6. 最小队列测试任务验证Worker启动/失败/重试基础机制；无真实定时同步、外呼、授权页面和Token表写入。

## 3. 内部端口示意（不是VOP官方协议）

```ts
type DataQuality = 'AVAILABLE' | 'UNAVAILABLE' | 'INCOMPLETE';
interface SalesMetricsProvider {
  getSkuMetrics(input: {
    skuId: string;
    from: string;
    to: string;
    timezone: string;
  }): Promise<{
    quality: DataQuality;
    sourceKind: 'FIXTURE' | 'STANDARD_SALES';
    dataAsOf: string | null;
    salesQty: number | null;
    reason?: string;
  }>;
}

type AdapterResult<T> =
  | { ok: true; value: T; sourceRef: string; adapterVersion: string }
  | { ok: false; code: string; sourceRef: string; retryable: boolean };

interface VipAdapter<TCommand> {
  // raw是未知值；先校验后映射，不使用any向领域层透传。
  adapt(raw: unknown, context: {
    connectionId: string;
    rawRecordId: string;
    mappingVersion: string;
  }): AdapterResult<TCommand>;
}
```

不得从这些内部字段推断VOP响应字段名。TCommand是平台无关的标准命令；sourceRef仅在集成层保存溯源关系。未识别状态、缺失必填、未映射SKU返回可观察异常，不静默当正常订单；映射失败不扣内部库存。

## 4. 必须等待证据的TODO

| ID | 待确认 | 所需证据 | 未确认时 |
|---|---|---|---|
| V01 | 企业认证、自研应用、账户归属及可用权限 | 实际应用后台能力及授权范围 | 所有真实能力关闭 |
| V02 | 鉴权是否OAuth、签名、令牌过期/刷新 | 当前官方鉴权文档及测试结果 | auth接口占位，不猜授权URL |
| V03 | 商品/SKU/订单/订单行/退货的外部身份与字段 | 对应版本文档、脱敏样例 | unknown输入，不猜id或时间字段 |
| V04 | 分页、增量游标、历史窗口、更新时间排序 | 官方查询规则、边界验证 | 不承诺可拉多久或无遗漏 |
| V05 | 频率、配额、并发、重试/退避 | 官方限流规则与应用实际额度 | 调度频率不写死 |
| V06 | 库存粒度/归属/锁定，JIT/JITX与扣库存时机 | 业务说明与权限证据 | 不回写平台、不直接改内部库存 |
| V07 | 取消、部分退货、退款、物流、档期状态 | 各能力字段、事件与状态定义 | 单独关闭不支持能力 |
| V08 | webhook验签、重放、数据保留、账户命名空间 | 官方回调与数据要求、业务需求 | 不开放可写回调端点 |

每项完成时在 `docs/vop-evidence/` 保存官方链接、获取日期/版本、权限截图文字说明或脱敏样例及契约测试。不能保存AppSecret、完整令牌或不必要个人信息。某项无权限时返回能力未启用，不拦其他模块。

## 5. Phase 3 同步能力预案

按PRODUCT/SKU/ORDER/CANCEL/RETURN/INVENTORY/LOGISTICS/CAMPAIGN分任务，不做syncEverything。能力表分别记录enabled、verifiedAt、documentVersion、lastSuccess/lastFailure；不存在“一个同步成功代表全站数据最新”。

流程：建任务记录→拉取分页→保存最小必要原始记录→逐记录适配→逐业务实体事务upsert→保存成功/失败统计。成功323条/失败3条需如实显示，失败记录独立重试，不把整批326条全部回滚。

游标只在可恢复进度已持久化后推进；失败记录需可重放，不可因为推进水位而永久漏掉。实际事件排序/修订版本依V04确定；旧事件不能覆盖新状态。Worker重启、重复投递是正常情况，业务幂等由数据库保证，BullMQ jobId/Redis锁只能减少重复工作。

去重键候选为 connection+entityType+外部实体身份，订单行需要稳定行身份，不能使用SKU代替。原对话 `UNIQUE(platform,platform_order_id)` 只适用于已证实全局唯一的命名空间；多账户时先核实再迁移。未知行身份不得凭索引位置猜。

Raw存档在业务转换之前完成；限制存储范围和保留周期，不无条件永久保存完整个人信息。适配失败保存脱敏错误、raw引用、adapterVersion；重新映射SKU后可重放失败记录且不重复入库/销售。

## 6. 凭据和前端

鉴权确认后，凭据加密保存或使用安全凭据引用，密钥与数据库分离；日志、API响应、错误和前端不能包含AppSecret/AccessToken/RefreshToken。前端只显示连接状态、权限缺口、最近同步和可用操作。

令牌过期、权限不足、限流、数据格式改变必须可观察；不得无限重试永久权限错误。真正的超时、退避和刷新策略由V02/V05文档决定，不在第一阶段虚构数值。

## 7. 接入验收门槛

- 已有对应能力文档和实际权限；无法验证则仍关闭。
- 契约测试用已脱敏真实样例覆盖正常、缺字段、未知状态、未映射SKU。
- 相同订单/行重复10次只产生一次实体，版本更新可正确合并；同SKU多订单行不丢失。
- Worker崩溃重启/重复投递不重复业务效果；部分失败有记录且可重放。
- 分页边界、水位、乱序和历史补数验证通过；凭据不会进入前端/日志。
- 内部采购入库在VOP不可用时仍正常；平台库存不会无依据覆盖内部余额。

每项能力单独验收、单独启用；不得因商品接口可用就假定订单/退货/物流同样可用。
