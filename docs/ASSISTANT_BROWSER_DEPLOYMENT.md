# 小序独立浏览器部署

更新日期：2026-11-16。

独立浏览器由服务器 Worker 调度，使用 Playwright Chromium headless shell；它与用户的本机浏览器、电脑执行器以及唯品会、罗盘的业务登录会话分开。API 提供当前账号的任务和接管画面。浏览器能力不等于提供完整云电脑，也不依赖本机安装虚拟机。「我的电脑」继续使用已有 Windows 客户端与本机授权，两种执行目标不会互相替代。

## 部署条件

- API 与 Worker 使用同一数据库，按顺序执行所有迁移。`099_assistant_browser.sql` 创建每账号默认 profile、任务、加密接管动作和运行状态表；`100_assistant_browser_environments.sql` 增加执行环境的创建与销毁记录；`103_browser_browsing_sessions.sql` 增加持续浏览会话、独立自动目标、请求幂等记录、导航、视口和执行截图回执。旧电脑用途数据保留。
- API 与 Worker 复用已有的 `COMPASS_MAIL_KEY`，格式为 64 位十六进制 AES-256 密钥，须保持一致。浏览器密文通过功能、账号及 profile/任务标识的 AAD 与其他用途隔离。不要在部署日志中输出密钥或存储状态；修改主密钥会使已有密文不可读，不能作为修复单个任务的方式。
- 模型规划通过现有已启用并验证的 OpenRouter 连接，管理条目为 `assistant_browser`。账号必须具备原有小序使用权限；Worker 每次规划及实际输入前重新检查当前权限。
- Dockerfile 在构建阶段安装 Chromium 及系统依赖，运行阶段使用 `USER node`；`/app` 归 `node` 所有，`/ms-playwright` 保持 root 所有并给予运行用户读取、执行权限，避免改变沙箱辅助程序的所有者。运行身份不能绕过宿主的安全策略，仍须以目标实例上的实际沙箱启动检查为准。浏览器子进程只继承必要系统环境，临时目录按会话隔离，不继承数据库连接、供应商密钥等业务变量。
- 本地运行模式明确使用 `chromiumSandbox: true`。Worker 会实际启动和关闭浏览器检查运行条件；宿主不允许 Chromium 沙箱时，功能保持未就绪。不能以自动添加 `--no-sandbox` 作为降级，也不能仅凭镜像中存在浏览器文件就标记就绪。发布后必须核对目标 Worker 上的实际检查结果。

## Railway 一次性浏览器环境

托管 Worker 宿主无法启动 Chromium 沙箱时，可使用 `railway` 运行模式。以下变量只放在 Worker 服务，不放到 Web、API、前端构建变量或浏览器 VM 中：

| 变量 | 值 |
| --- | --- |
| `ASSISTANT_BROWSER_RUNTIME` | `railway`；未配置时仍使用本地模式 |
| `ASSISTANT_BROWSER_RAILWAY_TOKEN` | 对应项目环境的 Railway project token |
| `ASSISTANT_BROWSER_RAILWAY_ENVIRONMENT_ID` | 与 token 对应的 Railway 环境 UUID |
| `ASSISTANT_BROWSER_RAILWAY_TEMPLATE` | 准备脚本返回的干净版本 checkpoint 名称；必须与当前安装的 Playwright、Zod 版本一致 |

使用固定版本 `railway@3.17.0` SDK。健康检查仅验证编译后的运行文件与同一环境下已存在的版本 checkpoint，不创建计费 VM、不隐式构建模板。缺少配置、基础环境不存在或版本不匹配时保持未就绪；不会回退到用户等待期间安装浏览器。连接检查不等于目标网页已登录或单次任务已完成，仍必须查看实际任务结果。

每个账号的新浏览会话创建一个 1 vCPU / 2 GB VM，同一会话内的直接浏览和后续自动目标复用当前浏览器。网络模式固定 `ISOLATED`、没有公开域名、不加入项目私网，平台空闲超时为 1 分钟。只上传白名单中的浏览器、出站代理和固定 RPC 代码，以及当前账号的登录态和本次输入；数据库连接、模型密钥、主加密密钥和 Railway token 留在 Worker。VM 内以非 root 用户启动浏览器，仍保留 `chromiumSandbox: true`。隔离边界是一次性 VM；内层 namespace、seccomp 等机制分别作为诊断。

有效会话在 VM 身份校验后立即调用一次平台 `heartbeat()`，随后每 20 秒保活；ephemeral RPC 连接和截图流不能替代平台空闲计时的刷新。保活只作用于该租约绑定的 VM，不写用户活动时间，也不延长 5 分钟无操作或 30 分钟总时限。关闭、取消或租约失效会停止保活；保活失败只记录固定码 `BROWSER_VM_HEARTBEAT_FAILED` 并关闭、清理当前环境，不重连或重新创建。Worker 丢失连接后仍保留平台 1 分钟空闲回收保护。

