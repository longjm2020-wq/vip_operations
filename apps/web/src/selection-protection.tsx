import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  Drawer,
  Dropdown,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Switch,
  Tabs,
  Tag,
  Typography,
} from "antd";
import {
  DeleteOutlined,
  EditOutlined,
  LockOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import { useSelectionWorkspace } from "./selection-workspace";
import { useUser, type Row } from "./shared";
import {
  defaultProtection,
  type ProtectionRegion,
  type SelectionProtection,
  type SelectionAccess,
} from "../../../packages/contracts/src/selection-protection";

const accessOptions = [
  { value: "edit", label: "可编辑" },
  { value: "read", label: "仅查看" },
  { value: "deny", label: "禁止查看" },
];
export const editableSelectionCell = (row: Row, key: string) =>
  !row.cellAccess || (row.cellAccess[key] || row.defaultCellAccess) === "edit";
export const readableSelectionCell = (row: Row, key: string) =>
  row.cellAccess?.[key] !== "deny";

export function SelectionProtectionControl({
  rows,
  columns,
  selectedCells,
  selectedRows,
  blocked,
  currentRow,
  onRefresh,
}: {
  rows: Row[];
  columns: { key: string; label: string }[];
  selectedCells: Set<string>;
  selectedRows: string[];
  blocked: boolean;
  currentRow?: Row;
  onRefresh: () => void;
}) {
  const { api, queryClient } = useSelectionWorkspace();
  const { message } = App.useApp(),
    user = useUser();
  const [open, setOpen] = useState(false),
    [tab, setTab] = useState("regions"),
    [busy, setBusy] = useState(false);
  const settings = useQuery({
    queryKey: ["selection-protection"],
    queryFn: () => api("/style-selections/protection"),
    refetchInterval: 10000,
  });
  const admin = !!settings.data?.data.canManage;
  const users = useQuery({
    queryKey: ["selection-protection-users"],
    queryFn: () => api("/style-selections/protection/users"),
    enabled: open && admin,
  });
  const [draft, setDraft] = useState<SelectionProtection>(defaultProtection),
    [revision, setRevision] = useState(0);
  const [region, setRegion] = useState<ProtectionRegion | null>(null),
    [onlyMe, setOnlyMe] = useState(false);
  const initialized = useRef(false);
  useEffect(() => {
    if (!open) {
      initialized.current = false;
      return;
    }
    if (!initialized.current && settings.data?.data) {
      initialized.current = true;
      setDraft(settings.data.data.settings);
      setRevision(settings.data.data.revision);
    }
  }, [open, settings.data]);
  const names = new Map<string, string>(
    (users.data?.data || []).map((person: Row) => [
      String(person.id),
      `${person.displayName}（${person.username}）`,
    ]),
  );
  const show = (key: string) => {
    setTab(key);
    setOpen(true);
  };
  const save = async (next: SelectionProtection) => {
    if (!admin || busy || blocked) return;
    setBusy(true);
    try {
      const result = await api("/style-selections/protection", "POST", {
        settings: next,
        revision,
      });
      setDraft(result.data.settings);
      setRevision(result.data.revision);
      setRegion(null);
      queryClient.setQueryData(["selection-protection"], result);
      await queryClient.invalidateQueries({ queryKey: ["style-selections"] });
      await queryClient.invalidateQueries({
        queryKey: ["selection-shared-view"],
      });
      onRefresh();
      message.success("保护设置已保存");
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const add = () => {
    const chosenRows = [
      ...new Set(
        [...selectedCells].map((id) => id.split("::")[0]).concat(selectedRows),
      ),
    ];
    const rowIds = chosenRows
      .map((key) => rows.find((row) => row._key === key)?.id)
      .filter(Boolean)
      .map(String);
    if (chosenRows.length !== rowIds.length)
      return void message.warning("请先保存选中行，再设置保护区域");
    const columnKeys = [
      ...new Set([...selectedCells].map((id) => id.split("::")[1])),
    ].filter((key) => columns.some((column) => column.key === key));
    setOnlyMe(false);
    setRegion({
      id: crypto.randomUUID(),
      name: `保护区域 ${draft.regions.length + 1}`,
      scope:
        rowIds.length && columnKeys.length
          ? "cells"
          : rowIds.length
            ? "rows"
            : "sheet",
      rowIds,
      columnKeys,
      users: { [String(user.id)]: "edit" },
      others: "read",
    });
  };
  const claim = async (row: Row, action: "claim" | "release") => {
    if (busy || blocked) return;
    setBusy(true);
    try {
      await api(`/style-selections/${row.id}/claim`, "POST", { action });
      onRefresh();
      message.success(action === "claim" ? "已认领本行" : "已释放本行");
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const live = settings.data?.data.settings as SelectionProtection | undefined;
  const description = (item: ProtectionRegion) =>
    item.scope === "sheet"
      ? "当前工作表（含新增行、字段）"
      : `${item.scope !== "columns" ? `${item.rowIds.length} 行` : "所有行"} · ${item.scope !== "rows" ? item.columnKeys.map((key) => columns.find((column) => column.key === key)?.label || key).join("、") : "所有字段"}`;
  return (
    <>
      <Dropdown
        trigger={["click"]}
        menu={{
          items: [
            { key: "regions", label: "区域权限" },
            { key: "claims", label: "抢占填表" },
            { key: "hide", label: "内容自动隐藏" },
          ],
          onClick: ({ key }) => show(key),
        }}
      >
        <Button icon={<LockOutlined />} aria-label="保护区域">
          保护区域
        </Button>
      </Dropdown>
      {live?.claimsEnabled && currentRow?.id && (
        <Space size={4}>
          <Tag>
            {currentRow.claimedBy
              ? String(currentRow.claimedBy) === String(user.id)
                ? "我已认领"
                : "他人已认领"
              : "待认领"}
          </Tag>
          {(!currentRow.claimedBy ||
            String(currentRow.claimedBy) === String(user.id) ||
            admin) && (
            <Button
              size="small"
              disabled={blocked || busy}
              onClick={() =>
                void claim(
                  currentRow,
                  currentRow.claimedBy ? "release" : "claim",
                )
              }
            >
              {currentRow.claimedBy ? "完成填表 / 释放" : "认领本行"}
            </Button>
          )}
        </Space>
      )}
      <Drawer
        title="保护区域"
        width={460}
        open={open}
        onClose={() => setOpen(false)}
      >
        {settings.error && (
          <Alert type="error" title={(settings.error as Error).message} />
        )}
        {!admin && (
          <Alert
            type="info"
            title="由管理员设置权限；仅查看的内容可以复制，禁止查看的内容会隐藏。"
            style={{ marginBottom: 16 }}
          />
        )}
        {blocked && (
          <Alert
            type="warning"
            title="请先处理尚未保存的修改，再调整保护或认领状态。"
            style={{ marginBottom: 16 }}
          />
        )}
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            {
              key: "regions",
              label: "区域权限",
              children: (
                <Space
                  orientation="vertical"
                  style={{ width: "100%" }}
                  size={16}
                >
                  <Space>
                    <Typography.Text strong>开启区域权限</Typography.Text>
                    <Switch
                      aria-label="开启区域权限"
                      checked={admin ? draft.enabled : live?.enabled}
                      disabled={!admin || busy || blocked}
                      onChange={(enabled) => void save({ ...draft, enabled })}
                    />
                  </Space>
                  <Typography.Text type="secondary">
                    可以保护选中单元格、整行、整列或当前工作表。重叠区域采用更严格的权限。
                  </Typography.Text>
                  {admin &&
                    draft.regions.map((item) => (
                      <Card
                        key={item.id}
                        size="small"
                        title={item.name}
                        extra={
                          <Space>
                            <Button
                              type="text"
                              aria-label={`编辑${item.name}`}
                              icon={<EditOutlined />}
                              disabled={busy || blocked}
                              onClick={() => {
                                setOnlyMe(false);
                                setRegion(item);
                              }}
                            />
                            <Button
                              type="text"
                              aria-label={`删除${item.name}`}
                              icon={<DeleteOutlined />}
                              disabled={busy || blocked}
                              onClick={() =>
                                void save({
                                  ...draft,
                                  regions: draft.regions.filter(
                                    (value) => value.id !== item.id,
                                  ),
                                })
                              }
                            />
                          </Space>
                        }
                      >
                        <p>{description(item)}</p>
                        <p>
                          其他人：
                          {
                            accessOptions.find(
                              (option) => option.value === item.others,
                            )?.label
                          }
                        </p>
                        {Object.entries(item.users).map(([id, access]) => (
                          <div key={id}>
                            {names.get(id) || `用户 ${id}`}：
                            {
                              accessOptions.find(
                                (option) => option.value === access,
                              )?.label
                            }
                          </div>
                        ))}
                      </Card>
                    ))}
                  {admin && (
                    <Button
                      block
                      type="primary"
                      icon={<PlusOutlined />}
                      disabled={busy || blocked}
                      onClick={add}
                    >
                      添加保护区域
                    </Button>
                  )}
                </Space>
              ),
            },
            {
              key: "claims",
              label: "抢占填表",
              children: (
                <Space
                  orientation="vertical"
                  style={{ width: "100%" }}
                  size={16}
                >
                  <Space>
                    <Typography.Text strong>开启抢占填表</Typography.Text>
                    <Switch
                      aria-label="开启抢占填表"
                      checked={
                        admin ? draft.claimsEnabled : live?.claimsEnabled
                      }
                      disabled={!admin || busy || blocked}
                      onChange={(claimsEnabled) =>
                        void save({ ...draft, claimsEnabled })
                      }
                    />
                  </Space>
                  <Typography.Text>
                    先认领或首次保存即可占用本行。每人同时认领一行；他人仅可查看。完成后点击“完成填表
                    / 释放”，即可填写另一行。管理员可以释放他人认领的行。
                  </Typography.Text>
                  {rows
                    .filter(
                      (row) =>
                        row.claimedBy &&
                        (admin || String(row.claimedBy) === String(user.id)),
                    )
                    .map((row) => (
                      <Card key={row.id} size="small">
                        <Space wrap>
                          <span>
                            {row.xutiStyleNo ||
                              row.supplierStyleNo ||
                              `行 ${row.id}`}{" "}
                            · {names.get(String(row.claimedBy)) || "我"}
                          </span>
                          <Button
                            size="small"
                            disabled={busy || blocked}
                            onClick={() => void claim(row, "release")}
                          >
                            释放
                          </Button>
                        </Space>
                      </Card>
                    ))}
                </Space>
              ),
            },
            {
              key: "hide",
              label: "内容自动隐藏",
              children: (
                <Space
                  orientation="vertical"
                  style={{ width: "100%" }}
                  size={16}
                >
                  <Space>
                    <Typography.Text strong>开启内容自动隐藏</Typography.Text>
                    <Switch
                      aria-label="开启内容自动隐藏"
                      checked={admin ? draft.autoHide : live?.autoHide}
                      disabled={!admin || busy || blocked}
                      onChange={(autoHide) => void save({ ...draft, autoHide })}
                    />
                  </Space>
                  <Typography.Text>
                    填写后的内容显示为
                    ••••。管理员、该行创建人、该字段最近填写人及下方指定用户可查看；区域的“禁止查看”仍然有效。空白字段可按区域权限填写。
                  </Typography.Text>
                  {admin && (
                    <>
                      <Typography.Text>额外允许查看的用户</Typography.Text>
                      <Select
                        aria-label="自动隐藏指定查看人"
                        mode="multiple"
                        showSearch
                        optionFilterProp="label"
                        style={{ width: "100%" }}
                        value={draft.hiddenReaders}
                        options={[...names].map(([value, label]) => ({
                          value,
                          label,
                        }))}
                        disabled={busy || blocked}
                        onChange={(hiddenReaders) =>
                          void save({ ...draft, hiddenReaders })
                        }
                      />
                    </>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Drawer>
      <Modal
        title="设置保护区域"
        open={!!region}
        width={620}
        confirmLoading={busy}
        okButtonProps={{ disabled: blocked }}
        onCancel={() => setRegion(null)}
        onOk={() => {
          if (!region) return;
          const item = onlyMe
            ? { ...region, users: { [String(user.id)]: "edit" as const } }
            : region;
          void save({
            ...draft,
            regions: [
              ...draft.regions.filter((value) => value.id !== item.id),
              item,
            ],
          });
        }}
      >
        {region && (
          <Space orientation="vertical" size={16} style={{ width: "100%" }}>
            <Input
              aria-label="保护区域名称"
              placeholder="保护区域名称"
              maxLength={80}
              value={region.name}
              onChange={(event) =>
                setRegion({ ...region, name: event.target.value })
              }
            />
            <Select
              getPopupContainer={(trigger) => trigger.parentElement!}
              aria-label="保护范围"
              style={{ width: "100%" }}
              value={region.scope}
              options={[
                { value: "cells", label: "选中单元格" },
                { value: "rows", label: "选中整行" },
                { value: "columns", label: "整列（所有行）" },
                { value: "sheet", label: "当前工作表" },
              ]}
              onChange={(scope) => setRegion({ ...region, scope })}
            />
            {(region.scope === "cells" || region.scope === "rows") && (
              <Select
                getPopupContainer={(trigger) => trigger.parentElement!}
                aria-label="保护行"
                mode="multiple"
                showSearch
                optionFilterProp="label"
                style={{ width: "100%" }}
                value={region.rowIds}
                options={rows
                  .filter((row) => row.id)
                  .map((row, index) => ({
                    value: String(row.id),
                    label: `${index + 1} · ${row.xutiStyleNo || row.supplierStyleNo || "未填款号"}`,
                  }))}
                onChange={(rowIds) => setRegion({ ...region, rowIds })}
              />
            )}
            {(region.scope === "cells" || region.scope === "columns") && (
              <Select
                getPopupContainer={(trigger) => trigger.parentElement!}
                aria-label="保护字段"
                mode="multiple"
                showSearch
                optionFilterProp="label"
                style={{ width: "100%" }}
                value={region.columnKeys}
                options={columns.map((column) => ({
                  value: column.key,
                  label: column.label,
                }))}
                onChange={(columnKeys) => setRegion({ ...region, columnKeys })}
              />
            )}
            <Radio.Group
              value={onlyMe}
              onChange={(event) => setOnlyMe(event.target.value)}
            >
              <Radio value={true}>仅我可编辑</Radio>
              <Radio value={false}>指定人可查看 / 编辑</Radio>
            </Radio.Group>
            {!onlyMe && (
              <>
                <Select
                  getPopupContainer={(trigger) => trigger.parentElement!}
                  aria-label="添加指定用户"
                  mode="multiple"
                  showSearch
                  optionFilterProp="label"
                  style={{ width: "100%" }}
                  value={Object.keys(region.users)}
                  options={[...names].map(([value, label]) => ({
                    value,
                    label,
                  }))}
                  onChange={(ids) =>
                    setRegion({
                      ...region,
                      users: Object.fromEntries(
                        ids.map((id) => [id, region.users[id] || "edit"]),
                      ),
                    })
                  }
                />
                {Object.entries(region.users).map(([id, access]) => (
                  <Space
                    key={id}
                    style={{ justifyContent: "space-between", width: "100%" }}
                  >
                    <span>{names.get(id) || `用户 ${id}`}</span>
                    <Select
                      getPopupContainer={(trigger) => trigger.parentElement!}
                      aria-label={`用户 ${id} 权限`}
                      value={access}
                      options={accessOptions}
                      onChange={(access: SelectionAccess) =>
                        setRegion({
                          ...region,
                          users: { ...region.users, [id]: access },
                        })
                      }
                    />
                  </Space>
                ))}
              </>
            )}
            <Space>
              <span>其他人</span>
              <Select
                getPopupContainer={(trigger) => trigger.parentElement!}
                aria-label="其他人权限"
                value={region.others}
                options={accessOptions}
                onChange={(others: SelectionAccess) =>
                  setRegion({ ...region, others })
                }
              />
            </Space>
            <Alert
              type="info"
              title="区域权限开启后生效。管理员始终可查看、编辑和管理；区域授权不能超过用户本身的模块权限。"
            />
          </Space>
        )}
      </Modal>
    </>
  );
}
