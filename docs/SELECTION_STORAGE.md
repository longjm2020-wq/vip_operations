# 选款图片存储与容量验证

修订：2026-09-30

## 已实现的存储路径

- API 复用项目附件的 `AWS_ENDPOINT_URL`、`AWS_S3_BUCKET_NAME`、`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、`AWS_DEFAULT_REGION` 配置。
- 正常上传、洗唛/吊牌图、手机拍图和外部收集表均写入私有对象存储的 `selection-images/` 前缀。数据库存储对象键、类型、字节数与 SHA-256；新上传不保存图片二进制。
- 保持原来的 `/api/v1/style-selections/images/:id` 网址，通过 API 鉴权后读取文件；外部分享仍检查分享有效性及图片归属。没有公开 bucket 或返回存储凭证。
- 每个 API 进程的图片缓存上限为 16 MiB，缓存有效期 60 秒；并发读取同一对象合并请求。每次请求仍先检查权限和数据库记录，内部图片继续使用 ETag 条件请求。
- 当前图片内容仍经 API 转发，尚未启用浏览器直传、CDN 或缩略图。这些网络开销仍应纳入线上容量测试。

## 历史迁移

部署时先执行 026 数据库迁移；API 启动 10 秒后，每批处理 5 张，单张顺序复制，下载核对字节数及 SHA-256 后才设置对象引用。成功批次间隔 1 秒，失败后等待 60 秒再重试。对象键固定，可安全重启继续。

历史数据库二进制保留用于恢复。对象存储异常时历史图片可回退该副本；新图片上传失败会返回 503，不静默转存数据库。数据库磁盘占用不会因此立即下降。暂未执行数据库旧副本清理或 VACUUM FULL。

API 日志中的 `selection-image-migration` 事件提供 `migrated` 与 `remaining`；`remaining:0` 表示当次扫描已完成。将 `SELECTION_IMAGE_MIGRATION=off` 并重新部署可暂停后台复制，不会关闭图片读取或新上传。

数据库只读核对：

```sql
SELECT count(*) AS total,
 count(*) FILTER (WHERE storage_key IS NULL) AS pending,
 count(*) FILTER (WHERE storage_verified_at IS NOT NULL) AS verified_legacy,
 count(*) FILTER (WHERE content IS NOT NULL) AS retained_copies,
 coalesce(sum(byte_size),0) AS image_bytes
FROM style_selection_images;
```

回滚必须使用支持对象存储的版本。已有新图片的 `content` 为 NULL，不能直接回滚到只认识数据库二进制的旧版本。暂停迁移与回滚代码是不同操作。

## 100 用户隔离压测

运行 `SELECTION_LOAD_TEST=1 npm run test:integration`（PowerShell 先设置 `$env:SELECTION_LOAD_TEST='1'`）。脚本拒绝连接非本地地址或非 `vip_erp_test_<时间戳>` 数据库。S3 使用本地协议测试服务，绝不访问生产 bucket。

2026-09-30 测试环境：12 逻辑处理器、约 15.8 GB 内存的本地电脑，Node API、PostgreSQL、本地 S3 测试服务运行在同机。100 个独立用户会话、1515 条款式、122 秒；30 个用户周期保存，10 个用户周期上传约 300 KB 图片，所有用户读取图片及协作状态，并反复完整读取列表模拟资料变化。

| 请求 | 次数 | P95（毫秒） |
| --- | ---: | ---: |
| 列表分页接口 | 15072 | 594 |
| 图片读取 | 942 | 824 |
| 单元格保存 | 150 | 557 |
| 图片上传 | 40 | 474 |
| 在线状态读取 | 4551 | 449 |
| 在线状态写入 | 803 | 1093 |
| 版本检查 | 942 | 815 |

请求错误 0；响应流量约 1139 MiB。结果文件为 `.local/selection-load-result.json`。测试不含公网传输、真实 S3 延迟、浏览器渲染或长时间稳定性；不能作为生产 100 人流畅运行的保证。整表刷新流量仍较高，下一阶段应验证服务端分页/增量同步和图片直达存储方案，然后在与生产一致的隔离环境运行持续压测，再根据 CPU、内存、连接池等待及 P95 决定扩容。
