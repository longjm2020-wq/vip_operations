# 罗盘官方取数准备核验

获取日期：2026-10-03。范围：准备接入，未进行真实指标取数、未启用官方同步。

## 官方权限与文档

- 已登录 VOP 控制台，应用处于运行中，JIT+JITX 权限包已获批。已获批接口清单包含 `vipapis.inventory.InventoryService.getSkuStock`、`vipapis.jitx.JitXService.getOrders` 和 `com.vip.data.compass.service.vop.CompassDataOspService.data`。权限清单不能代替真实数据调用验证；订单与库存采集仍未启用。
- [罗盘接口当前文档](https://vop.vip.com/home#/api/method/detail/com.vip.data.compass.service.vop.CompassDataOspService-1.0.0)：版本1.0.0，方法`data`，不需要OAuth授权，入参`api_params: Map<String,String>`、`path: String`（必填API code）、`vendor_id: String`（必填供应商ID）。具体查询参数需在罗盘「取数/API/包含的数据及口径」查看，公开VOP页面没有列出指标API code。
- 官方Java SDK `20260828092330` 的源码合同：`CompassDataResponse` 包含`code`、`msg`、`data: List<Map<String,String>>`、`searchAfterIndex`和`updateTime`。仅阅读下载的官方源码，未执行SDK。成功业务码、查询游标参数名及各指标映射尚无账号级证据，不能猜测。
- 已登录罗盘知识中心「功能介绍 → 取数API」，文章更新于2022-04-29，说明RSA私钥加密`account|epochMilliseconds`（UTF-8、PKCS#1 v1.5）后Base64编码，公钥需登记在罗盘，账号决定品牌等数据权限。当前个人中心只有品牌/品类权限，自助工具只有报表及下载中心，未显示公钥登记和取数入口。
- 支持工单`BZ2026091517000042`于2026-09-15结案，处理意见要求由对接商务走OA申请。2026-10-03用户确认尚未开通，要求先准备接入。

## 商品上下架状态查询

已获批接口还包含[`SalesVopService.queryConsignmentBarcodeListingInfo`](https://vop.vip.com/home#/api/method/detail/com.vip.somp.sales.backend.service.SalesVopService-1.0.0/queryConsignmentBarcodeListingInfo)。当前在线文档说明按代销条码列表查询，返回条码的上下架信息，最后状态变更类型（`LISTED`/`UNLISTED`）和变更时间。返回状态为0下架、1上架；条码结果码200存在、404不存在、500未发布，未上架过的条码变更时间为0。

此接口已在权限清单核验，尚未进行真实查询，现有商品库尚未采集该字段。VC商品列表的“部分上线”不能直接当作接口枚举；按完整商品条码集合汇总后仍须与VC口径核对。“不存在”“未发布”及部分查询失败应单独保留，不能统一判为下架。该接口与罗盘指标取数的商务OA开通流程独立。

## 本次实现

新增Worker配置检查、会话/权限/CSRF/幂等保护的单页只读验证请求及独立元数据记录。只留状态、行数、字段名、游标是否存在和源更新时间；不保存原始行、游标值、签名、私钥或平台原始消息。识别已公开的403/405/400错误；收到其他业务码仍只标记响应已收到，`metricContractVerified=false`。

配置更新使旧结果失效；验证不自动翻页、不重试、不替换经营分析来源、不修改ERP库存及邮件启用状态。主功能摘要仍适用于现有经营分析、采购库存、协作和供应链功能，本次仅新增接入诊断，不新增已验证的官方销售同步能力。

## 本机验证

使用独立本机 PostgreSQL 和虚构供应商/账号，不调用唯品会真实接口。10项单元测试、7个数据库验证场景及14项HTTP请求检查通过，覆盖长ID、空字段、参数和密钥格式、单页请求、配置失效、业务拒绝、任务中断、登录/权限/CSRF、幂等和频率限制。页面核对未配置时禁用验证按钮，报告原始值、游标和配置指纹不出现在状态接口。TypeScript、相关模块ESLint、服务端编译和前端构建通过。

## 正式启用前所需证据

1. 商务OA开通完成，公钥已登记；对应私钥仅保存在Worker部署环境。
2. 提供商品每日指标的API code、字段定义、查询区间、分页参数、业务成功码、限流及数据回刷规则。
3. 先验证最小时间窗，与同日原始款号、货号、条码Excel逐一核对来源日期、行数、金额、数量及库存快照；保留长ID字符串，不相加三个维度。
4. 完整分页、断点续传、去重、旧数据保护及覆盖范围校验通过后，另行接入指标归一化和自动导入。现有Excel更新流程与关闭的每日邮件保持现状。
