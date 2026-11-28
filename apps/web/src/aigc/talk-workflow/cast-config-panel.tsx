import { useMemo } from "react";
import { Alert, Button, Checkbox, Select, Space, Tag } from "antd";
import {
  AppstoreOutlined,
  EnvironmentOutlined,
  SaveOutlined,
  ShoppingOutlined,
  SkinOutlined,
  ThunderboltOutlined,
  ToolOutlined,
  UserOutlined,
} from "@ant-design/icons";
import type { DigitalHumanCharacter } from "../../../../../packages/contracts/src/commerce-talk-workflow";
import {
  recommendPropsAndGarmentsByStory,
  sceneStylePresets40,
} from "./asset-libraries";
import {
  GarmentLibraryPanel,
  PropLibraryPanel,
  SceneLibraryPanel,
} from "./asset-library-panels";
import { CharacterLibraryPanel } from "./character-library";
import type { WorkflowView } from "./types";

export type CastSubTab =
  | "overview"
  | "characters"
  | "garments"
  | "props"
  | "scenes";

export type ProductOption = {
  id: string;
  styleNo: string;
  name: string;
  images: Array<{ id: string; url: string; color?: string }>;
};

/**
 * 参演配置分栏面板（参照剪映专业版左分类侧栏 + 右内容区布局）：
 * 将「配置总览 / 产品主体」「角色库」「服饰库」「道具库」「场景库」统一收口在一处。
 */
