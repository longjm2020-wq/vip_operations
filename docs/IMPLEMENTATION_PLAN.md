# IMPLEMENTATION_PLAN · Codex 开工执行书

## 1. 可直接粘贴的启动任务

> 请依据本目录九份规格创建“唯品会服装供应商经营管理系统”代码仓库。先读 PROJECT_BRIEF.md 和 MVP_SCOPE.md，再读其余规格。技术栈固定为 React + TypeScript + Vite + Ant Design 6 + TanStack Query + Zustand，NestJS模块化单体，PostgreSQL，Redis+BullMQ，Monorepo和Docker Compose。先完成Phase 0，再依本计划完成Phase 1，暂不接真实VOP，不扩展销售/履约/财务。库存必须同数据库事务写余额、流水、采购累计、单据状态和审计；入库必须有持久化幂等和数据库业务唯一约束。工程默认记录在docs/DECISIONS.md；TODO只隔离相关能力，不猜字段或规则。每个里程碑实际运行lint、typecheck、相关测试和迁移检查，报告结果及未完成项。先检查工作目录和现有修改，再开始建仓库；不要覆盖用户文件，不要因VOP未认证停工。首个交付是可启动的工程骨架和已验证迁移，随后完成真实前后端业务闭环。

如果用户只授权一个里程碑，则完成该里程碑后报告；若授权整个Phase 1，按下述顺序持续推进到验收。此文不授权部署生产、重置现有数据库或执行真实VOP写操作。

## 2. 读文档与冲突处理

顺序：PROJECT_BRIEF → MVP_SCOPE → DATA_MODEL → DATABASE_SCHEMA → ARCHITECTURE → API_SPEC → UI_SPEC → VOP_INTEGRATION → 本执行计划。保留文档在仓库docs，README链接入口。

已确定项不得替换；工程默认可以在同等边界内作出可逆实现选择并记录理由；业务TODO在对应写路径前阻断。特别是B01异常入库、B04真实销量与V01–V08，不允许为了“完成所有按钮”编造实现。

## 3. 里程碑与顺序

### M0 — 工作目录与工程骨架（Phase 0）

1. 检查已有文件、Git状态及仓库说明，识别现有项目。空目录初始化Monorepo；已有项目仅增量修改。用户未要求其他分支名时使用codex/前缀，避免覆盖其工作。
2. 创建apps/web、apps/api、apps/worker、packages/contracts/database/config及docs。
3. 核实指定依赖兼容版本，记录Node/包管理器/ORM决策并锁定版本。原方案未选ORM，工程默认Prisma；不能同时装两套ORM。
4. 配置Compose PostgreSQL/Redis、环境样例、前后端启动与构建、最小API health、Worker测试任务。
5. 建立格式/lint/typecheck/unit/integration/e2e命令和CI框架；不存在的测试先明确阶段未实现，不伪造通过报告。

验收：全新环境按README可安装、启动前后端，PG/Redis健康，Worker处理一条测试任务；无VOP秘密也能启动；lint/typecheck/build通过；没有真实平台外呼。

### M1 — 数据库与身份（Phase 1）

1. 按DATABASE_SCHEMA依赖顺序生成核心migration及权限seed；业务表只建Phase 1部分。
2. 实现登录/会话/退出、CSRF、RBAC、用户/角色维护和统一错误响应。
3. 建立AuditService和事务上下文，确认库存服务未来能复用同一事务。
4. 实现登录与后台布局、权限菜单、用户/角色页面。

验收：空库迁移、重复seed可用；唯一键/CHECK/FK存在；401/403真实拦截；采购员不能调用确认；用户禁用/角色撤销生效；秘密不出现在响应/日志；数据库中没有明文密码。

### M2 — 主数据

实现供应商/仓库/品牌/品类，再做Product/SKU；提供列表、详情、创建、编辑、归档/停用API与页面。禁止建商品时要求VOP映射。

验收：浏览器可建立SPU及SKU，重复编码409；表单校验和后端校验一致；历史引用不能物理删除；主数据变化有审计；筛选分页从服务器取真实数据。B02未确认时组合只提示、不强制唯一。

### M3 — 库存事务底座

实现按仓余额、全仓SKU汇总、流水查询和带原因调整。先确保数据库事务/来源单/幂等约束正确，再接前端调整Modal。期初非零库存通过OPENING调整产生。

验收：available计算正确；负库存/超过可售调整被拒绝；并发首次余额创建无重复行；任何写入阶段失败不出现孤立余额/流水；同调整幂等键不重复变化；可从流水重建三种余额。

### M4 — 采购单与正常分次入库

先做手工PO，暂不依赖建议算法。实现草稿/提交/确认/有限整单取消；再建Receipt、到货确认、正常验收、过账。接采购单、到货入库和源单据跳转页面。

执行DATA_MODEL状态机；B01异常单只保存不允许过账。按ARCHITECTURE固定锁序执行单事务，持久化幂等，ReceiptItem唯一流水。PO确认后才计在途，过账自动部分/完成。

