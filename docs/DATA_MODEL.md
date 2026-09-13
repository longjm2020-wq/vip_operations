# DATA_MODEL · 领域与业务不变量

## 1. 实体关系

```text
Product(SPU) 1 ── N SKU
Supplier 1 ── N PurchaseOrder 1 ── N PurchaseOrderItem ── 1 SKU
SKU 1 ── N PurchaseSuggestion ── 0..1 PurchaseOrderItem
PurchaseOrder 1 ── N Receipt 1 ── N ReceiptItem ── 1 PurchaseOrderItem
Warehouse 1 ── N InventoryBalance ── 1 SKU
ReceiptItem 1 ── 0..1 PURCHASE_RECEIPT InventoryTransaction
SKU 1 ── N InventoryTransaction
SalesOrder 1 ── N SalesOrderItem ── 0..1 SKU      [Phase 2]
Return 1 ── N ReturnItem ── 0..1 SalesOrderItem   [Phase 2]
```

SKU 可关联多个平台映射记录，不预设内部 SKU 与 VOP 记录一对一。内部 ID 与外部 ID 永远分离。API 数字 ID 用字符串序列化。

## 2. 主数据

Product 保存款号、名称、品类、品牌、年份/季节、吊牌价、默认供应商、图片和状态。SKU 保存内部编码、条码、颜色和尺码、成本、状态。平台售价、平台状态、档期不进入 Product/SKU。

Product 状态 ACTIVE / STOPPED / ARCHIVED；SKU、供应商、仓库工程默认 ACTIVE / INACTIVE。停用阻止新增关联单据，不破坏历史查询。已确认 PO 的收货可引用停用 SKU；仓库停用前必须处理活动收货单及库存，第一阶段拒绝存在非零余额或活动单据的仓库停用。

款号、SKU 编码、供应商编码、仓库编码唯一。B02 未定前不增加强制色码组合唯一约束，不实现批次实体；新增重复组合给用户提示。

## 3. 库存口径

采用对话后期数据库口径：`available_qty = physical_qty - reserved_qty - damaged_qty`。reserved 与 damaged 是 physical 中互不重叠的不可售部分。必须满足各分量非负、reserved + damaged ≤ physical。可售数查询时计算，不能直接修改。

对话早期“实际减锁定”的简化示例没有次品项，统一以后期公式为准。Receipt 中发现的次品并不自动写入 inventory_balances.damaged_qty；原方案明确只有 qualified_qty 增加库存。异常次品在库内如何管理属于 B01，不得双重减可售。

有效在途 = 有效 PO 明细的 `ordered_qty - received_qty - cancelled_qty` 之和。仅 CONFIRMED、IN_PRODUCTION、SHIPPED、PARTIALLY_RECEIVED 计入；第一阶段不启用生产/发货状态命令。在途是已确认未结清采购，不代表已经上路。

工程默认 PO 增加一个目标 warehouse_id，用于分仓在途与收货一致性，确认后不允许变更；一张 PO 只收至该仓，跨仓拆 PO。采购建议第一阶段全仓 SKU 汇总，避免未明确销售分仓时重复建议。

任何余额改变必须有库存事件与流水。对话中 qty_delta 一列不足以解释未来锁定/损坏变化，工程补全为 physical/reserved/damaged 三个 delta 及 before/after。qty_delta 在第一阶段如保留，严格等于 physical_delta，UI 不将其当可售变化。未来 SALE_RESERVE 增加 reserved，不减少 physical；真实扣减时机待 Phase 2 确认。

第一阶段启用 PURCHASE_RECEIPT、STOCK_ADJUSTMENT、STOCKTAKE。其他销售、退货、损坏类型仅保留命名，不开放未确认写路径。期初库存也以调整事件入账。历史流水不可变，未来纠错用新反向事件，不篡改旧流水。

## 4. 采购建议

PurchaseSuggestion 是某时点数据与算法的快照，不是采购承诺。保存 SKU、推荐供应商、生成时间、销量窗口及来源、可售/在途、日均量、目标天数、算法版本、建议量、实际确认量和忽略原因。

基础公式已确定：

```text
avg_daily_sales = sales_7d / 7
stock_coverage_days = available_qty / avg_daily_sales
suggested_qty = max(0, ceil(target_stock_days * avg_daily_sales
                           - available_qty - in_transit_qty))
```

取整向上、负值截零为工程默认；Decimal 计算后只在最终件数取整。21 天是示例，不是生产默认业务参数；生成时明确传入 targetStockDays。7日窗口工程默认取配置业务时区的最近7个完整自然日，半开区间 [from,to)，快照保存起止时间；真实使用前落实 B04。

数据质量必须区分 AVAILABLE / UNAVAILABLE / INCOMPLETE。无数据或窗口不完整则不生成可采购建议并返回原因；已知7日销量0则 avg=0、coverage=null、建议0，显示“无近期销量”，不推断无限安全库存。无销量不自动判积压。

