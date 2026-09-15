# 独立本地开发环境

开发环境使用全新的 PostgreSQL 集群与 Redis 实例，不从生产读取、复制测试数据。当前 `.env` 选择 `127.0.0.1:55432/vip_erp_dev` 和 `127.0.0.1:56379`。原 README 中的 `vip_erp_app` 是早期电脑的试用库名称。

## Windows 启动配置

安装 Node 24、pnpm 10.32.1、PostgreSQL 16 和 Redis。PostgreSQL 的运行文件与数据目录应使用英文路径，以避免 Windows 中文路径导致 initdb 的 UTF-8 编码错误。

`.local/runtime.json` 示例（填入本机绝对路径）：

```json
{
  "workRoot": "C:/Users/Administrator/.vip-operations-dev",
  "runtimeRoot": "D:/your-project/.local/runtime",
  "pgCtl": "C:/Users/Administrator/.vip-operations-dev/postgres16/package/native/bin/pg_ctl.exe"
}
```

启动器从 PATH 获取 node.exe，使用 `workRoot/pgdata16` 作为已初始化的数据库目录，从 `runtimeRoot/redis` 查找 redis-server.exe。Redis 数据保存在项目的 `.local/redis-data`，启用 AOF。数据库端口固定为 55432，Redis 端口固定为 56379；`.env` 须保持一致。首次启动前确认端口没有被其他项目占用。

在全新集群创建 `vip_erp_dev`，为本地开发账号设置随机密码和 CREATE DATABASE 权限（供隔离测试建库）。按照 `.env.example` 创建 `.env`，设置上述本地连接、随机 ADMIN_PASSWORD、`VIP_MODE=disabled` 和 `SALES_SOURCE=unavailable`，然后执行：

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm build
```

双击 `START_LOCAL.cmd` 启动编译后的 API、Vite 和 Worker。启动器检查 API 与前端 HTTP 就绪后才报告成功。修改后端后重新构建并重启进程；需要热更新时，在数据库与 Redis 已启动的情况下使用 `pnpm dev`，避免与已运行的应用端口冲突。

地址为 http://localhost:5173，随机管理员密码见本机 `LOCAL_ACCESS.md`。运行配置、凭据、依赖和日志均不加入 Git。种子只初始化权限、管理员与标准映射，不创建演示商品或销量。原有单条表单和在线表格入口均保留。

集成测试和浏览器测试自行创建 `vip_erp_test_*`、`vip_erp_e2e_*` 数据库，使用本地生成的测试资料，不写入 `vip_erp_dev` 的业务表。运行测试前务必确认 `.env` 与进程环境中的 DATABASE_URL 都指向本地开发集群。
