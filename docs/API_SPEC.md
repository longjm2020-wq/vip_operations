# API_SPEC · REST v1 契约

API 前缀已确定为 `/api/v1`。下述补充路径、DTO、错误码与幂等协议为工程默认，须形成 NestJS OpenAPI 并用于前后端一致性检查。此文为规格，不是现成运行接口。

## 1. 通用协议

JSON camelCase；ID 为字符串；金额十进制字符串（如 `"78.00"`），数量整数，时间ISO 8601含时区。拒绝未知写字段，所有列表 page≥1、pageSize默认20且≤100、排序字段白名单，稳定追加id排序；筛选在服务器执行。

成功单项 `{ "data": {...}, "requestId": "..." }`；列表 `{ "data": [], "page":1, "pageSize":20, "total":0, "requestId":"..." }`。创建201，查询/命令成功200，无内容退出204。

错误示例：

```json
{"error":{"code":"RECEIPT_EXCEEDS_REMAINING","message":"入库数量超过采购剩余量","details":{"poItemId":"9001","remainingQty":60}},"requestId":"req-123"}
```

400 VALIDATION_ERROR；401 UNAUTHENTICATED；403 FORBIDDEN；404 NOT_FOUND；409 INVALID_STATE / VERSION_CONFLICT / IDEMPOTENCY_CONFLICT / RECEIPT_EXCEEDS_REMAINING / DUPLICATE_CODE；422 INSUFFICIENT_AVAILABLE / BUSINESS_RULE_PENDING / SALES_DATA_UNAVAILABLE；503 DATA_SOURCE_UNAVAILABLE / INTEGRATION_DISABLED。错误不输出数据库语句、堆栈或秘密。

所有写操作经会话、CSRF和权限校验。库存和状态写入只能通过命令；`PATCH status` 不允许用于 PO/Receipt。只读 API 不能产生业务副作用。

## 2. 登录与系统管理

| 方法/路径 | 输入/输出重点 | 权限 |
|---|---|---|
| POST /auth/login | username,password；Set-Cookie；返回用户、权限与CSRF token | 公共，限流 |
| POST /auth/logout | 撤销会话并清Cookie | 已登录 |
| GET /auth/me | 用户、角色、权限、可用CSRF token | 已登录 |
| GET /users；POST /users | 列表；username,displayName,password,roleIds | user.read / user.manage |
| PATCH /users/:id | displayName,status,roleIds；不回传密码 | user.manage |
| POST /users/:id/reset-password | newPassword，撤销目标会话 | user.manage |
| GET /roles；POST /roles | 列表；code,name,permissionCodes | role.read / role.manage |
| PATCH /roles/:id | name,permissionCodes | role.manage |
| GET /permissions | 已定义权限目录 | role.read |
| GET /health | 最小存活状态，无配置泄露 | 公共 |

角色/用户更改审计，不允许删除最后一个可用管理员。初始管理员由开发环境 seed 建立，无公开注册接口。

## 3. 主数据

| 方法/路径 | 用途 | 权限 |
|---|---|---|
| GET /products；GET /products/:id | 分页/详情 | product.read |
| POST /products | styleNo,name,categoryId 必填；其余见字段表 | product.create |
| PATCH /products/:id | 可编辑主档字段、状态；不可修改id | product.update |
| GET /products/:id/skus；GET /skus；GET /skus/:id | SKU查询 | product.read |
| POST /products/:id/skus | skuCode,colorCode,colorName,sizeCode,sizeName；barcode,costPrice可选 | product.create |
| PATCH /skus/:id | SKU信息/状态；禁止换productId | product.update |
| GET /suppliers；GET /suppliers/:id | 供应商查询 | supplier.read |
| POST /suppliers；PATCH /suppliers/:id | supplierCode,name；联系人/交期/MOQ等可选 | supplier.manage |
| GET /warehouses；GET /warehouses/:id | 仓库查询 | warehouse.read |
| POST /warehouses；PATCH /warehouses/:id | code,name,address,status | warehouse.manage |
| GET /categories；GET /brands | 字典查询 | product.read |
| POST /categories；PATCH /categories/:id | code,name,parentId?,status | product.update |
| POST /brands；PATCH /brands/:id | code,name,status | product.update |