验收：MVP_SCOPE A06–A12、A14–A16；尤其同单不同键重试、两个Receipt并发超收、响应丢失后重试和中途审计失败。前端收到超时保留原键。实现此阶段后，不接任何销量也已经有可用采购库存闭环。

### M5 — 采购建议与数据源隔离

实现纯计算函数、SalesMetricsProvider、生产UnavailableProvider和开发FixtureProvider。保存来源、窗口、算法版本与库存快照；实现生成/接受/改量/忽略/转PO及页面，转PO同事务锁建议并唯一关联。

验收：fixture 70件/7日、21天、可售30/在途20→建议160；人工改150原值仍160；重复转单不建第二单；零销量/缺数据/不足窗口分别正确处理；没有确认的风险/MOQ规则不能静默自动调整；生产拒绝fixture。

### M6 — 集成验收与交接

完成全部Phase 1页面和审计关联；检查VOP禁用状态、Worker最小任务、环境文档和完整OpenAPI。执行端到端场景并核对数据库，修复失败，不以mock前端代替后端验收。

验收：全新环境可复现；上述里程碑相关检查通过；无库存/幂等/RBAC高风险遗留；TODO都列明影响范围；README能让另一位开发者安装、迁移、seed、启动、测试。没有运行环境时如实标注未验证，不能宣布整阶段验收完成。

## 4. 检查命令契约

开工后应提供这些根脚本（名称为工程约定，创建之前不能假称已可运行）：

```text
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm test:e2e
pnpm build
pnpm db:migrate
pnpm db:seed
```

README明确各命令是否需要Compose、测试数据库地址及运行顺序。db:migrate使用已提交迁移，不用schema push替代。测试必须连接独立临时测试库，不使用用户生产库；集成/迁移测试不能换成SQLite，因为锁和约束语义不同。

每里程碑跑lint/typecheck/build和相关unit/integration；UI里程碑跑关联e2e。涉及schema变更跑空库迁移与上阶段升级；schema未变仍验证无pending migration，避免无意义重复重置。M6统一跑完整回归。

## 5. 必须覆盖的测试矩阵

| 层 | 关键测试 |
|---|---|
| Unit | 可售/在途计算；suggested截零/向上取整；零日均；无数据不等于0；建议状态机；PO/Receipt合法迁移；Decimal金额 |
| PG Integration | 唯一/FK/CHECK；事务失败回滚；并发首次余额；两Receipt超收；同Receipt同/不同键重复；请求体冲突；取消与过账竞态；流水重建余额 |
| API/RBAC | 未登录401、无权403；伪造status/receivedQty/操作者/total被拒；跨PO明细/错仓库拒绝；权限撤销后幂等重放仍拒绝；分页排序校验 |
| 建议集成 | 批量生成业务跳过；数据库故障全回滚；同SKU并发只有一个活动建议；忽略后显式重建；接受/转换竞态；关联建议唯一 |
| E2E | 登录建档→调整期初→建PO→提交/经理确认→分次入库→查流水与审计；数据刷新持久；无数据/失败/403/409显示 |
| 隔离 | disabled VOP无网络调用；fixture生产不可启动；Worker失败重试可观察；秘密不出现在日志响应 |
| Migration | 全新迁移；带数据升级；可重复seed；测试数据库中约束真实生效 |

并发测试使用两个独立数据库连接/事务和同步屏障，不用串行两次调用假装并发。回滚测试在更新余额后、写流水或审计时注入异常，并直接检查全部表。检查PO received、balance、receipt状态及事务行数，不能只断言HTTP 200。

最低金标准是MVP_SCOPE里的可计算结果，不用覆盖率数字替代业务验证。前端禁用按钮测试不能证明后端幂等。

## 6. 阶段报告格式

```text
里程碑：M__
已交付：功能、页面、迁移、对应验收编号
运行结果：检查命令、通过/失败、关键证据
数据库：迁移版本、空库/升级结果
演示入口：本地地址与登录创建方式（不粘贴密码）
未完成/TODO：ID、影响、后续门槛
下一步：下一个已授权里程碑
```

报告实际执行情况，外部环境阻碍要区分“没跑”“失败”“已通过”。不要把未完成测试写成通过，也不要因deadline隐藏未验收项。提交代码按里程碑组织、描述清楚；未经授权不推送、部署或重置外部环境。

## 7. Phase 2/3 开始门槛与禁止事项

Phase 1结束后只提供后续清单，用户要求继续时再开展Phase 2/3。Phase 2先定销量口径/时间窗/取消退货与库存事件，Phase 3先验证VOP证据与权限。

禁止：为了省事换栈；混用ORM；只做静态UI；在Controller直接写库存；不同事务提交PO和余额；可售/在途任意覆盖；假VOP字段；模拟同步成功；真实库存和平台快照重复累加；绕过幂等/权限；修改历史流水；擅自做采购计划/财务/履约或微服务；运行破坏性数据库reset；未核实依赖版本兼容就宣称可运行。
