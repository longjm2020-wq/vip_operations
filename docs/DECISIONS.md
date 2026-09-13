# 实施决策记录

更新：2026-09-13。

## 固定技术栈

React 19.3 / Ant Design 6.6.3 / Vite 7.3 / NestJS 11.2 / TypeScript 5.9 / Prisma 7.10 / PostgreSQL 16 / Redis + BullMQ 5。精确依赖由 pnpm-lock.yaml 固定。npm registry 的 Prisma latest 在开工时指向 8.0 RC，故明确使用稳定 7.10，不采用预发布版本。Node 24.21、pnpm 10.32.1；不要求 Nest CLI。

兼容性参考：[NestJS 安装](https://docs.nestjs.com/first-steps)、[Ant Design 6 迁移说明](https://ant.design/docs/react/migration-v6/)、[Prisma 7](https://www.prisma.io/docs/orm/v7)。实际安装、类型检查和编译结果是本次运行依据。

## 数据库与并发

- Prisma负责PostgreSQL连接适配和事务；复杂事务/查询使用绑定参数的SQL。动态标识符只来自内部资源白名单，不接受任意表名或列名。
- SQL migrations为结构真值，带SHA256校验与迁移锁。Prisma schema 从相同数据库结构内省得到；CHECK、部分唯一索引和不可变历史触发器在SQL维护，禁止schema push覆盖。
- 第一版所有写入除幂等键锁外还采用一个数据库事务级写锁，再锁定单据/余额行。这样吞吐有限，但可保证停用仓库、取消、建议转换和入库之间采用一致顺序；后续需要吞吐时再细化锁，不以Redis锁代替数据库保证。
- 影响库存的变更、流水、采购累计、单据状态、审计、幂等结果同事务。历史流水和审计在数据库层拒绝UPDATE/DELETE。
- 原始SQL参数中的Date转为带时区ISO字符串，避免驱动隐式timestamp转换导致会话过期时间丢失偏移。

## 第一阶段交互调整

- 主数据使用列表+抽屉完成创建和编辑；商品详情独立页面。商品SKU可逐条创建，批量色码生成仍等待B02，不自动合并。
- PO、Receipt在独立详情中操作，草稿/未过账提供编辑抽屉。建议关联明细的草稿修改暂拒绝，避免失去快照到采购量的关系。
- 开发样例销售只用于隔离的测试数据库；本机用户可访问环境默认unavailable，完全没有伪造经营销量。
- 风险阈值、MOQ自动调整、次品少货过账保持未启用，不自动扩大第一阶段业务。
- 生产HTTPS使用Secure会话Cookie；仅localhost/127.0.0.1允许本机HTTP演示。不能将HTTP演示配置用于公网。

## 本机环境

原电脑无Node、Git、PostgreSQL或Docker。便携工具存于项目外的work/runtime；已建立本地Git分支codex/phase-1。PostgreSQL18便携包初始化失败，改用PostgreSQL16.13后成功。数据库仅监听127.0.0.1:55432，Redis便携端口56379。便携Redis为Windows移植版本，仅用于开发验证；标准部署采用Compose的Redis官方镜像。

Docker Compose与CI配置已提供，但本机没有Docker，不能宣称容器构建/Compose启动或远程CI已运行。原生Windows下同一应用的迁移、测试、构建和浏览器验证另行报告。
