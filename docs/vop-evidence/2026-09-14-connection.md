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
