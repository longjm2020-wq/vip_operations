# DATABASE_SCHEMA · PostgreSQL v0.1 结构契约

本文件为迁移实现依据，不是已经执行的 SQL。必须生成、提交并实际验证 migration。领域定义见 [DATA_MODEL.md](DATA_MODEL.md)；新增工程字段用于并发、审计及幂等，不代表 VOP 官方字段。

## 1. 全局约定

- 数据库命名 snake_case；内部主键 `BIGINT GENERATED ALWAYS AS IDENTITY`，API 以十进制字符串返回，禁止 JS Number 传递大整数 ID。
- 金额 `NUMERIC(14,2)`，日均量 `NUMERIC(12,4)`；数量 INTEGER；时间 TIMESTAMPTZ，API ISO 8601；动态快照 JSONB。金额不得 float/double。
- 状态 `VARCHAR(32)` + 后端枚举 + 数据库 CHECK。字符串长度以字段表为准；业务单号 VARCHAR(50)。状态迁移在服务层验证。
- 下表“公共可变字段”指 `created_at,updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`；`created_by,updated_by BIGINT NULL REFERENCES users(id)`。应用每次写入更新 updated_at；不是自动更新承诺。
- 普通创建由服务端提供操作者，客户端不能指定 created_by。系统初始化可 NULL，运行时系统任务使用可追溯身份。
- 本文件未标 `?` 的字段均 NOT NULL；`?` 表示可空。所有外键建立显式约束，删除默认 RESTRICT，不级联删除业务历史。
- 可归档主数据允许 deleted_at?，编码唯一性对已归档记录仍保留，不复用旧业务编码。第一阶段 UI 用状态停用/归档而非物理删除。
- 字段长度、枚举、必填、Decimal 格式在 DTO 和数据库保持一致；不存在的关联、负数和非法状态必须在数据库或服务层被拒绝。

## 2. 身份与基础字典（Phase 1）

| 表 | 字段（除 id 外） | 约束/索引 |
|---|---|---|
| users | username VARCHAR(100), display_name VARCHAR(100), password_hash TEXT, status VARCHAR(32), 公共可变字段 | UNIQUE(username)，status ACTIVE/INACTIVE；用户名规范化后唯一 |
| roles | code VARCHAR(50), name VARCHAR(100), 公共可变字段 | UNIQUE(code) |
| permissions | code VARCHAR(100), name VARCHAR(100) | UNIQUE(code)，权限由 seed/code 管理 |
| user_roles | user_id BIGINT FK, role_id BIGINT FK | 联合主键(user_id,role_id)，无 identity id |
| role_permissions | role_id BIGINT FK, permission_id BIGINT FK | 联合主键(role_id,permission_id)，无 identity id |
| sessions | user_id BIGINT FK, token_hash VARCHAR(128), created_at TIMESTAMPTZ, expires_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ? | UNIQUE(token_hash)，INDEX(user_id), INDEX(expires_at) |
| categories | code VARCHAR(50), name VARCHAR(100), parent_id BIGINT? FK categories, status VARCHAR(32), 公共可变字段 | UNIQUE(code)，禁止自指和循环 |
| brands | code VARCHAR(50), name VARCHAR(100), status VARCHAR(32), 公共可变字段 | UNIQUE(code) |

user_roles/role_permissions 的修改与审计同事务。认证表不能通过通用序列化输出 password_hash/token_hash。会话过期清理不影响审计。

## 3. 商品、SKU、供应商和仓库（Phase 1）

### suppliers

`id`；`supplier_code VARCHAR(50)`；`name VARCHAR(255)`；`contact_name VARCHAR(100)?`；`phone VARCHAR(50)?`；`address TEXT?`；`default_lead_time_days INTEGER?`；`moq INTEGER?`；`status VARCHAR(32)`；公共可变字段；`deleted_at TIMESTAMPTZ?`。

UNIQUE(supplier_code)；交期非负；MOQ 若提供 >0；status ACTIVE/INACTIVE。MOQ 的适用颗粒度尚未确认，不增加强制采购数量约束。

### warehouses

`id`；`code VARCHAR(50)`；`name VARCHAR(100)`；`address TEXT?`；`status VARCHAR(32)`；公共可变字段。UNIQUE(code)，status ACTIVE/INACTIVE。

### products

`id`；`style_no VARCHAR(64)`；`name VARCHAR(255)`；`brand_id BIGINT? FK brands`；`category_id BIGINT FK categories`；`default_supplier_id BIGINT? FK suppliers`；`year SMALLINT?`；`season VARCHAR(32)?`；`tag_price NUMERIC(14,2)?`；`main_image_url TEXT?`；`status VARCHAR(32)`；`remark TEXT?`；公共可变字段；`deleted_at TIMESTAMPTZ?`。