Product筛选 q（款号/名称）、categoryId、brandId、supplierId、year、season、status；SKU加 productId、barcode、colorCode、sizeCode。主数据编码重复返回409；停用/归档不物理删除，不破坏历史引用。

## 4. 库存

| 方法/路径 | 契约 | 权限 |
|---|---|---|
| GET /inventory | q,warehouseId?,supplierId?,categoryId?,colorCode?,sizeCode?；默认按仓+SKU行返回 | inventory.read |
| GET /inventory/:skuId | warehouseId?；返回分仓balances与全仓totals，含physical/reserved/damaged/available/inTransit | inventory.read |
| GET /inventory/:skuId/transactions | warehouseId?,type?,dateFrom?,dateTo?；分页流水 | inventory.read |
| POST /inventory/adjustments | skuId,warehouseId,quantity,reason,remark；Idempotency-Key必填 | inventory.adjust |
| GET /inventory/adjustments/:id | 调整单与关联流水 | inventory.read |

库存调整示例：

```json
{"skuId":"50001","warehouseId":"1","quantity":-2,"reason":"STOCKTAKE","remark":"盘点差异，减少2件"}
```

quantity 是 physical 的变化量，非最终数量，必须非零整数。调整后不能低于 reserved+damaged。返回 adjustmentId、transactionId、变更后balance及version。不提供 PATCH /inventory/:id，不接受 availableQty/inTransitQty/reservedQty 等客户端覆盖值。

## 5. 采购建议

| 方法/路径 | 输入/效果 | 权限 |
|---|---|---|
| GET /purchase-suggestions；GET /purchase-suggestions/:id | SKU、供应商、状态、时间筛选；完整快照与当前值分开 | purchase.read |
| POST /purchase-suggestions/generate | skuIds（1–100）,targetStockDays,reopenReason?；幂等 | purchase.suggest |
| POST /purchase-suggestions/:id/accept | purchaseQty>0,reason?；按量是否改变进入 ACCEPTED/MODIFIED | purchase.suggest |
| POST /purchase-suggestions/:id/ignore | reason,remark?；OTHER需备注 | purchase.suggest |

生成返回 `{generatedIds, existingSuggestionIds, skipped:[{skuId,code,message}]}`。无销量的SKU返回 SALES_DATA_UNAVAILABLE，不落虚假零建议；FIXTURE仅非生产环境。

第一阶段采用单事务覆盖最多100个SKU，生成结果与幂等记录一起提交：业务校验不通过的SKU可以跳过，结果明确报告；数据库等基础设施异常则整批回滚，不返回部分已提交。按skuId排序锁定SKU行，活动建议唯一索引补强并发安全。不得调用外部HTTP获取销量后长时间占用事务，先从数据源取得带时间戳的指标，再在事务内读取库存和落快照。真实大批量后台任务留后续。

## 6. 采购单

| 方法/路径 | 输入/效果 | 权限 |
|---|---|---|
| GET /purchase-orders；GET /purchase-orders/:id | supplierId,warehouseId,status,dateFrom,dateTo；返回items与totals | purchase.read |
| POST /purchase-orders | supplierId,warehouseId,expectedDeliveryAt?,remark?,items；创建DRAFT | purchase.create |
| PATCH /purchase-orders/:id | expectedVersion,可编辑头/明细；仅DRAFT | purchase.update |
| POST /purchase-orders/:id/submit | expectedVersion；DRAFT→PENDING_CONFIRMATION | purchase.submit |
| POST /purchase-orders/:id/confirm | expectedVersion；待确认→CONFIRMED | purchase.confirm |
| POST /purchase-orders/:id/cancel | expectedVersion,reason；符合DATA_MODEL取消条件 | purchase.cancel |

创建示例：

```json
{"supplierId":"201","warehouseId":"1","items":[{"skuId":"50001","orderedQty":150,"unitCost":"78.00","purchaseSuggestionId":"301"}],"remark":"按建议调整采购数量"}
```

purchaseSuggestionId 可省略，表示手工PO。携带建议时要求已 ACCEPTED/MODIFIED、SKU/供应商匹配、orderedQty=actualPurchaseQty；同事务置 CONVERTED，返回原建议关联。跨供应商分开创建，不自动拆单。不存在单独的采购计划接口。