export function CastConfigPanel({
  account,
  canUseCommerce,
  subTab,
  onSubTabChange,
  draft,
  characters,
  productOptions,
  selectedProduct,
  disabled,
  saving,
  advancing,
  onToggleCharacter,
  onProductSearch,
  onSelectProduct,
  onUploadAsset,
  onToggleKeyword,
  onApplyRecommended,
  onSaveOnly,
  onSaveAndScript,
}: {
  account: string;
  canUseCommerce: boolean;
  subTab: CastSubTab;
  onSubTabChange: (tab: CastSubTab) => void;
  draft: WorkflowView | null;
  characters: readonly DigitalHumanCharacter[];
  productOptions: ProductOption[];
  selectedProduct?: ProductOption;
  disabled: boolean;
  saving: boolean;
  advancing: boolean;
  onToggleCharacter: (characterId: string, checked: boolean) => void;
  onProductSearch: (q: string) => void;
  onSelectProduct: (productId?: string) => void;
  onUploadAsset: (slot: "prop" | "scene" | "garment", file: File) => void;
  onToggleKeyword: (
    field: "sceneKeywords" | "propKeywords" | "garmentKeywords",
    keyword: string,
  ) => void;
  onApplyRecommended: (
    field: "propKeywords" | "garmentKeywords",
    keywords: string[],
  ) => void;
  onSaveOnly: () => void;
  onSaveAndScript: () => void;
}) {
  const boundCharIds = draft?.assetsConfig.characterLibraryIds || [];
  const sceneKeywords = draft?.assetsConfig.sceneKeywords || [];
  const propKeywords = draft?.assetsConfig.propKeywords || [];
  const garmentKeywords = draft?.assetsConfig.garmentKeywords || [];

  const charCount = boundCharIds.length;
  const garmentCount =
    garmentKeywords.length +
    (draft?.assetsConfig.garments?.length || 0) +
    (draft?.assetsConfig.productId ? 1 : 0);
  const propCount =
    propKeywords.length + (draft?.assetsConfig.props?.length || 0);
  const sceneCount =
    sceneKeywords.length + (draft?.assetsConfig.scenes?.length || 0);

  const storyContext = [
    draft?.title,
    draft?.assetsConfig.creativeBrief,
    draft?.deconstructData?.summary || "",
    draft?.deconstructData?.hook || "",
  ]
    .filter(Boolean)
    .join(" ");

  const smartRec = useMemo(
    () => recommendPropsAndGarmentsByStory(storyContext),
    [storyContext],
  );

  const navItems: Array<{
    key: CastSubTab;
    label: string;
    icon: React.ReactNode;
    count?: number;
  }> = [
    { key: "overview", label: "总览绑定", icon: <AppstoreOutlined /> },
    {
      key: "characters",
      label: "角色库",
      icon: <UserOutlined />,
      count: charCount,
    },
    {
      key: "garments",
      label: "服饰库",
      icon: <SkinOutlined />,
      count: garmentCount,
    },
    {
      key: "props",
      label: "道具库",
      icon: <ToolOutlined />,
      count: propCount,
    },
    {
      key: "scenes",
      label: "场景库",
      icon: <EnvironmentOutlined />,
      count: sceneCount,
    },
  ];

  return (
    <div className="wf-cast-split" aria-label="参演配置面板">
      {/* 左侧二级分类导航（参照剪映专业版二级侧栏） */}
      <nav
        className="wf-cast-sidebar"
        role="tablist"
        aria-orientation="vertical"
        aria-label="参演配置分类"
      >
        {navItems.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={subTab === item.key}
            className={`wf-cast-nav-item${subTab === item.key ? " is-active" : ""}`}
            onClick={() => onSubTabChange(item.key)}
          >
            <span className="wf-cast-nav-label">
              {item.icon}
              <span>{item.label}</span>
            </span>
            {typeof item.count === "number" && item.count > 0 && (
              <span className="wf-cast-nav-badge">{item.count}</span>
            )}
          </button>
        ))}
      </nav>

      {/* 右侧具体配置内容区 */}
      <div className="wf-cast-main">
        {subTab === "overview" && (
          !draft ? (
            <Alert
              type="info"
              showIcon
              title="请先在「导入」页新建或打开工作流后再绑定参演配置，或直接切左侧「角色库」预先管理角色。"
            />
          ) : (
            <>
              <div className="wf-cast-overview-head">
                <div className="wf-cast-overview-title">
                  <strong>② 参演配置总览</strong>
                  <span className="wf-muted">
                    绑定角色、产品主体、服饰、道具与场景后，可直接生成分镜脚本
                  </span>
                </div>
                <Space wrap size={6}>
                  <Button
                    size="small"
                    icon={<SaveOutlined />}
                    loading={saving}
                    disabled={disabled || advancing}
                    onClick={onSaveOnly}
                  >
                    保存配置
                  </Button>
                  <Button
                    size="small"
                    type="primary"
                    icon={<ThunderboltOutlined />}
                    loading={advancing}
                    disabled={disabled || saving}
                    onClick={onSaveAndScript}
                  >
                    保存并生成脚本
                  </Button>
                </Space>
              </div>

              {/* 1. 参演角色 */}
              <div className="wf-cast-block">
                <div className="wf-cast-block-head">
                  <span>
                    <UserOutlined /> 参演角色（{boundCharIds.length}）
                  </span>
                  <Button
                    size="small"
                    type="link"
                    onClick={() => onSubTabChange("characters")}
                  >
                    管理角色库
                  </Button>
                </div>
                {characters.length ? (
                  <div className="wf-asset-chips">
                    {characters.map((ch) => {
                      const checked = boundCharIds.includes(ch.id);
                      return (
                        <label key={ch.id} className="wf-cast-check-chip">
                          <Checkbox
                            checked={checked}
                            disabled={disabled}
                            onChange={(e) =>
                              onToggleCharacter(ch.id, e.target.checked)
                            }
                          />
                          <span>{ch.name}</span>
                          {ch.voiceName && <small>· {ch.voiceName}</small>}
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <p className="wf-muted">
                    暂无角色库角色，点击左侧「角色库」新建多视图数字人。
                  </p>
                )}
              </div>

              {/* 2. 产品主体 */}
              <div className="wf-cast-block">
                <div className="wf-cast-block-head">
                  <span>
                    <ShoppingOutlined /> 产品主体（商品档案）
                  </span>
                  {draft.assetsConfig.productStyleNo && (
                    <Tag color="blue" style={{ margin: 0 }}>
                      {draft.assetsConfig.productStyleNo}
                    </Tag>
                  )}
                </div>
                <Select
                  size="small"
                  showSearch
                  allowClear
                  filterOption={false}
                  style={{ width: "100%" }}
                  aria-label="绑定产品主体款号"
                  placeholder="搜索并绑定商品款号作为核心产品主体"
                  value={draft.assetsConfig.productId}
                  disabled={disabled}
                  onSearch={onProductSearch}
                  options={productOptions.map((p) => ({
                    value: p.id,
                    label: `${p.styleNo} · ${p.name}`,
                  }))}
                  onChange={onSelectProduct}
                />
                {selectedProduct?.images?.length ? (
                  <div className="wf-asset-chips">
                    {selectedProduct.images.slice(0, 4).map((img) => (
                      <div key={img.id} className="wf-asset-chip">
                        <img src={img.url} alt={img.color || "产品主图"} />
                        <span>{img.color || "主图"}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>

              {/* 3. 参演服饰 */}
              <div className="wf-cast-block">
                <div className="wf-cast-block-head">
                  <span>
                    <SkinOutlined /> 参演服饰（
                    {garmentKeywords.length +
                      (draft.assetsConfig.garments?.length || 0)}
                    ）
                  </span>
                  <Space size={2}>
                    <Button
                      size="small"
                      type="link"
                      disabled={disabled}
                      onClick={() =>
                        onApplyRecommended(
                          "garmentKeywords",
                          smartRec.garments.slice(0, 3),
                        )
                      }
                    >
                      智能匹配（{smartRec.matchedGenre}）
                    </Button>
                    <Button
                      size="small"
                      type="link"
                      onClick={() => onSubTabChange("garments")}
                    >
                      服饰库
                    </Button>
                  </Space>
                </div>
                <div className="wf-asset-chips">
                  {garmentKeywords.map((kw) => (
                    <Tag
                      key={kw}
                      color="blue"
                      closable={!disabled}
                      onClose={() => onToggleKeyword("garmentKeywords", kw)}
                      style={{ margin: 0 }}
                    >
                      {kw}
                    </Tag>
                  ))}
                  {(draft.assetsConfig.garments || []).map((g) => (
                    <div key={g.id} className="wf-asset-chip">
                      {g.url && <img src={g.url} alt={g.name} />}
                      <span>{g.name}</span>
                    </div>
                  ))}
                  {!garmentKeywords.length &&
                    !(draft.assetsConfig.garments || []).length && (
                      <span className="wf-muted">
                        未绑定服饰，可点击上方「智能匹配」或切到左侧「服饰库」挑选。
                      </span>
                    )}
                </div>
              </div>

              {/* 4. 参演道具 */}
              <div className="wf-cast-block">
                <div className="wf-cast-block-head">
                  <span>
                    <ToolOutlined /> 参演道具（
                    {propKeywords.length +
                      (draft.assetsConfig.props?.length || 0)}
                    ）
                  </span>
                  <Space size={2}>
                    <Button
                      size="small"
                      type="link"
                      disabled={disabled}
                      onClick={() =>
                        onApplyRecommended(
                          "propKeywords",
                          smartRec.props.slice(0, 4),
                        )
                      }
                    >
                      智能匹配（{smartRec.matchedGenre}）
                    </Button>
                    <Button
                      size="small"
                      type="link"
                      onClick={() => onSubTabChange("props")}
                    >
                      道具库
                    </Button>
                  </Space>
                </div>
                <div className="wf-asset-chips">
                  {propKeywords.map((kw) => (
                    <Tag
                      key={kw}
                      color="blue"
                      closable={!disabled}
                      onClose={() => onToggleKeyword("propKeywords", kw)}
                      style={{ margin: 0 }}
                    >
                      {kw}
                    </Tag>
                  ))}
                  {(draft.assetsConfig.props || []).map((p) => (
                    <div key={p.id} className="wf-asset-chip">
                      {p.url && <img src={p.url} alt={p.name} />}
                      <span>{p.name}</span>
                    </div>
                  ))}
                  {!propKeywords.length &&
                    !(draft.assetsConfig.props || []).length && (
                      <span className="wf-muted">
                        未绑定道具，可点击上方「智能匹配」或切到左侧「道具库」挑选。
                      </span>
                    )}
                </div>
              </div>

              {/* 5. 拍摄场景 */}
              <div className="wf-cast-block">
                <div className="wf-cast-block-head">
                  <span>
                    <EnvironmentOutlined /> 拍摄场景（
                    {sceneKeywords.length +
                      (draft.assetsConfig.scenes?.length || 0)}
                    ）
                  </span>
                  <Button
                    size="small"
                    type="link"
                    onClick={() => onSubTabChange("scenes")}
                  >
                    40 种风格场景库
                  </Button>
                </div>
                <Select
                  size="small"
                  showSearch
                  style={{ width: "100%" }}
                  placeholder="快速从 40 种风格关键词场景中添加..."
                  disabled={disabled}
                  value={null}
                  options={sceneStylePresets40.map((s) => ({
                    value: `${s.name}：${s.keywords}`,
                    label: `[${s.category}] ${s.name}`,
                  }))}
                  onChange={(val) => {
                    if (val && !sceneKeywords.includes(val)) {
                      onToggleKeyword("sceneKeywords", val);
                    }
                  }}
                />
                <div className="wf-asset-chips">
                  {sceneKeywords.map((kw) => (
                    <Tag
                      key={kw}
                      color="blue"
                      closable={!disabled}
                      onClose={() => onToggleKeyword("sceneKeywords", kw)}
                      style={{ margin: 0 }}
                    >
                      {kw}
                    </Tag>
                  ))}
                  {(draft.assetsConfig.scenes || []).map((s) => (
                    <div key={s.id} className="wf-asset-chip">
                      {s.url && <img src={s.url} alt={s.name} />}
                      <span>{s.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )
        )}

        {subTab === "characters" && (
          <CharacterLibraryPanel
            account={account}
            enabled={canUseCommerce}
            boundIds={draft?.assetsConfig.characterLibraryIds || []}
            disabled={disabled}
            onToggleBind={draft ? onToggleCharacter : undefined}
          />
        )}

        {subTab === "garments" && (
          <GarmentLibraryPanel
            draft={draft}
            disabled={disabled}
            productOptions={productOptions}
            selectedProduct={selectedProduct}
            onProductSearch={onProductSearch}
            onSelectProduct={onSelectProduct}
            onUploadGarment={(file) => onUploadAsset("garment", file)}
            onToggleKeyword={(kw) => onToggleKeyword("garmentKeywords", kw)}
            onApplyRecommended={(kws) =>
              onApplyRecommended("garmentKeywords", kws)
            }
          />
        )}

        {subTab === "props" && (
          <PropLibraryPanel
            draft={draft}
            disabled={disabled}
            onUploadProp={(file) => onUploadAsset("prop", file)}
            onToggleKeyword={(kw) => onToggleKeyword("propKeywords", kw)}
            onApplyRecommended={(kws) => onApplyRecommended("propKeywords", kws)}
          />
        )}

        {subTab === "scenes" && (
          <SceneLibraryPanel
            draft={draft}
            disabled={disabled}
            onUploadScene={(file) => onUploadAsset("scene", file)}
            onToggleKeyword={(kw) => onToggleKeyword("sceneKeywords", kw)}
            onAddCustomKeyword={(kw) => onToggleKeyword("sceneKeywords", kw)}
          />
        )}
      </div>
    </div>
  );
}
