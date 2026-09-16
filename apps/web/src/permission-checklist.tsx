import { Checkbox, Space, Typography } from "antd";
const modules: Record<string, string> = {
  supply: "供应链端",
  user: "用户管理",
  role: "角色权限",
  product: "商品与基础资料",
  supplier: "供应商",
  warehouse: "仓库",
  inventory: "库存",
  purchase: "采购",
  receipt: "到货入库",
  audit: "操作日志",
  vip: "唯品会接入",
  project: "项目管理",
  sop: "操作流程 SOP",
};
export const permissionLabels: Record<string, string> = {
  "supply.portal": "供应商企业资质与产品库",
  "supply.review": "入驻、资质审核及邀请码管理",
  "supply.manage": "查看供应链产品与维护序缇款号",
  "user.read": "查看用户",
  "user.manage": "管理用户与重置密码",
  "role.read": "查看角色",
  "role.manage": "管理角色与权限",
  "product.read": "查看商品、SKU及基础资料",
  "product.create": "新建商品与基础资料",
  "product.update": "修改商品与基础资料",
  "supplier.read": "查看供应商",
  "supplier.manage": "管理供应商",
  "warehouse.read": "查看仓库",
  "warehouse.manage": "管理仓库",
  "inventory.read": "查看库存与流水",
  "inventory.adjust": "调整库存",
  "purchase.read": "查看采购",
  "purchase.suggest": "生成采购建议",
  "purchase.create": "创建采购单",
  "purchase.update": "修改采购单",
  "purchase.submit": "提交采购单",
  "purchase.confirm": "确认采购单",
  "purchase.cancel": "取消采购单",
  "receipt.read": "查看入库单",
  "receipt.create": "创建入库单",
  "receipt.update": "修改入库单",
  "receipt.post": "入库过账",
  "audit.read": "查看操作日志",
  "vip.settings": "管理唯品会接入与同步",
  "project.read": "查看项目",
  "project.create": "创建与管理本人项目",
  "sop.manage": "管理流程模板",
};
export function PermissionChecklist({
  value = [],
  onChange,
  codes,
  disabled = false,
}: {
  value?: string[];
  onChange?: (v: string[]) => void;
  codes: string[];
  disabled?: boolean;
}) {
  const toggle = (items: string[], checked: boolean) =>
    onChange?.(
      checked
        ? [...new Set([...value, ...items])]
        : value.filter((v) => !items.includes(v)),
    );
  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      <Checkbox
        disabled={disabled || !codes.length}
        checked={!!codes.length && codes.every((c) => value.includes(c))}
        indeterminate={
          codes.some((c) => value.includes(c)) &&
          !codes.every((c) => value.includes(c))
        }
        onChange={(e) => toggle(codes, e.target.checked)}
      >
        全部权限（已选 {value.length} 项）
      </Checkbox>
      {Object.entries(modules).map(([prefix, label]) => {
        const items = codes.filter((c) => c.split(".")[0] === prefix);
        if (!items.length) return null;
        return (
          <div
            key={prefix}
            style={{
              border: "1px solid #eaded3",
              borderRadius: 6,
              padding: 10,
              width: "100%",
            }}
          >
            <Checkbox
              disabled={disabled}
              checked={items.every((c) => value.includes(c))}
              indeterminate={
                items.some((c) => value.includes(c)) &&
                !items.every((c) => value.includes(c))
              }
              onChange={(e) => toggle(items, e.target.checked)}
            >
              <Typography.Text strong>{label}</Typography.Text>
            </Checkbox>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))",
                gap: 8,
                marginTop: 8,
                paddingLeft: 24,
              }}
            >
              {items.map((c) => (
                <Checkbox
                  key={c}
                  disabled={disabled}
                  checked={value.includes(c)}
                  onChange={(e) => toggle([c], e.target.checked)}
                >
                  {permissionLabels[c] || c}
                </Checkbox>
              ))}
            </div>
          </div>
        );
      })}
    </Space>
  );
}