UNIQUE(style_no)；INDEX(category_id), INDEX(default_supplier_id)；tag_price≥0（若有）；status ACTIVE/STOPPED/ARCHIVED。品类必填采用原页面要求。图片第一阶段保存 URL，不引入完整媒体系统。

### skus

`id`；`product_id BIGINT FK products`；`sku_code VARCHAR(100)`；`barcode VARCHAR(100)?`；`color_code VARCHAR(50)`；`color_name VARCHAR(100)`；`size_code VARCHAR(50)`；`size_name VARCHAR(100)`；`cost_price NUMERIC(14,2)?`；`status VARCHAR(32)`；公共可变字段；`deleted_at TIMESTAMPTZ?`。

UNIQUE(sku_code)；INDEX(product_id,color_code,size_code) 非唯一，INDEX(barcode) 非唯一；cost_price≥0；status ACTIVE/INACTIVE。B02 未定前不加色码唯一约束。

## 4. 库存（Phase 1）

### inventory_balances

`id`；`warehouse_id BIGINT FK warehouses`；`sku_id BIGINT FK skus`；`physical_qty INTEGER DEFAULT 0`；`reserved_qty INTEGER DEFAULT 0`；`damaged_qty INTEGER DEFAULT 0`；`version INTEGER DEFAULT 0`；`updated_at TIMESTAMPTZ DEFAULT now()`。

```sql
UNIQUE (warehouse_id, sku_id)
CHECK (physical_qty >= 0 AND reserved_qty >= 0 AND damaged_qty >= 0)
CHECK (reserved_qty + damaged_qty <= physical_qty)
CHECK (version >= 0)
```

另建 INDEX(sku_id)。available/in_transit 不落为可写字段。余额缺失查询按零投影，首次变更在事务内安全创建；非零余额必须有流水来源。

### inventory_adjustments（工程补全：可追溯来源单）

`id`；`adjustment_no VARCHAR(50)`；`warehouse_id BIGINT FK`；`sku_id BIGINT FK`；`quantity INTEGER`；`reason VARCHAR(50)`；`remark TEXT`；`operator_id BIGINT FK users`；`created_at TIMESTAMPTZ`。

UNIQUE(adjustment_no)，quantity≠0；reason OPENING/STOCKTAKE/MANUAL；remark 非空。调整创建即同事务过账，无可编辑草稿。禁止客户端传库存最终值。

### inventory_transactions

`id`；`warehouse_id BIGINT FK`；`sku_id BIGINT FK`；`transaction_type VARCHAR(50)`；`physical_delta INTEGER`；`reserved_delta INTEGER`；`damaged_delta INTEGER`；`before_physical,after_physical,before_reserved,after_reserved,before_damaged,after_damaged INTEGER`；`source_type VARCHAR(50)`；`source_id BIGINT`；`source_no VARCHAR(100)`；`receipt_item_id BIGINT? FK receipt_items`；`adjustment_id BIGINT? FK inventory_adjustments`；`occurred_at TIMESTAMPTZ`；`operator_id BIGINT FK users`；`remark TEXT?`；`created_at TIMESTAMPTZ`。

工程补全三个分量，替代原示意 qty_delta/before_qty/after_qty 的单值歧义。若保留兼容字段 qty_delta，必须是 physical_delta 的只读派生值，不形成两个真值。

约束：after_x=before_x+delta_x；before/after均符合余额非负与可售约束；三种 delta 至少一个非零。第一阶段 PURCHASE_RECEIPT 必须 receipt_item_id 非空、adjustment_id为空，STOCK_ADJUSTMENT/STOCKTAKE 相反；正向采购入库 physical_delta>0、其余delta=0。service校验 source_id/source_type 与显式FK一致。

UNIQUE(receipt_item_id)（PG允许多条NULL）；UNIQUE(adjustment_id)。这两个约束保证每个来源最多一次库存效果，不依赖 HTTP 幂等键。INDEX(warehouse_id,sku_id,occurred_at,id)，INDEX(source_type,source_id)。事务服务是唯一写入口，应用不提供流水 update/delete。

## 5. 采购建议（Phase 1）

### purchase_suggestions

`id`；`sku_id BIGINT FK skus`；`supplier_id BIGINT? FK suppliers`；`generated_at TIMESTAMPTZ`；`available_qty_snapshot INTEGER`；`in_transit_qty_snapshot INTEGER`；`sales_7d_snapshot INTEGER`；`sales_30d_snapshot INTEGER?`；`avg_daily_sales NUMERIC(12,4)`；`target_stock_days INTEGER`；`suggested_qty INTEGER`；`risk_level VARCHAR(32)?`；`status VARCHAR(32)`；`actual_purchase_qty INTEGER?`；`decision_reason TEXT?`；`ignored_reason VARCHAR(100)?`；`ignored_remark TEXT?`；`source_kind VARCHAR(32)`；`algorithm_version VARCHAR(50)`；`input_snapshot JSONB`；公共可变字段。

