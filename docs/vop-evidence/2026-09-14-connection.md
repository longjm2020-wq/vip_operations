# VOP 接入准备记录 · 2026-09-14

## 已核实

- 用户实际应用后台：标签为供应商自研应用，应用审核通过，JIT+JITX 权限包已获得；权限列表列出240项，包含旧版/新版/特定业务接口，不代表每项均适用本供应商。
- 官方协议：https://vop.vip.com/doccenter/viewdoc/8 。系统参数按名称排序，连接参数名和值及原始JSON请求体，HMAC-MD5大写签名；时间戳秒级，正式入口HTTPS。
- 健康接口：https://vop.vip.com/home#/api/method/detail/vipapis.inventory.InventoryService-1.0.0/healthCheck 。不需要OAuth授权、无业务请求参数，响应success为CheckResult。仅用于网关/签名准备，不证明商品或订单访问权限。
- 当前供应商认证入口：https://vop.vip.com/doccenter/viewdoc/93 ，VIS主账号的VOP授权管理→授权账号。不能从应用审核结果推出供应商ID；不自动更换已有绑定。
- OAuth通用说明：https://vop.vip.com/doccenter/viewdoc/33 。是否用于此自研应用及具体接口，须结合供应商绑定和真实查询验证，不盲目创建OAuth回调或令牌。

## 已准备的代码

VIS 授权账号页面已核实：供应商身份与当前 VOP 开发者账号存在有效绑定，无需重新关联。具体账号和供应商标识保存在本机忽略文件，不写入源码。

独立的 `scripts/vop-probe.ts` 使用环境变量 `VOP_APP_KEY` / `VOP_APP_SECRET`，可从Git忽略的 `.env.vop` 读取。只允许固定healthCheck调用，不读取客户订单、不改动数据库或平台库存，不自动重试，15秒为本地诊断超时而非平台限流规则。运行方式：`pnpm exec tsx scripts/vop-probe.ts`。

真实密钥由用户在本机或Railway安全配置中输入，不通过聊天/代码仓库传递。程序不输出原始响应、签名URL、密钥。`gatewayResponseReceived`仅说明收到预期响应信封，不能宣称CheckResult健康或供应商访问已验证。

## 待完成

真实密钥配置；真实healthCheck；首个供应商范围的只读查询及响应契约；必要授权、调用额度、分页/增量与字段映射验证。未完成前 `VIP_MODE=disabled`、`SALES_SOURCE=unavailable` 保留，不自动开启同步。

本地验证：lint、typecheck、17项单元测试通过（包含5项签名和安全诊断测试）。尚未执行真实平台调用。

## 首次真实连接检查

用户配置密钥后已执行 healthCheck。网关返回 HTTP 200，但响应为 `returnCode` / `returnMessage`，错误码 `vipapis.ip-in-blackList`，表示调用来源 IP 不在白名单。此结果不证明密钥、签名或业务授权有效。已补充该网关信封的安全错误映射与回归测试。需经用户确认添加指定测试出口 IP 后再试；生产部署应另行核实实际执行服务的出口 IP，不能使用 Web 公网域名解析地址代替。

用户随后明确批准添加单个测试出口 IP，平台已显示创建成功。再次调用返回 HTTP 200、`returnCode: "0"`、`result: null`。已修正成功信封解析，并再次真实运行得到 `gatewayResponseReceived: true`。这仅确认本机 healthCheck 请求被网关接受，不证明 CheckResult 健康或供应商业务数据访问。19项单元测试通过；业务查询、Railway 出口及生产密钥配置、同步仍待完成。

## 供应商业务查询与生产出口核对

