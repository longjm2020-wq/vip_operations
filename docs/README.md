# 项目启动文档包

当前用户操作说明见 [使用手册](manual/00-start.md)，系统内右上角「使用手册」提供全部模块的搜索、阅读和下载。`docs/manual/` 是唯一内容源，与应用构建同步发布；本目录其余文件包含设计与技术记录，不能全部视为当前用户功能。

项目：唯品会服装供应商经营管理系统 · v0.1 · 2026-09-12。

本包整理已确定方案并补充可执行的工程约定，不包含应用代码、不代表软件已完成。待确认业务规则与VOP能力都有独立TODO和启用门槛。

## 开始使用

1. 将本文件夹放入计划开发的仓库，建议九份规格保存至 `docs/`。
2. 先阅读 [PROJECT_BRIEF.md](PROJECT_BRIEF.md)，确认范围及已确定/工程默认/TODO的区别。
3. 将 [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) 第一节启动任务发给Codex，要求按M0–M6推进Phase 0/1。
4. 每阶段按验收表检查；第一阶段无需真实VOP密钥，Sales以明确标识的测试数据验证建议算法，生产无销量时不生成假建议。

## 文档清单

| 文件 | 内容 |
|---|---|
| [PROJECT_BRIEF.md](PROJECT_BRIEF.md) | 目标、来源、冻结技术栈、待确认清单 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Monorepo、模块化单体、事务、会话和运行结构 |
| [MVP_SCOPE.md](MVP_SCOPE.md) | 第一期边界和A01–A16验收案例 |
| [DATA_MODEL.md](DATA_MODEL.md) | 领域实体、库存口径、状态机、建议与入库规则 |
| [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md) | 字段类型、关系、约束、索引、迁移 |
| [API_SPEC.md](API_SPEC.md) | REST、DTO、RBAC、错误码、幂等 |
| [UI_SPEC.md](UI_SPEC.md) | 中文后台路由、表格字段、交互、异常状态 |
| [VOP_INTEGRATION.md](VOP_INTEGRATION.md) | 独立Adapter、禁用模式、真实接入证据门槛 |
| [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) | 启动指令、里程碑、检查命令、测试及报告格式 |

## 必须注意的范围说明

- 正常分次采购入库可先实现；次品、少货结清口径原对话尚未统一，异常单过账需先解决B01。
- Prisma为本包工程默认，原对话未在Prisma/Drizzle间最终选定；依赖具体版本需要开工时验证。
- 销售分析、采购计划、履约、财务和真实VOP不属于本次Phase 1必做功能。
- 本次文档检查只覆盖文件完整性、链接及规格一致性；应用lint、测试和迁移将在实际建仓库后执行。
