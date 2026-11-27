import {
  AudioOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  FileTextOutlined,
  ShoppingOutlined,
  SoundOutlined,
  UserOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import {
  directorRoles,
  type DirectorAsset,
} from "../../../packages/contracts/src/director";
import { roleNames } from "./director-project";

type AssetRole = DirectorAsset["role"];
export type DirectorAssetFilter = AssetRole | "all";

const roleIcons = {
  product: ShoppingOutlined,
  portrait: UserOutlined,
  voiceSample: SoundOutlined,
  narration: AudioOutlined,
  reference: VideoCameraOutlined,
  document: FileTextOutlined,
} satisfies Record<AssetRole, typeof ShoppingOutlined>;

export function DirectorAssetRoleBadge({ role }: { role: AssetRole }) {
  const Icon = roleIcons[role];
  return (
    <span className="director-role-badge" data-role={role}>
      <Icon aria-hidden /> {roleNames[role]}
    </span>
  );
}

export function DirectorAssetAuthorization({
  asset,
}: {
  asset: Pick<DirectorAsset, "role" | "authorized">;
}) {
  if (asset.role !== "portrait" && asset.role !== "voiceSample") return null;
  return (
    <span
      className="director-role-authorization"
      data-confirmed={!!asset.authorized}
    >
      {asset.authorized ? (
        <CheckCircleOutlined aria-hidden />
      ) : (
        <ClockCircleOutlined aria-hidden />
      )}
      {asset.authorized ? "已确认授权" : "待确认授权"}
    </span>
  );
}

export function DirectorAssetRoleFilters({
  assets,
  value,
  onChange,
}: {
  assets: DirectorAsset[];
  value: DirectorAssetFilter;
  onChange: (role: DirectorAssetFilter) => void;
}) {
  const counts = new Map<AssetRole, number>();
  for (const asset of assets)
    counts.set(asset.role, (counts.get(asset.role) ?? 0) + 1);
  return (
    <div className="director-role-filters" role="group" aria-label="按用途筛选">
      <div className="director-role-filter-heading">
        <strong>按用途筛选</strong>
        <button
          type="button"
          aria-pressed={value === "all"}
          onClick={() => onChange("all")}
        >
          全部 <span className="director-role-count">{assets.length}</span>
        </button>
      </div>
      <div className="director-role-options">
        {directorRoles.map((role) => {
          const Icon = roleIcons[role];
          return (
            <button
              key={role}
              type="button"
              data-role={role}
              aria-pressed={value === role}
              onClick={() => onChange(role)}
            >
              <Icon aria-hidden />
              {roleNames[role]}{" "}
              <span className="director-role-count">
                {counts.get(role) ?? 0}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