- 已读取官方 `vipapis.brand.BrandService-1.0.0/getVendorBrandRelationshipByVendorId` 页面：业务参数仅必填整数 `vendor_id`，响应声明为品牌关系列表，页面标注“不需要授权”。文档地址：https://vop.vip.com/home#/api/method/detail/vipapis.brand.BrandService-1.0.0/getVendorBrandRelationshipByVendorId 。
- 使用已由 VIS 核实的供应商 ID 执行一次只读查询，实际返回 `vipapis.oauth-invalidate-failure`，未返回品牌数据。实际错误与方法页面授权标注存在差异；不能推断业务授权已完成，也不能将其当作空数据。需登录后核对当前应用授权，并按官方 OAuth 流程取得必要授权：https://vop.vip.com/doccenter/viewdoc/33 。
- Railway 项目五个服务均显示 Online，Worker 仍连接 main；当前工作区处于试用状态，设置页没有静态出口选项。官方静态出口功能要求 Pro，启用后须记录该服务列出的全部 IPv4 地址、添加平台白名单并重新部署：https://docs.railway.com/networking/static-outbound-ips 。不能使用本机测试出口替代生产出口。
- 同步尚未实现或启用；现有 Worker 仅处理内部健康检查任务。完成授权、出口与生产凭据配置后，才可验证实际业务响应，并据此实现数据适配、幂等入库、失败恢复和逐项验收。

## 后续生产网络与 OAuth 准备

用户已订阅 Pro。Worker 固定出口已开启，分配的三个生产 IPv4 地址经用户逐项范围确认后全部加入 VOP 白名单，原本机测试地址保留。Worker 重新部署 `e0802638-869c-4180-b4e1-5731c8f91cdd` 已 Active，日志显示 Worker ready；尚未在该实例执行真实 VOP 调用。

`scripts/vop-oauth.ts prepare` 创建随机 state 和本机授权尝试记录，使用已注册 HTTPS 回调地址。用户完成授权后，将完整返回地址保存至 Git 忽略的 `.local/vop-oauth-return.txt`，运行 `scripts/vop-oauth.ts exchange` 校验来源、路径、state、重复参数及本机尝试时效，通过 HTTPS POST 向官方 token 端点交换令牌。官方授权码有效期5分钟，必须及时交换；本机尝试15分钟上限不是平台授权码有效期。state 缺失或不匹配不得绕过校验。

令牌只保存本机 Git 忽略的 `.local/vop-token.json`，不输出到终端或聊天，不自动上传生产。该文件是明文本机凭据文件，须按密钥保护。生产令牌存储、刷新与同步调度尚待实现。授权程序已通过单元测试、类型检查和 lint，整个单元测试集23项通过。

## OAuth 与首个业务查询已验证

用户在官方授权页完成操作后返回衣序首页，前端重定向到 products 并清除了查询参数。通过该次浏览器跳转记录恢复原始回调，验证 state 与回调地址后，在授权码有效期内成功换取访问令牌及刷新令牌。凭据保存在本机忽略目录，未输出明文。

携带 accessToken 再次调用供应商品牌关系查询：首次请求出现未分类的读取失败，随后一次重试返回 HTTP 200、returnCode 0、品牌关系列表1条。真实结果字段为 brand_name_eng、vendor_id、vendor_name、brand_name、brand_id；仅保存字段名和数量作为证据，无商品、订单、库存同步完成的含义。

本机 `.local/vop-production.env` 已准备给用户输入 Railway Worker。应用标识与供应商ID已在 Worker 暂存为变量变更，敏感凭据等待用户粘贴；尚未部署此批配置。现有前端不具备自动处理 OAuth 回调能力，后续需实现正式回调与生产令牌生命周期管理。

## Railway 生产连接已验证

用户粘贴六项 VOP 环境变量后，已核对名称并部署。新部署 `52fea353-8b39-4be8-8548-0c4e54cfd12d` 状态 Active，控制台连接新实例 `ec0d8cb2-f81e-4906-a150-a6e5408f67ce`。通过该实例 Node 进程从环境读取凭据，签名调用供应商品牌关系接口，输出仅包含安全摘要：HTTP 200、success true、brandCount 1、vendorMatches true。未输出令牌、密钥或品牌原始记录。

该验证确认生产固定出口与平台白名单、应用凭据及供应商 OAuth 令牌共同可用。生产 main 仍为原内部管理系统版本，Worker 仍只监听内部健康检查队列；本次手动只读查询没有写数据库。数据同步、增量分页、正式授权回调、持久化令牌刷新及业务适配尚未实现。
