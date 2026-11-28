import { useMemo, useState } from "react";
import { Alert, Button, Input, Select, Space, Tag } from "antd";
import {
  CheckOutlined,
  PlusOutlined,
  SearchOutlined,
  SkinOutlined,
  ThunderboltOutlined,
  ToolOutlined,
  UploadOutlined,
  EnvironmentOutlined,
} from "@ant-design/icons";
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

/** 场景库面板：支持自定义场景图/关键词 + 40 种风格关键词场景筛选选用 */
export function SceneLibraryPanel({
  draft,
  disabled,
  onUploadScene,
  onToggleKeyword,
  onAddCustomKeyword,
}: {
  draft: WorkflowView | null;
  disabled?: boolean;
  onUploadScene: (file: File) => void;
  onToggleKeyword: (keyword: string) => void;
  onAddCustomKeyword: (keyword: string) => void;
}) {
  const [category, setCategory] = useState<string>("全部");
  const [search, setSearch] = useState("");
  const [customInput, setCustomInput] = useState("");

  const categories = useMemo(
    () => ["全部", ...new Set(sceneStylePresets40.map((s) => s.category))],
    [],
  );

  const filteredPresets = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sceneStylePresets40.filter((item) => {
      if (category !== "全部" && item.category !== category) return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.keywords.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q)
      );
    });
  }, [category, search]);

  const selectedKeywords = draft?.assetsConfig.sceneKeywords || [];

  return (
    <>
      <div className="wf-section-card" aria-label="自定义场景">
        <div className="wf-section-card-head">
          <span>
            <EnvironmentOutlined /> 自定义场景
          </span>
          {draft && (
            <label className="wf-file-btn wf-file-btn-sm">
              <UploadOutlined /> 上传场景图
              <input
                type="file"
                accept="image/*"
                disabled={disabled}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) onUploadScene(f);
                }}
              />
            </label>
          )}
        </div>
        <Space.Compact style={{ width: "100%" }}>
          <Input
            size="small"
            aria-label="自定义场景关键词"
            placeholder="输入自定义场景（如：雪夜古寺灯笼长廊）"
            value={customInput}
            disabled={!draft || disabled}
            onChange={(e) => setCustomInput(e.target.value)}
            onPressEnter={() => {
              if (!customInput.trim()) return;
              onAddCustomKeyword(customInput.trim());
              setCustomInput("");
            }}
          />
          <Button
            size="small"
            type="primary"
            icon={<PlusOutlined />}
            disabled={!draft || disabled || !customInput.trim()}
            onClick={() => {
              if (!customInput.trim()) return;
              onAddCustomKeyword(customInput.trim());
              setCustomInput("");
            }}
          >
            添加
          </Button>
        </Space.Compact>

        {draft?.assetsConfig.scenes?.length ? (
          <div className="wf-asset-chips">
            {draft.assetsConfig.scenes.map((s) => (
              <div key={s.id} className="wf-asset-chip">
                {s.url && <img src={s.url} alt={s.name} />}
                <span>{s.name}</span>
              </div>
            ))}
          </div>
        ) : null}

        {selectedKeywords.length > 0 && (
          <div className="wf-asset-chips">
            {selectedKeywords.map((kw) => (
              <Tag
                key={kw}
                color="blue"
                closable={!disabled}
                onClose={() => onToggleKeyword(kw)}
                style={{ margin: 0 }}
              >
                {kw}
              </Tag>
            ))}
          </div>
        )}
      </div>

      <div className="wf-section-card" aria-label="40种风格关键词场景">
        <div className="wf-section-card-head">
          <span>40 种风格关键词场景</span>
          <Tag style={{ margin: 0 }}>{sceneStylePresets40.length} 种风格</Tag>
        </div>
        <Input
          size="small"
          prefix={<SearchOutlined />}
          placeholder="搜索风格或关键词（如：武侠、法式、赛博、棚拍）"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
        />
        <div className="wf-filter-pills">
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              className={`wf-filter-pill${category === cat ? " is-active" : ""}`}
              onClick={() => setCategory(cat)}
            >
              {cat}
            </button>
          ))}
        </div>
        {!draft && (
          <Alert
            type="info"
            showIcon
            title="新建或打开工作流后，点击下方任意风格卡片即可一键绑定到脚本场景"
          />
        )}
        <div className="wf-preset-grid">
          {filteredPresets.map((item) => {
            const key = `${item.name}：${item.keywords}`;
            const active = selectedKeywords.includes(key);
            return (
              <button
                key={item.id}
                type="button"
                className={`wf-preset-card${active ? " is-selected" : ""}`}
                disabled={!draft || disabled}
                onClick={() => onToggleKeyword(key)}
              >
                <div className="wf-preset-card-head">
                  <strong>{item.name}</strong>
                  {active ? (
                    <CheckOutlined style={{ color: "var(--app-accent)" }} />
                  ) : (
                    <span>{item.category}</span>
                  )}
                </div>
                <p>{item.keywords}</p>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

/** 道具库面板：支持自定义道具图/关键词 + 按剧情智能推荐道具（如武侠剧智能匹配刀/剑/棍/棒/斧） */
export function PropLibraryPanel({
  draft,
  disabled,
  onUploadProp,
  onToggleKeyword,
  onApplyRecommended,
}: {
  draft: WorkflowView | null;
  disabled?: boolean;
  onUploadProp: (file: File) => void;
  onToggleKeyword: (keyword: string) => void;
  onApplyRecommended: (keywords: string[]) => void;
}) {
  const [storyHint, setStoryHint] = useState("");
  const [customInput, setCustomInput] = useState("");

  const effectiveStory = [
    storyHint,
    draft?.title || "",
    draft?.assetsConfig.creativeBrief || "",
    draft?.deconstructData?.summary || "",
  ]
    .filter(Boolean)
    .join(" ");

  const recommendation = useMemo(
    () => recommendPropsAndGarmentsByStory(effectiveStory),
    [effectiveStory],
  );
  const selectedKeywords = draft?.assetsConfig.propKeywords || [];

  return (
    <>
      <div className="wf-section-card" aria-label="自定义道具">
        <div className="wf-section-card-head">
          <span>
            <ToolOutlined /> 自定义道具
          </span>
          {draft && (
            <label className="wf-file-btn wf-file-btn-sm">
              <UploadOutlined /> 上传道具图
              <input
                type="file"
                accept="image/*"
                disabled={disabled}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) onUploadProp(f);
                }}
              />
            </label>
          )}
        </div>
        <Space.Compact style={{ width: "100%" }}>
          <Input
            size="small"
            aria-label="自定义道具名称"
            placeholder="输入自定义道具（如：青铜古剑、复古托特包）"
            value={customInput}
            disabled={!draft || disabled}
            onChange={(e) => setCustomInput(e.target.value)}
            onPressEnter={() => {
              if (!customInput.trim()) return;
              onToggleKeyword(customInput.trim());
              setCustomInput("");
            }}
          />
          <Button
            size="small"
            type="primary"
            icon={<PlusOutlined />}
            disabled={!draft || disabled || !customInput.trim()}
            onClick={() => {
              if (!customInput.trim()) return;
              onToggleKeyword(customInput.trim());
              setCustomInput("");
            }}
          >
            添加
          </Button>
        </Space.Compact>

        {draft?.assetsConfig.props?.length ? (
          <div className="wf-asset-chips">
            {draft.assetsConfig.props.map((p) => (
              <div key={p.id} className="wf-asset-chip">
                {p.url && <img src={p.url} alt={p.name} />}
                <span>{p.name}</span>
              </div>
            ))}
          </div>
        ) : null}

        {selectedKeywords.length > 0 && (
          <div className="wf-asset-chips">
            {selectedKeywords.map((kw) => (
              <Tag
                key={kw}
                color="blue"
                closable={!disabled}
                onClose={() => onToggleKeyword(kw)}
                style={{ margin: 0 }}
              >
                {kw}
              </Tag>
            ))}
          </div>
        )}
      </div>

      <div className="wf-section-card" aria-label="剧情智能推荐道具">
        <div className="wf-section-card-head">
          <span>
            <ThunderboltOutlined /> 按剧情智能推荐道具
          </span>
          <Tag color="blue" style={{ margin: 0 }}>
            匹配：{recommendation.matchedGenre}
          </Tag>
        </div>
        <Input
          size="small"
          aria-label="输入剧情题材推荐道具"
          placeholder="输入剧情关键词（如：武侠剧、仙侠、职场通勤、赛博科幻）"
          value={storyHint}
          onChange={(e) => setStoryHint(e.target.value)}
        />
        <div className="wf-filter-pills">
          {recommendation.allGenres.map((g) => (
            <button
              key={g.genre}
              type="button"
              className={`wf-filter-pill${recommendation.matchedGenre === g.genre ? " is-active" : ""}`}
              onClick={() => setStoryHint(g.genre)}
            >
              {g.genre}
            </button>
          ))}
        </div>
        <div className="wf-asset-chips">
          {recommendation.props.map((item) => {
            const active = selectedKeywords.includes(item);
            return (
              <Button
                key={item}
                size="small"
                type={active ? "primary" : "default"}
                disabled={!draft || disabled}
                onClick={() => onToggleKeyword(item)}
              >
                {active ? <CheckOutlined /> : <PlusOutlined />} {item}
              </Button>
            );
          })}
        </div>
        <Button
          size="small"
          type="primary"
          icon={<ThunderboltOutlined />}
          disabled={!draft || disabled}
          onClick={() => onApplyRecommended(recommendation.props.slice(0, 4))}
        >
          一键选用推荐道具
        </Button>
      </div>
    </>
  );
}

/** 服饰库面板：支持绑定商品档案/上传自定义服装图/关键词 + 按剧情智能推荐服装（如武侠剧智能匹配铠甲/布衣） */
export function GarmentLibraryPanel({
  draft,
  disabled,
  productOptions,
  selectedProduct,
  onProductSearch,
  onSelectProduct,
  onUploadGarment,
  onToggleKeyword,
  onApplyRecommended,
}: {
  draft: WorkflowView | null;
  disabled?: boolean;
  productOptions: ProductOption[];
  selectedProduct?: ProductOption;
  onProductSearch: (q: string) => void;
  onSelectProduct: (productId?: string) => void;
  onUploadGarment: (file: File) => void;
  onToggleKeyword: (keyword: string) => void;
  onApplyRecommended: (keywords: string[]) => void;
}) {
  const [storyHint, setStoryHint] = useState("");
  const [customInput, setCustomInput] = useState("");

  const effectiveStory = [
    storyHint,
    draft?.title || "",
    draft?.assetsConfig.creativeBrief || "",
    draft?.deconstructData?.summary || "",
  ]
    .filter(Boolean)
    .join(" ");

  const recommendation = useMemo(
    () => recommendPropsAndGarmentsByStory(effectiveStory),
    [effectiveStory],
  );
  const selectedKeywords = draft?.assetsConfig.garmentKeywords || [];

  return (
    <>
      <div className="wf-section-card" aria-label="自定义服装">
        <div className="wf-section-card-head">
          <span>
            <SkinOutlined /> 自定义服装与商品档案
          </span>
          {draft && (
            <label className="wf-file-btn wf-file-btn-sm">
              <UploadOutlined /> 上传服装图
              <input
                type="file"
                accept="image/*"
                disabled={disabled}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) onUploadGarment(f);
                }}
              />
            </label>
          )}
        </div>

        <Select
          size="small"
          showSearch
          allowClear
          filterOption={false}
          placeholder="搜索并绑定商品档案款号"
          value={draft?.assetsConfig.productId}
          disabled={!draft || disabled}
          onSearch={onProductSearch}
          options={productOptions.map((p) => ({
            value: p.id,
            label: `${p.styleNo} · ${p.name}`,
          }))}
          onChange={onSelectProduct}
        />

        {selectedProduct && selectedProduct.images.length > 0 && (
          <div className="wf-asset-chips">
            {selectedProduct.images.map((img) => (
              <div key={img.id} className="wf-asset-chip">
                <img src={img.url} alt={img.color || "商品图"} />
                <span>{img.color || "实拍图"}</span>
              </div>
            ))}
          </div>
        )}

        <Space.Compact style={{ width: "100%" }}>
          <Input
            size="small"
            aria-label="自定义服装名称"
            placeholder="输入自定义服饰（如：玄铁铠甲、粗麻布衣、垂感西装）"
            value={customInput}
            disabled={!draft || disabled}
            onChange={(e) => setCustomInput(e.target.value)}
            onPressEnter={() => {
              if (!customInput.trim()) return;
              onToggleKeyword(customInput.trim());
              setCustomInput("");
            }}
          />
          <Button
            size="small"
            type="primary"
            icon={<PlusOutlined />}
            disabled={!draft || disabled || !customInput.trim()}
            onClick={() => {
              if (!customInput.trim()) return;
              onToggleKeyword(customInput.trim());
              setCustomInput("");
            }}
          >
            添加
          </Button>
        </Space.Compact>

        {draft?.assetsConfig.garments?.length ? (
          <div className="wf-asset-chips">
            {draft.assetsConfig.garments.map((g) => (
              <div key={g.id} className="wf-asset-chip">
                {g.url && <img src={g.url} alt={g.name} />}
                <span>{g.name}</span>
              </div>
            ))}
          </div>
        ) : null}

        {selectedKeywords.length > 0 && (
          <div className="wf-asset-chips">
            {selectedKeywords.map((kw) => (
              <Tag
                key={kw}
                color="blue"
                closable={!disabled}
                onClose={() => onToggleKeyword(kw)}
                style={{ margin: 0 }}
              >
                {kw}
              </Tag>
            ))}
          </div>
        )}
      </div>

      <div className="wf-section-card" aria-label="剧情智能推荐服装">
        <div className="wf-section-card-head">
          <span>
            <ThunderboltOutlined /> 按剧情智能推荐服装
          </span>
          <Tag color="blue" style={{ margin: 0 }}>
            匹配：{recommendation.matchedGenre}
          </Tag>
        </div>
        <Input
          size="small"
          aria-label="输入剧情题材推荐服装"
          placeholder="输入剧情关键词（如：武侠剧、汉服古风、都市通勤、法式度假）"
          value={storyHint}
          onChange={(e) => setStoryHint(e.target.value)}
        />
        <div className="wf-filter-pills">
          {recommendation.allGenres.map((g) => (
            <button
              key={g.genre}
              type="button"
              className={`wf-filter-pill${recommendation.matchedGenre === g.genre ? " is-active" : ""}`}
              onClick={() => setStoryHint(g.genre)}
            >
              {g.genre}
            </button>
          ))}
        </div>
        <div className="wf-asset-chips">
          {recommendation.garments.map((item) => {
            const active = selectedKeywords.includes(item);
            return (
              <Button
                key={item}
                size="small"
                type={active ? "primary" : "default"}
                disabled={!draft || disabled}
                onClick={() => onToggleKeyword(item)}
              >
                {active ? <CheckOutlined /> : <PlusOutlined />} {item}
              </Button>
            );
          })}
        </div>
        <Button
          size="small"
          type="primary"
          icon={<ThunderboltOutlined />}
          disabled={!draft || disabled}
          onClick={() => onApplyRecommended(recommendation.garments.slice(0, 3))}
        >
          一键选用推荐服装
        </Button>
      </div>
    </>
  );
}