input_snapshot 保存指标窗口、dataAsOf、完整性、时区、交期/参数及来源标识，不能放原始VOP对象。source_kind 为 FIXTURE 或后续 STANDARD_SALES，生产配置禁止 FIXTURE。UNAVAILABLE 不创建有效建议，返回结构化跳过原因。

状态 PENDING/ACCEPTED/MODIFIED/IGNORED/CONVERTED；所有数量≥0，target_stock_days>0。ACCEPTED/MODIFIED/CONVERTED 要求 actual_purchase_qty>0；IGNORED 要求 ignored_reason。

INDEX(status,generated_at)，INDEX(sku_id,generated_at)，INDEX(supplier_id)。工程默认部分唯一索引 `(sku_id) WHERE status IN ('PENDING','ACCEPTED','MODIFIED')`，并发生成只保留一个活动建议。忽略后显式重建须提供原因，逻辑在服务层审计。

## 6. PO 与入库（Phase 1）

### purchase_orders

`id`；`po_no VARCHAR(50)`；`supplier_id BIGINT FK suppliers`；`warehouse_id BIGINT FK warehouses`（工程补全）；`buyer_id BIGINT FK users`；`ordered_at TIMESTAMPTZ?`；`expected_delivery_at TIMESTAMPTZ?`；`status VARCHAR(32)`；`total_qty INTEGER DEFAULT 0`；`total_amount NUMERIC(14,2) DEFAULT 0`；`version INTEGER DEFAULT 0`；`remark TEXT?`；公共可变字段。

UNIQUE(po_no)；INDEX(status,expected_delivery_at)，INDEX(supplier_id,created_at)，INDEX(warehouse_id,status)。金额/总量非负，由服务端汇总；version 用于编辑冲突。状态字典保留 DRAFT/PENDING_CONFIRMATION/CONFIRMED/IN_PRODUCTION/SHIPPED/PARTIALLY_RECEIVED/COMPLETED/CANCELLED，第一阶段不生成中间生产/发货状态。

### purchase_order_items

`id`；`purchase_order_id BIGINT FK purchase_orders`；`sku_id BIGINT FK skus`；`purchase_suggestion_id BIGINT? FK purchase_suggestions`；`ordered_qty INTEGER`；`unit_cost NUMERIC(14,2)`；`received_qty INTEGER DEFAULT 0`；`cancelled_qty INTEGER DEFAULT 0`；公共可变字段。

UNIQUE(purchase_suggestion_id) 防重复转单；INDEX(purchase_order_id)，INDEX(sku_id)。CHECK ordered_qty>0，unit_cost≥0，received_qty≥0，cancelled_qty≥0，received_qty+cancelled_qty≤ordered_qty。允许同 PO 相同 SKU 不同来源明细，收货必须按 POItem ID，不仅按 SKU。

### receipts

`id`；`receipt_no VARCHAR(50)`；`purchase_order_id BIGINT FK purchase_orders`；`warehouse_id BIGINT FK warehouses`；`received_at TIMESTAMPTZ?`；`posted_at TIMESTAMPTZ?`；`status VARCHAR(32)`；`operator_id BIGINT FK users`；`version INTEGER DEFAULT 0`；`remark TEXT?`；公共可变字段。

UNIQUE(receipt_no)；INDEX(purchase_order_id,status)，INDEX(status,created_at)。status DRAFT/RECEIVED/POSTED/CANCELLED；POSTED 要求 posted_at 非空；仓库一致性在事务中验证。received_at 在 mark-received 必填，时间由用户填写实际到货时间，posted_at 由服务器产生。

### receipt_items

`id`；`receipt_id BIGINT FK receipts`；`purchase_order_item_id BIGINT FK purchase_order_items`；`sku_id BIGINT FK skus`；`received_qty INTEGER`；`qualified_qty INTEGER DEFAULT 0`；`damaged_qty INTEGER DEFAULT 0`；`shortage_qty INTEGER DEFAULT 0`；公共可变字段。

UNIQUE(receipt_id,purchase_order_item_id)；INDEX(purchase_order_item_id)。数量≥0，qualified_qty≤received_qty，damaged_qty≤received_qty。B01未定不添加错误的“到货=合格+次品+少货”CHECK；正常过账强制 DATA_MODEL 中严格等式。草稿至少一条明细，过账每条 received=qualified>0。

跨表一致性：ReceiptItem 的 POItem 必须属于 Receipt 的 PO；SKU 必须匹配 POItem。可通过复合外键补强，或在锁内服务校验并做集成测试；不能只信前端。PO确认、取消、过账均锁同一PO行以串行判断剩余量。

