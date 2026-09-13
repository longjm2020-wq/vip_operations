# ARCHITECTURE · 架构规格

状态标识与范围解释见 [PROJECT_BRIEF.md](PROJECT_BRIEF.md)。下列目录、会话及实现细节是工程默认；技术栈和隔离原则为已确定。

## 1. 部署与依赖

```text
React / Ant Design 6
       │ HTTPS REST /api/v1
NestJS API ───────── PostgreSQL（业务事实源）
       │
Redis / BullMQ ───── Worker（同仓库、同领域模块）
                         │
                  integrations/vip
                  Client → Raw → Adapter → 领域服务
```

API、Worker 分进程部署不等于微服务；二者复用相同领域服务、数据库模型和迁移。第一阶段 Worker 只验收受控测试任务。内部采购过账不依赖队列、VOP、缓存或浏览器在线。

PostgreSQL 是库存、采购、审计事实源。Redis 用于队列、可选缓存和短期互斥，不能作为库存正确性的唯一保证；Redis 故障不应导致数据库内的正常入库失败。库存写入关键路径不访问外部 HTTP。

## 2. 工程目录

```text
apps/
  web/src/{pages,components,services,hooks,stores,types}
  api/src/
    modules/
      auth/ users/ roles/ products/ skus/ categories/ brands/
      suppliers/ warehouses/ inventory/
      purchase-suggestions/ purchase-orders/ receipts/ audit/ system/
      sales/ returns/ analytics/       # 后续实体/接口预留，不做假 CRUD
    integrations/vip/{auth,client,adapters,sync,webhooks}/
  worker/src/
packages/
  contracts/       # 稳定 DTO、错误码、领域接口；不导出 ORM/VOP 原始类型
  database/       # ORM schema、SQL migrations、seed、事务辅助
  config/         # 共享 lint/TypeScript 配置
docs/             # 本包九份规格和后续 DECISIONS.md
tests/{integration,e2e}/
compose.yaml
.env.example
```

包管理器工程默认 pnpm workspace。选择受支持的 Node 版本并固化版本文件和 packageManager 字段；各应用独立 build。检查已有仓库后再创建文件，保留现有用户修改。

## 3. 模块职责

| 模块 | 拥有内容 | 禁止 |
|---|---|---|
| auth/users/roles | 登录、会话、用户角色权限 | 仅靠前端隐藏按钮授权 |
| products/skus | SPU、SKU 和基础字典 | 要求创建商品时提供 VOP ID |
| inventory | 余额、库存事件、调整与查询 | 向其他模块开放任意改余额接口 |
| purchase-suggestions | 计算快照、接受/修改/忽略 | 自动视建议为正式 PO |
| purchase-orders | PO 状态、明细、有效在途 | 前端任意 PATCH status |
| receipts | 验收输入、幂等过账编排 | 单独提交库存更新后再写 PO |
| audit | 业务变更前后值与操作者 | 记录密码、令牌或允许修改日志 |
| integrations/vip | 原始记录、映射、第三方协议 | 让 VOP SDK/原始字段进入业务 DTO |

Controller 只做校验、身份/权限检查和 DTO 转换；Application Service 编排事务；Domain Service 执行计算、状态和数量约束；Repository 只做数据读写。不得从其他模块绕过领域服务修改库存。

跨采购/入库/库存/审计操作共用同一个数据库事务上下文。各模块不得在内部偷偷开启独立提交的事务。事务外通知如未来需要可靠投递，再引入事务 outbox；第一阶段不为不存在的需求扩展消息架构。

## 4. 入库并发及事务边界

1. 验证请求结构、会话和 `receipt.post` 权限。
2. 开启事务，处理持久化幂等记录，按固定顺序锁定 PO、Receipt、PO 明细、库存余额。所有相关取消/编辑命令遵守同一锁顺序。
3. 在锁内重新校验状态、数量、关联 SKU/PO/仓库和剩余量；已 POSTED 的相同 Receipt 返回原结果。
4. 对不存在的余额，使用唯一键安全创建后锁定；不得先查不存在再裸 INSERT。多个 SKU 按 warehouse_id、sku_id 排序锁定。
5. 更新 PO 累计量；调用 InventoryService，在同一事务更新余额、version 和流水。
6. 根据累计量计算 PO 状态，Receipt 标记 POSTED，写审计和幂等结果。
7. 提交成功才返回；任何异常全部回滚。死锁/序列化冲突采用有限重试，重试仍受幂等约束。

使用数据库行锁作为工程默认，version 用于客户端编辑冲突检查。仅 Redis 锁、仅按钮禁用、仅“先读状态再写”均不满足并发安全要求。具体协议见 [API_SPEC.md](API_SPEC.md)。

## 5. 登录与 RBAC 工程默认

采用同源部署及服务端会话：Cookie 仅携带不透明随机会话令牌，HttpOnly、生产环境 Secure、SameSite；数据库保存令牌哈希和到期时间，登出后作废。写请求使用 CSRF 防护并校验来源；Vite 开发环境代理 `/api`。会话寿命配置化。

密码使用成熟密码哈希库，不自行设计加密算法；登录失败统一错误，限制尝试频率。无公开注册。初始管理员通过一次性 seed 环境变量创建，不提交默认口令，不打印口令。角色变更和用户禁用在后续请求生效。

RBAC 为用户 → 角色 → 权限，多角色取权限并集，默认拒绝。API 每个命令明确权限。用户与角色管理防止删除/禁用最后一个可用管理员；审计管理操作。第一阶段不做组织级多租户、ABAC、SSO。

## 6. 前端数据规则

TanStack Query 管服务器数据、分页、缓存和失效；Zustand 仅存菜单折叠、列配置等 UI 偏好，不作为订单/库存事实源。表单为局部状态，筛选与分页可进入 URL。

入库/调整成功后统一刷新库存、流水、PO、Receipt 和相关建议视图；资金和库存不采用先行显示成功的乐观更新。403 显示无权限，409 刷新并提示重新核对；网络不确定时用原幂等键查证/重试，不能自动创建新单。

## 7. 配置、日志与开发运行

`.env.example` 至少列 DATABASE_URL、REDIS_URL、SESSION_TTL、APP_ORIGIN、业务时区配置和 `VIP_MODE=disabled`，仅占位无秘密。VOP 未启用时不要求密钥也可启动。

Compose 提供 PostgreSQL、Redis、持久卷、健康检查；API/Worker/Web 提供可重复构建方式。生产 API 不自动执行结构破坏操作；迁移作为明确部署步骤。服务启动前验证必要配置。

结构化日志带 requestId、actorId、业务单据 ID；敏感值脱敏。健康检查区分数据库不可用与队列不可用；不能把 disabled VOP 误报为故障。README 给出全新环境安装、迁移、seed、启动、测试、备份/恢复验证步骤。
