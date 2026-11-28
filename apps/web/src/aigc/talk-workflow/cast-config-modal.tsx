import { useMemo } from "react";
import { Button, Checkbox, Modal, Select, Space, Tag } from "antd";
import {
  EnvironmentOutlined,
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
import type { WorkflowView } from "./types";

type ProductOption = {
  id: string;
  styleNo: string;
  name: string;
  images: Array<{ id: string; url: string; color?: string }>;
};

/**
 * 参演配置弹窗（位于 ① 拆解 与 ③ 脚本 之间）：
 * 一站式完成本条视频的参演角色、产品主体、服饰、道具、场景配置绑定。
 */
export function CastConfigModal({
  open,
  draft,
  characters,
  productOptions,
  selectedProduct,
  disabled,
  saving,
  advancing,
  onClose,
  onJumpTab,
  onToggleCharacter,
  onProductSearch,
  onSelectProduct,
  onToggleKeyword,
  onApplyRecommended,
  onSaveOnly,
  onSaveAndScript,
}: {
  open: boolean;
  draft: WorkflowView;
  characters: readonly DigitalHumanCharacter[];
  productOptions: ProductOption[];
  selectedProduct?: ProductOption;
  disabled: boolean;
  saving: boolean;
  advancing: boolean;
  onClose: () => void;
  onJumpTab: (tab: "characters" | "scenes" | "props" | "garments") => void;
  onToggleCharacter: (characterId: string, checked: boolean) => void;
  onProductSearch: (q: string) => void;
  onSelectProduct: (productId?: string) => void;
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
  const boundCharIds = draft.assetsConfig.characterLibraryIds || [];
  const sceneKeywords = draft.assetsConfig.sceneKeywords || [];
  const propKeywords = draft.assetsConfig.propKeywords || [];
  const garmentKeywords = draft.assetsConfig.garmentKeywords || [];

  const storyContext = [
    draft.title,
    draft.assetsConfig.creativeBrief,
    draft.deconstructData?.summary || "",
    draft.deconstructData?.hook || "",
  ]
    .filter(Boolean)
    .join(" ");

  const smartRec = useMemo(
    () => recommendPropsAndGarmentsByStory(storyContext),
    [storyContext],
  );

  return (
    <Modal
      open={open}
      width={760}
      title="② 参演配置（角色 / 产品主体 / 服饰 / 道具 / 场景绑定）"
      onCancel={onClose}
      footer={
        <Space>
          <Button onClick={onClose} disabled={saving || advancing}>
            关闭
          </Button>
          <Button loading={saving} disabled={disabled || advancing} onClick={onSaveOnly}>
            保存参演配置
          </Button>
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            loading={advancing}
            disabled={disabled || saving}
            onClick={onSaveAndScript}
          >
            保存并生成脚本（③ 脚本）
          </Button>
        </Space>
      }
    >
      <div className="wf-cast-grid">
        {/* 1. 参演角色绑定 */}
        <div className="wf-cast-block">
          <div className="wf-cast-block-head">
            <span>
              <UserOutlined /> 参演角色（{boundCharIds.length}）
            </span>
            <Button
              size="small"
              type="link"
              onClick={() => {
                onClose();
                onJumpTab("characters");
              }}
            >
              去角色库管理
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
                      onChange={(e) => onToggleCharacter(ch.id, e.target.checked)}
                    />
                    <span>{ch.name}</span>
                    {ch.voiceName && <small>· {ch.voiceName}</small>}
                  </label>
                );
              })}
            </div>
          ) : (
            <p className="wf-muted">暂无角色库角色，可点右上角「去角色库管理」新建多视图数字人。</p>
          )}
        </div>

        {/* 2. 产品主体绑定 */}
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

        {/* 3. 参演服饰绑定 */}
        <div className="wf-cast-block">
          <div className="wf-cast-block-head">
            <span>
              <SkinOutlined /> 参演服饰（{garmentKeywords.length + (draft.assetsConfig.garments?.length || 0)}）
            </span>
            <Space size={4}>
              <Button
                size="small"
                type="link"
                disabled={disabled}
                onClick={() =>
                  onApplyRecommended("garmentKeywords", smartRec.garments.slice(0, 3))
                }
              >
                按剧情智能匹配（{smartRec.matchedGenre}）
              </Button>
              <Button
                size="small"
                type="link"
                onClick={() => {
                  onClose();
                  onJumpTab("garments");
                }}
              >
                去服饰库
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
            {!garmentKeywords.length && !(draft.assetsConfig.garments || []).length && (
              <span className="wf-muted">未绑定服饰，可点击上方「按剧情智能匹配」或前往服饰库挑选。</span>
            )}
          </div>
        </div>

        {/* 4. 参演道具绑定 */}
        <div className="wf-cast-block">
          <div className="wf-cast-block-head">
            <span>
              <ToolOutlined /> 参演道具（{propKeywords.length + (draft.assetsConfig.props?.length || 0)}）
            </span>
            <Space size={4}>
              <Button
                size="small"
                type="link"
                disabled={disabled}
                onClick={() =>
                  onApplyRecommended("propKeywords", smartRec.props.slice(0, 4))
                }
              >
                按剧情智能匹配（{smartRec.matchedGenre}）
              </Button>
              <Button
                size="small"
                type="link"
                onClick={() => {
                  onClose();
                  onJumpTab("props");
                }}
              >
                去道具库
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
            {!propKeywords.length && !(draft.assetsConfig.props || []).length && (
              <span className="wf-muted">未绑定道具，可点击上方「按剧情智能匹配」或前往道具库挑选。</span>
            )}
          </div>
        </div>

        {/* 5. 拍摄场景绑定 */}
        <div className="wf-cast-block wf-cast-block-full">
          <div className="wf-cast-block-head">
            <span>
              <EnvironmentOutlined /> 拍摄场景（{sceneKeywords.length + (draft.assetsConfig.scenes?.length || 0)}）
            </span>
            <Button
              size="small"
              type="link"
              onClick={() => {
                onClose();
                onJumpTab("scenes");
              }}
            >
              去场景库选 40 种风格
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
      </div>
    </Modal>
  );
}