## 7. 审计与幂等（Phase 1）

### audit_logs

`id`；`actor_id BIGINT? FK users`；`actor_label VARCHAR(100)`；`action VARCHAR(100)`；`entity_type VARCHAR(100)`；`entity_id BIGINT?`；`request_id VARCHAR(100)`；`before_data JSONB?`；`after_data JSONB?`；`reason TEXT?`；`occurred_at TIMESTAMPTZ`。

INDEX(entity_type,entity_id,occurred_at,id)，INDEX(actor_id,occurred_at)，INDEX(request_id)。快照脱敏；操作者名称快照保留历史可读性。日志不可变，普通角色无删除权限。

### idempotency_records（工程补全）

`id`；`actor_id BIGINT FK users`；`operation VARCHAR(150)`；`idempotency_key VARCHAR(128)`；`request_hash VARCHAR(128)`；`resource_type VARCHAR(100)?`；`resource_id BIGINT?`；`response_status INTEGER`；`response_body JSONB`；`created_at TIMESTAMPTZ`。

UNIQUE(actor_id,operation,idempotency_key)。operation 包含命令与目标资源 ID。请求 hash 由服务端规范化有效请求体计算，忽略 requestId 等传输噪声，不忽略业务字段。成功结果与业务事务同提交，失败回滚不留成功记录；并发唯一冲突等待原事务结束后读取比对结果。

第一阶段不自动清理此表。未来清理前必须保留单据级唯一和创建请求去重方案，不能因为记录过期而允许同一次入库创建新单。读取重放结果仍需校验当前用户权限。

## 8. Phase 2 结构预案（不要求 Phase 1 迁移）

| 表 | 标准字段 | 去重与未决项 |
|---|---|---|
| sales_orders | id, source, source_order_key, ordered_at?, order_status, shipping_status?, return_status?, goods_amount?, discount_amount?, payment_amount?, 公共时间 | UNIQUE(source,source_order_key)；真实多账户去重空间 Phase 3再定 |
| sales_order_items | id, order_id FK, source_line_key, sku_id? FK, quantity, unit_price?, sale_amount?, discount_amount?, item_status | UNIQUE(order_id,source_line_key)；不得用sku_id当订单行唯一键 |
| returns | id, source, source_return_key, sales_order_id? FK, return_status, requested_at?, completed_at?, refund_amount?, reason_code?, reason_text? | UNIQUE(source,source_return_key) |
| return_items | id, return_id FK, source_line_key, sales_order_item_id? FK, sku_id? FK, return_qty, refund_amount?, warehouse_received_qty DEFAULT 0 | UNIQUE(return_id,source_line_key)；退货与入库分别处理 |

上述ID/FK为BIGINT，金额NUMERIC(14,2)，数量INTEGER，时间TIMESTAMPTZ；source VARCHAR(32)，source keys VARCHAR(128)，状态 VARCHAR(50)。字段空值表示未知，不能默认补0。原对话 platform_order_id 等概念在核心改称通用 source key；真实平台 ID、原始状态及 raw_record_id 的关联放 integration 映射/溯源表，避免反向依赖。此为隔离原则下的工程规范化，不是声称 VOP 有该字段。

正式启用前补齐订单行幂等、取消/退货/净销量及来源命名空间；不能以这张预案表为借口提前实现销售库存联动。

## 9. Phase 3 集成表（仅预案）

`vip_connections`（账户、加密凭据引用、状态、授权/同步时间）；`vip_sku_mappings`（connection、内部sku、已验证外部身份、映射版本）；`vip_raw_records`（api_name、business_type、external_id、payload JSONB、处理状态及时间、脱敏错误）；`sync_jobs`（任务类型、范围、模式、状态、fetched/success/failed、起止时间、失败摘要）；外部订单/行到核心实体的映射与溯源表。

原对话举例的 vip_goods_id、vip_sku_id、campaign_id 等是候选平台概念，不作为已确认官方字段执行迁移。唯一键必须基于实际账户/实体/版本语义核定。JSONB不默认建立全量GIN索引；具体查询需要时再加。详见 [VOP_INTEGRATION.md](VOP_INTEGRATION.md)。

## 10. 迁移与数据验收

依赖顺序：用户/权限 → 字典/供应商/仓库 → Product/SKU → 库存余额/调整 → 建议 → PO/明细 → Receipt/明细 → 流水 → 审计/幂等。跨表引用循环可分两次迁移补约束。

全新测试库执行全量迁移；从上一阶段 schema 和有数据的样例升级；验证唯一键、CHECK、FK真实存在，而非只看 ORM 模型。不得用开发 schema push 替代 migration。seed 必须可重跑，管理员密码来自环境；演示业务数据仅开发/测试，通过领域服务产生库存流水。不得对用户现有库执行 reset/drop。
