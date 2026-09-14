# 唯品会档期商品自动同步

## 范围

使用官方 `vipapis.inventory.InventoryService.getSkuList`（1.0.0）。当前能力为 `SCHEDULE_CATALOG`，默认范围不包含 OXO。不是全平台商品全集，不包括订单、销售、库存、发货或采购自动写回。平台商品独立保存在 `vop_catalog`，不会修改内部商品主数据和库存流水，也不根据列表缺失删除商品。

官方字段说明：https://vop.vip.com/home#/api/method/detail/vipapis.inventory.InventoryService-1.0.0/getSkuList

## 运行与部署

1. API 部署前运行 `pnpm db:migrate`，应用 `003_vop_sync.sql`；这是新增表迁移，不重写业务表。Web 与 API 发布后可访问「系统设置 → 唯品会接入」。页面和手动请求需要 `vip.settings` 权限。
2. Worker 保留 `REDIS_URL`，增加指向同项目 Postgres 的私网 `DATABASE_URL`。配置 `VIP_MODE=catalog`、`VOP_APP_KEY`、`VOP_APP_SECRET`、`VOP_VENDOR_ID`、`VOP_REQUEST_IP`（应用出口 IP），以及首次授权的 `VOP_ACCESS_TOKEN`、`VOP_REFRESH_TOKEN`、`VOP_TOKEN_EXPIRES_AT`（Unix 毫秒）。所有生产出口地址均须在唯品会白名单内。
3. 启动命令保持 `pnpm start:worker`。每 15 秒检查管理员请求；通常每 5 分钟启动增量窗口，单批最多 10 页，每页 200 条，批间 15 秒、请求间 1 秒。此频率是本系统保守配置，不代表平台额度承诺。
4. 首次从时间 0 开始全量读取，随后按成功水位向前重叠 300 秒，截止时间延迟 120 秒。固定窗口跨批、跨重启续传；每日从 0 重新核对，以补偿迟到数据和分页变化。平台没有公开稳定快照排序保证，所以不能承诺绝对无遗漏；保留历史数据，不据缺失执行删除。

## 正确性与恢复

- 每连接持有 PostgreSQL 会话锁，多 Worker 实例不会同时处理同一连接。每页数据和下一页断点在同一事务提交，最后一页提交后才移动时间水位。
- 唯一键：应用与供应商命名空间 + 合作编码 + 仓库 + 条码。重复页面不重复写入，较旧更新时间不能覆盖较新记录。
- 无法解析的数据仅保留商品允许字段并隔离到 `vop_sync_rejections`。每页轮转重试最多 100 条；解析规则修复后自动回放。仍有异常时显示「部分记录待处理」，不能当成完全成功。不可恢复的数据需核对官方契约后修复适配器，不可直接猜测身份字段。
- 网络超时、HTTP 429/5xx 自动重试；授权、白名单和契约问题停止并显示安全错误码。管理员修复原因后点「立即同步 / 重试」。手动请求沿用断点，记录审计日志，受 CSRF、权限和幂等保护。
- 令牌在到期前 24 小时通过官方 `vipapis.oauth.OauthService.refreshToken` 刷新，采用文档定义的 `request` 字段。刷新值使用 AppSecret 派生密钥的 AES-256-GCM 加密保存，绑定连接命名空间；重启优先使用数据库值，不会被旧环境变量覆盖。
- 刷新请求结果不确定时停止自动旋转，错误码 `REFRESH_RECOVERY_REQUIRED`。用户重新授权并更新 Worker 的令牌变量后，在 Worker 执行 `node dist/scripts/vop-restore-auth.js --apply`。此命令是人工恢复入口，正常部署不要运行。AppSecret 变更同样需要恢复。不要输出变量内容、密文或请求完整 URL 到日志。

刷新文档：https://vop.vip.com/home#/api/method/detail/vipapis.oauth.OauthService-1.0.0/refreshToken

## 验证与运维

`pnpm test:unit`；`pnpm test:integration`；`pnpm exec tsx tests/integration/vop-sync.ts`（根据本地 `DATABASE_URL` 创建并清理独立测试数据库）；`pnpm typecheck`；`pnpm lint`；`pnpm build`。

上线后查看 Worker 的 `vop-catalog` 日志，以及接入页的商品数、最近成功时间、异常数、授权到期时间。超过 10 分钟未报告状态会显示告警。运行历史保存在 `vop_sync_runs`，目前没有自动删除策略，按数据库增长安排备份和归档。备份数据库同时安全备份 AppSecret，否则无法解密令牌。

回退：先把 Worker `VIP_MODE` 改为 `disabled` 并重新部署。保留四张新增表和已保存的平台资料，再回滚应用版本；不需要删除或回滚业务数据。