基础风险示例有未覆盖区间45–90天，且交期规则未统一。第一阶段 `risk_level` 可空，展示实际覆盖天数、交期和在途，不编造完整等级。Phase 2 配置连续互斥的阈值再启用风险筛选。MOQ 只提示；算法不擅自按供应商MOQ对每 SKU 取整。

状态命令：

| 当前 | 命令 | 目标 | 规则 |
|---|---|---|---|
| PENDING | accept | ACCEPTED | 实际量等于建议量且 >0 |
| PENDING | accept | MODIFIED | 实际量不同且 >0，要求原因 |
| PENDING | ignore | IGNORED | 原因必填，OTHER须备注 |
| ACCEPTED/MODIFIED | 转 PO | CONVERTED | 同事务建草稿 PO 明细并关联 |

第一阶段一个建议至多转一条 PO 明细，不自动合单或拆供应商；转单必须明确供应商、目标仓库、采购单价。重复转单返回原单或冲突，绝不能再次创建。转单前重新展示当前库存，原快照不被覆盖。取消 PO 后建议仍 CONVERTED，需显式生成新建议，不能偷偷重开。

生成不定时自动运行；同 SKU 有未处理/已接受/已修改建议时返回 existingSuggestionId。已忽略建议不会自动每日重弹；用户显式再次生成需携带重新生成原因并审计。相同幂等键重复生成返回原记录。

## 5. 采购订单

一 PO 一个供应商、一个目标仓库，多条 SKU 明细。数量为正整数，单价非负十进制；明细 received/cancelled 非负且总和不超过 ordered。金额由服务端按明细计算，客户端 totals 不可信。工程默认币种 CNY，不含税务/付款流程。

| 状态 | 可执行命令 | 后继 |
|---|---|---|
| DRAFT | 编辑/submit/cancel | PENDING_CONFIRMATION / CANCELLED |
| PENDING_CONFIRMATION | confirm/cancel | CONFIRMED / CANCELLED |
| CONFIRMED | 正常入库/cancel | PARTIALLY_RECEIVED / COMPLETED / CANCELLED |
| PARTIALLY_RECEIVED | 正常入库 | PARTIALLY_RECEIVED / COMPLETED |
| COMPLETED/CANCELLED | 查询 | 无 |

确认前不计在途。第一阶段只允许 DRAFT 编辑，提交后修改走后续明确流程，不能偷偷改回草稿。CONFIRMED 整单取消只在累计入库0、无 DRAFT/RECEIVED 活动入库单时允许；cancelled_qty 原子设为全部未收量。已有入库或部分取消属于 B06，暂拒绝。完成状态只由后台数量推导，不能手工 PATCH。

## 6. 到货、验收与过账

一张 PO 可以有多张 Receipt，每张 Receipt 的所有明细必须来自该 PO，SKU 必须与 PO 明细一致，仓库必须与 PO 目标仓一致。

状态 DRAFT / RECEIVED / POSTED / CANCELLED。工程默认 DRAFT 可编辑或取消；mark-received 确认到货得到 RECEIVED，仍可修订验收数量；post 从 RECEIVED 进入 POSTED；已过账不可编辑或取消。RECEIVED 阶段不改库存也不结清 PO，UI 明确标注“待过账”。

ReceiptItem 字段保存 received_qty、qualified_qty、damaged_qty、shortage_qty。原对话有“收到数量包含少货”与“不包含少货”的不同示例，未收口。**B01 解决前第一阶段只支持 received_qty = qualified_qty > 0 且 damaged_qty = shortage_qty = 0 的正常过账**。异常数量可保存草稿供核对，过账统一报 BUSINESS_RULE_PENDING，不能悄悄丢弃次品或少货。

正常过账：POItem.received_qty += qualified_qty；physical += qualified_qty；reserved/damaged 不变；每条 ReceiptItem 一笔 PURCHASE_RECEIPT 流水；Receipt POSTED；PO 部分/完成由数量推导。所有更新加审计同事务。剩余量必须在锁内重算，两张未过账单不能各自用旧剩余量超收。

B01 后续必须明确：received_qty 是实际到货还是送货单数量，少货如何定义；PO 累计消耗用合格量还是到货量；次品是否欠补、退还/报废和如何关闭未交量。在这些口径确定后同步修改字段注释、算法、UI和测试，不仅更改一个公式。

## 7. 销售和审计

Phase 2 建立 SalesOrder / SalesOrderItem / Return / ReturnItem 标准实体。允许未映射明细 sku_id=null，保留于异常队列，不归入某个虚构 SKU。取消/退货数量与实际退货入库是不同事件。真实订单不会未经规则确认直接改内部库存。

AuditLog 记录 actor、action、entityType/entityId、requestId、发生时间及脱敏 before/after。成功业务变更与审计同事务；失败登录等安全事件单独记录，不伪装成成功业务审计。所有金额、数量、权限、状态变化都可追溯。
