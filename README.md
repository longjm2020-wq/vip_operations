# 衣序 · 唯品会服装供应商经营管理系统

可运行的内部经营管理首版。React / Ant Design 6 前端，NestJS 模块化后端，PostgreSQL 事务库存，Redis + BullMQ 后台任务。

## 在当前电脑试用

双击 `START_LOCAL.cmd`，然后打开 **http://localhost:5173**。

用户名及本机随机初始密码见 `LOCAL_ACCESS.md`（仅本机文件，不加入Git）。登录后可在“系统设置 → 用户”重置密码。重新seed不会更改已有密码。

本机应用数据库为 `vip_erp_app`，没有演示商品或假销量。测试使用自动新建的独立数据库，不混入应用数据。首次试用顺序：

1. 建立供应商、仓库、品类，再创建商品及SKU。
2. 如有期初库存，通过“库存调整 → 期初建账”录入，填写原因。
3. 新建采购单、提交、确认；只有确认后计入有效在途。
4. 从采购单建立入库草稿，确认到货，再核对并过账。支持分次正常入库。
5. 在库存、流水、采购单和审计中核对结果。

无真实销售数据时，采购建议会明确跳过，仍可手工创建采购单。真实VOP未启用。

`START_LOCAL.cmd`依赖当前工作区 `../../work/runtime` 中的便携工具。复制代码到其他电脑后请按下面标准安装方式配置，不能只复制此启动器就运行。

## 已实现

- 登录/退出、服务端会话、CSRF、角色权限、用户启停/密码重置。
- 商品/SPU、SKU、品牌、品类、供应商、仓库的创建、查询和编辑。
- 按仓库存、全仓汇总、可售计算、带原因的调整、只读库存流水。
- 采购建议快照、人工改量/忽略、转草稿采购单；样例销量仅测试启用。
- 采购单草稿编辑、提交、经理确认、受限整单取消、有效在途计算。
- 入库草稿/验收编辑、确认到货、分次过账、已完成状态自动推导。
- 事务审计、持久化幂等、来源明细唯一约束、不可变历史触发器。
- 禁用的独立VOP边界；BullMQ Worker最小任务和失败重试验证。

## 标准开发环境

需要 Node 24、pnpm 10.32.1、PostgreSQL 16、Redis。根目录是workspace，应用在apps，领域契约和数据库在packages。当前锁文件为版本依据。

```sh
pnpm install --frozen-lockfile
# 复制 .env.example 为 .env，设置数据库连接、APP_ORIGIN及随机管理员密码。
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm dev
```

前端 http://localhost:5173，API http://127.0.0.1:3100/api/v1，开发接口文档 http://127.0.0.1:3100/api/docs。前端通过Vite代理访问API；POST/PATCH命令使用会话Cookie、CSRF及Idempotency-Key。金额和BIGINT ID以字符串传输。

`.env.example` 中密码只是待填项，必须自行设置。未配置真实VOP不会阻塞启动。API默认监听本机；容器通过HOST=0.0.0.0监听内部网络。HTTPS环境会使用Secure Cookie，非本机生产来源必须HTTPS。

## Docker Compose

已提供Dockerfile、前端Nginx和Compose。设置 `.env` 中 `POSTGRES_PASSWORD` 与 `ADMIN_PASSWORD`，以及可选 `COMPOSE_ORIGIN`（默认http://localhost:8080）。密码如含URL特殊字符，数据库URL需要URL编码；开发可使用随机字母数字密码。

```sh
docker compose up --build -d
docker compose logs api worker
```

打开 http://localhost:8080。migration/seed是单独启动步骤，完成后API才运行。数据库和Redis有持久卷。**当前电脑没有Docker，因此Compose构建和容器运行尚未本机验证**；不要把原生运行验证等同于容器部署成功。

## 检查与测试

```sh
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm test:e2e
pnpm test:queue
pnpm build
```

集成和浏览器测试要求数据库账号具有本机测试库CREATE DATABASE权限；每次创建独立 `vip_erp_test_*` / `vip_erp_e2e_*`，不reset已有库。测试数据保留供排查，不自动删除。Linux浏览器测试先 `pnpm exec playwright install --with-deps chromium`；当前Windows使用已安装Chrome。

SQL迁移以 `packages/database/migrations/*.sql` 为真值，带校验和与锁；Prisma schema用于类型/结构浏览，CHECK、部分索引和触发器仍由SQL管理。禁止用schema push替代迁移。新增结构使用新migration，不修改已经运行过的迁移。

`.github/workflows/check.yml`提供CI流程，尚未推送或在远程执行。测试结果详见 [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md)。

## 当前边界

- 次品、少货、部分取消、冲销尚有业务规则待确认，异常过账明确拒绝；正常合格分次入库可用。
- 真实销售、退货、颜色尺码矩阵、履约、财务及真实VOP接入不在本次阶段。
- 当前写入采用数据库级统一事务锁，优先保证正确性；高并发吞吐优化尚未开展。
- UI使用主数据抽屉、独立单据详情等简化交互；复杂批量导入导出、图像上传、采购计划未开发。
- 首版部分细分筛选、商品图片展示和更细权限的按钮体验仍可优化，已提供的接口操作由后端权限检查保护。

## 备份与迁移

标准PostgreSQL工具：`pg_dump -Fc` 备份目标应用库，`pg_restore` 恢复到另一个新建空库，再运行对应版本检查与migration状态验证。不要直接覆盖已有业务库。本机便携包只用于开发；正式备份恢复演练与生产部署另行验收。

## 文档

原九份启动规格保留在docs；[DECISIONS.md](docs/DECISIONS.md)记录工程默认和实际实现差异，[IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md)记录交付与未验收项。没有修改或虚构VOP字段/权限。

颜色与尺码映射管理：见 [条码规则](docs/BARCODE_RULES.md)。本地配置 DATABASE_URL；Compose 另配置 COMPOSE_DATABASE_URL（主机为 postgres）与 POSTGRES_PASSWORD，二者密码需一致。示例文件不包含连接串或密码。