用户打开时从已准备好的 checkpoint 启动环境，上传本次发布的白名单 RPC 代码，执行最多 15 秒的版本和文件完整性检查后连接；不执行 npm、系统依赖或 Chromium 安装。整个启动仍计入任务建立后的 30 分钟总时限。正式输入通过认证的双向 ephemeral exec RPC：模型不能传入 shell、脚本或文件路径；每次输入前回查当前任务租约、状态和用户权限。断线、超时或未知结果不重放点击。通道断开会停止进程，结束后销毁 VM。

固定运行文件以一个最多 2 MiB 的文件包上传。VM 核对 SHA-256、路径白名单和文件大小后展开，随后统一设置权限并检查运行依赖。上传失败或会话取消时等待已发出的写入完成后再清理；网络悬挂时最多等待 10 秒，记录固定码 `BROWSER_VM_UPLOAD_DRAIN_TIMEOUT` 后继续销毁。不执行不完整的代码，也不会为重试另建环境。

### 发布前准备干净基础环境

在与 Worker 相同的依赖锁定版本下运行 `node --import tsx scripts/prepare-assistant-browser-runtime.ts`。默认仅输出资源计划，不联网、不创建 VM 或 checkpoint。审阅计划后由授权发布者显式加 `--build`，控制进程读取上述 token 和 environment ID；凭据不会传入准备 VM。脚本不读取数据库、账号登录态或模型配置。

实际准备最多创建一台全新 1 vCPU / 2 GB、`ISOLATED`、无公开域名的 VM。它复制 Node 二进制、安装固定版本依赖和 Chromium headless shell、建立非 root 用户，以 `chromiumSandbox:true` 启动真实空白 renderer 后关闭浏览器，再保存唯一 UUID 后缀 checkpoint。基础环境只保留运行组件，不带用户 Cookie、页面、RPC 进程或项目秘密；不能从已有用户浏览 VM 制作模板。发布代码仍在每次启动时上传，因此纯产品代码更新不必重新制作依赖层；Playwright/Zod 或基础 recipe 版本变化必须重新准备。

准备工作的总期限为 5 分钟，随后最多 60 秒确认销毁准备 VM；创建响应 ID 在等待 SDK 就绪前写入 `.local/browser-runtime-builds/<UUID>.json`。成功回执必须同时为 `stage=READY`、`prepared=true`、`destroyConfirmed=true`，再把其中 `template` 配到 Worker。失败不自动创建第二台；创建结果未知或清理未确认时，按回执的确切环境与 ID 人工核对，不猜测删除其他资源。即使模板配置缺失或失效，现有 VM 的清理仍独立运行。

准备产生一次计算、下载及保留 checkpoint 的存储用量；超时只是程序执行限制，不是平台费用上限。保留上一个仍在使用的版本供回滚；新版本验证且所有服务不再引用旧名称后，由管理员按同一环境下确切 checkpoint ID 删除旧版本。脚本不会删除其他 checkpoint，不创建常驻预热 VM、不购买新服务。SDK 的 `create(template)` 会隐式等待模板构建，生产打开路径因此使用已存在的 `create(checkpointName)`。

运行日志记录固定阶段 `CREATING / UPLOADING / VERIFYING / CONNECTING / OPEN_DISPATCHED / READY / CLEANUP` 及有限数值 `elapsedMs`、`sincePreviousMs`。`CONNECTING` 到 `OPEN_DISPATCHED` 计安全通道建立和启动请求发出，之后到 `READY` 计浏览器初始化及回执。启动按已校验的视口创建会话，视口在启动期间发生变化时仍由正常流程调整。直接浏览的首帧日志另记录运行环境、导航、截图与写入的耗时，以便定位首屏等待。日志不记录网页地址、输入、Cookie、token、安装输出或 SDK 原始错误。准备回执只包含资源 ID、版本名称、固定阶段和固定错误码。

创建前先记录意图并全局限制最多 2 个未确认销毁的环境。创建响应返回 VM ID 后立即持久记录，即使用户已停止任务也保留清理目标；不等待 SDK 的启动就绪阶段。确认销毁或确认资源不存在后才释放记录；清理失败保留记录并由后续 Worker 调度继续处理。无法确定创建结果时不重复创建、不把记录当作成功销毁，也不猜测或删除其他 VM。任务结束、租约失效、心跳中断或过期的已知环境会进入清理。