items至少1条；orderedQty正整数；unitCost非负两位小数；所有关联服务端验证。buyer取当前用户，客户端不可指定状态、receivedQty/cancelledQty/totals。总额由服务端Decimal计算。PATCH携带现有itemId，新增行不带id，删除仅草稿且不破坏建议关联；带建议行不可直接删除/改量，需先在后续明确的撤销转换流程处理，第一阶段拒绝。

## 7. 入库

| 方法/路径 | 输入/效果 | 权限 |
|---|---|---|
| GET /receipts；GET /receipts/:id | purchaseOrderId,status,warehouseId；返回明细/状态 | receipt.read |
| POST /receipts | purchaseOrderId,warehouseId,items,remark?；创建DRAFT | receipt.create |
| PATCH /receipts/:id | expectedVersion,items,remark?；DRAFT/RECEIVED可修订验收数据 | receipt.update |
| POST /receipts/:id/mark-received | expectedVersion,receivedAt；DRAFT→RECEIVED，无库存效果 | receipt.update |
| POST /receipts/:id/post | expectedVersion；事务过账 | receipt.post |
| POST /receipts/:id/cancel | expectedVersion,reason；仅未POSTED | receipt.update |

items每行 `{purchaseOrderItemId,receivedQty,qualifiedQty,damagedQty,shortageQty}`，SKU由后端根据POItem推导。保存异常数据不意味着允许过账；B01未解决时非正常验收数量返回422 BUSINESS_RULE_PENDING。剩余量为服务端权威，过账时再次锁内检查。返回Receipt、PO最新状态及关联transactionIds。

## 8. 幂等、并发和重试

所有创建和业务命令POST（排除login/logout）要求 `Idempotency-Key`；前端每个逻辑动作产生一次键，双击和网络重试沿用。普通主数据PATCH可按最终值幂等；PO/Receipt PATCH要求expectedVersion，冲突返回409。

唯一域 actor+operation（含资源ID）+key，规范化请求hash及成功响应在业务事务里持久化。相同键相同体返回原状态码/结果；不同体409。相同Receipt换键重试仍由POSTED状态及receipt_item唯一流水阻止二次效果。

POSTED检查优先于旧expectedVersion冲突判断：已成功过账的同Receipt重试应返回原过账结果，不能先因版本变更误报失败；但复用原键改请求体仍409。每次请求先验证当前权限，不用历史结果绕过权限撤销。

创建Receipt请求若超时，前端沿用原键重新POST取回同一receiptId，再进行后续命令；不能创建第二张相似单。两个不同Receipt并发争同PO剩余量用DB锁和数量CHECK防超收。若客户端换键创建两张新单，系统无法自动认定它们是同次到货，UI必须展示单号与重复风险，后续可加外部送货凭证业务唯一键，不能虚构其存在。

## 9. 审计、默认角色和后续API

GET `/audit-logs`：actorId、entityType、entityId、action、dateFrom、dateTo分页筛选，需 audit.read；返回脱敏前后值、requestId。无修改/删除接口。

| 初始角色 | 权限集合（工程默认） |
|---|---|
| 管理员 | 所有已定义权限 |
| 商品运营 | product.read/create/update, supplier.read, warehouse.read, inventory.read |
| 采购员 | product.read, supplier.read, warehouse.read, inventory.read, purchase.read/suggest/create/update/submit, receipt.read |
| 采购经理 | 采购员权限 + purchase.confirm/cancel, supplier.manage |
| 库存人员 | product.read, warehouse.read, inventory.read/adjust, purchase.read, receipt.read/create/update/post |
| 数据分析 | product.read, inventory.read, purchase.read, receipt.read；后续增加sales.read/analytics.read |

单据展示关联主数据名称使用本接口允许的投影，不能因无商品编辑权限而打不开收货页。权限设置页面仅管理员访问；财务角色以后再加。

Phase 2 预留 GET `/sales/orders`、`/sales/orders/:id`、`/sales/sku-performance`、`/returns`，权限sales.read；正式DTO在销售口径确认后补齐。Phase 1不返回假业务数据。

Phase 1 GET `/integrations/vip/status` 仅返回 mode=disabled、capabilities=[]、reason=NOT_CONFIGURED，需vip.settings（仅管理员）。真实授权、同步、回调接口Phase 3确认后实现，不从本文猜路径和字段。
