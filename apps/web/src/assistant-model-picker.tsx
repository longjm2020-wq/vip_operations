import { Button, Dropdown } from "antd";
import { DownOutlined, ReloadOutlined } from "@ant-design/icons";
import type { AgentCatalog } from "../../../packages/contracts/src/assistant-agent";

import { resolveAssistantModelPickerState } from "../../../packages/contracts/src/assistant-model-picker";

export {
  visibleAssistantModels,
  resolveAssistantModelPickerState,
} from "../../../packages/contracts/src/assistant-model-picker";

export function AssistantModelPicker({
  catalog,
  value,
  onChange,
  disabled,
  loading,
  failed,
  refresh,
  teamSelected,
  selectTeam,
}: {
  catalog?: AgentCatalog;
  value?: string;
  onChange: (value: string) => void;
  disabled: boolean;
  loading: boolean;
  failed: boolean;
  refresh: () => void;
  teamSelected?: boolean;
  selectTeam?: () => void;
}) {
  const { models, selectedId, title } = resolveAssistantModelPickerState({
    catalog,
    value,
    teamSelected,
  });
  return (
    <Dropdown
      trigger={["click"]}
      disabled={disabled}
      placement="topRight"
      menu={{
        style: { maxHeight: "min(560px, 70vh)", overflowY: "auto" },
        selectable: true,
        selectedKeys: selectedId ? [selectedId] : [],
        items: [
          ...(selectTeam
            ? [
                {
                  key: "team",
                  label: (
                    <div className="assistant-model-option">
                      <span>智能体团队</span>
                      <small>协作处理任务，进度与结果留在当前对话</small>
                    </div>
                  ),
                },
                { type: "divider" as const },
              ]
            : []),
          ...models.map((model) => ({
            key: model.id,
            label: (
              <div className="assistant-model-option">
                <span>{model.displayName || model.name}</span>
                <small>
                  {model.name}
                  {" · 多模态"}
                </small>
              </div>
            ),
          })),
          ...(!models.length
            ? [
                {
                  key: "notice",
                  disabled: true,
                  label: loading
                    ? "正在读取模型…"
                    : failed
                      ? "模型列表加载失败"
                      : "暂无已接通模型",
                },
              ]
            : []),
          { type: "divider" as const },
          {
            key: "refresh",
            label: "刷新模型列表",
            icon: <ReloadOutlined />,
            disabled: loading,
          },
        ],
        onClick: ({ key }) =>
          key === "team"
            ? selectTeam?.()
            : key === "refresh"
              ? refresh()
              : onChange(key),
      }}
    >
      <Button
        type="text"
        size="small"
        className="assistant-model-picker"
        aria-label="选择对话模型"
        title={title}
        disabled={disabled}
        loading={loading}
      >
        <span>{title}</span>
        <DownOutlined />
      </Button>
    </Dropdown>
  );
}