VM 运行消耗现有 Railway 账号的按量资源，等待用户接管也会占用资源；销毁后停止该 VM 的计算用量。模型调用仍单独走中央模型与用量记录。此功能不购买 Windows 云电脑、不修改 Railway 套餐或取消账号费用限制。价格与平台空闲机制以 [Railway Sandboxes 文档](https://docs.railway.com/sandboxes) 为准。

## 启动诊断与状态时效

Worker 仅把有限的启动错误转换成固定诊断码，不记录原始 Chromium 错误、启动命令、路径或环境变量。运行状态保存 `BROWSER_TEMPLATE_UNAVAILABLE`（预构建基础环境缺失或版本不匹配）、`BROWSER_SANDBOX_UNAVAILABLE`（沙箱权限限制）、`BROWSER_EXECUTABLE_MISSING`（程序缺失）、`BROWSER_DEPENDENCIES_MISSING`（运行依赖缺失）或通用的 `BROWSER_RUNTIME_UNAVAILABLE`。

API 仅在运行状态心跳距今不足30秒且 `ready=false` 时，将已知码映射为固定中文提示；未知数据库内容不会直接回显，过期心跳也不会继续展示旧的具体诊断。检查恢复成功后清空旧码。浏览器服务诊断不包含其他账号信息，任务、profile 与接管画面仍按当前登录账号隔离。

出现隔离运行错误时，需要检查宿主是否允许 Chromium 所需的沙箱/用户命名空间，以及非 root 运行身份和镜像部署情况；某些托管实例会在内核层拒绝相关操作，入口切换用户不等于解除该限制。不要把关闭 sandbox 当作修复。程序或运行组件缺失时核对构建时 Playwright 浏览器安装版本和系统依赖。未知错误保持通用状态，由管理员在受控环境定位，不把原始日志复制到用户界面。

## 网络与会话

每个浏览器通过临时、带认证的本地出站代理访问 HTTP/HTTPS 公网。代理逐连接解析并验证全部 DNS 地址，将实际 socket 固定到已核验的数值 IP；拒绝内网、回环、链路本地、云元数据及非标准端口。Chromium 不允许代理失败后直连，显式取消其默认回环代理绕过，并禁用非代理 UDP、QUIC 和 Service Worker。不要把其他服务的凭据或内部地址放入页面目标。

登录态以 AES-256-GCM 加密保存，包含 Cookie、localStorage 和 IndexedDB；自最后一次成功保存起可复用 30 天，不代表目标网站保证登录 30 天有效。清除登录态会取消会话、增加状态版本并删除密文，迟到保存不能恢复旧会话。接管输入加密暂存，消费后立即清空载荷；同一画面仅消费一次输入，实际执行成功后才把 requestId 绑定到新截图。导航独立使用 epoch，不伪造坐标画面。截图仅经本人认证的 `no-store` 接口返回。自动目标完成后保留新截图及当前浏览器，回到 BROWSE；明确关闭或闲置到期才结束会话，保留的最终截图只读 24 小时。清除登录态也删除截图。

轮询得到完全相同的画面时，在原始 15 秒期限内复用同一 frameId，避免跨网络延迟下静态页面的点击总被下一次截图拒绝。复用同时要求 JPEG、实际页面及文档身份、完整 URL、视口尺寸和滚动位置一致；同网址重载、真实输入、导航或 epoch 变化都会使旧标识失效，重复发布不延长原始 frame_at。点击仍必须匹配当前账号、租约、epoch 和未消费的当前帧，内部 RPC 还核验已发布的画面 revision，不能借未发布的新截图执行旧坐标。动态画面真实变化时仍会保守拒绝旧帧，不自动重试点击。

## 运行限制与验收

每个 Worker 最多并行运行 2 个账号的独立浏览器；Railway 模式另有全局 2 个未确认销毁环境上限。每账号一个活跃会话，从建立起最长 30 分钟，包括排队、启动、暂停和接管时间。每个自动目标最多 60 步；停止目标回到直接浏览，关闭标签才终止会话。BROWSE 在 5 分钟无用户操作后关闭；首次可用画面不会消耗用户空闲期，轮询、截图和心跳不延长空闲时间。暂停/需要接管时停止模型规划，恢复后重新观察。清除登录态、权限撤销、租约失效或进程中断均关闭浏览器，不重放输入。

部署验收应分别核对：浏览器实际沙箱启动、Worker 心跳、无配置不回退本机、公开网页实际加载、每账号会话隔离、同一画面只消费一次接管输入、暂停/停止期间迟到结果不执行，以及新 `assistant_browser` 用量行的实际回执。模型验证、浏览器就绪和目标网站登录是不同状态；不能以其中一项成功替代其他项。
