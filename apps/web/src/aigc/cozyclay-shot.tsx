import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Collapse,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
} from "antd";
import { assetUrl, studioApi, type Item } from "./api";
import { AssetInput } from "./components";

type Dialogue = {
  startSeconds?: number;
  endSeconds?: number;
  roleId?: string;
  text: string;
};
type Character = { id: string; name: string };
type PrevisShot = {
  id: string;
  name: string;
  sceneName: string;
  startFrame: number;
  endFrame: number;
  characters: Character[];
};
type Unit = { id: string; durationSeconds: number; roleIds?: string[] };

const resetShotInputs = () => ({
  greybox: undefined,
  firstFrame: undefined,
  lastFrame: undefined,
  dialogueAudio: undefined,
  direction: undefined,
  assignments: [],
  dialogue: [],
  authorized: false,
});

function CastEditor({
  project,
  onChange,
}: {
  project: Item;
  onChange: (value: Item) => void;
}) {
  const { cast, assets } = project;
  const makeRole = (
    name: string,
    images: Item[] = [],
    measurements: Item[] = [],
  ) => ({
    id: crypto.randomUUID(),
    name,
    selected: true,
    images,
    measurements,
  });
  if (!cast)
    return (
      <Button
        onClick={() => {
          const first = makeRole(
            "主播",
            assets.modelImages,
            project.modelMeasurements,
          );
          onChange({
            roles: [first, makeRole("模特")],
            products: [
              {
                ...makeRole(
                  "商品 1",
                  assets.productImages,
                  project.productMeasurements,
                ),
                roleId: first.id,
              },
            ],
          });
        }}
      >
        设置多角色与商品归属
      </Button>
    );
  const rename = (key: "roles" | "products", id: string, value: Item) =>
    onChange({
      ...cast,
      [key]: cast[key].map((item: Item) =>
        item.id === id ? { ...item, ...value } : item,
      ),
    });
  return (
    <Space
      orientation="vertical"
      size="middle"
      className="aigc-cozyclay-fields"
    >
      <div className="aigc-upload-grid">
        {cast.roles.map((role: Item, index: number) => (
          <div key={role.id}>
            <Input
              aria-label={`角色 ${index + 1} 名称`}
              maxLength={80}
              value={role.name}
              onChange={(event) =>
                rename("roles", role.id, { name: event.target.value })
              }
            />
            <AssetInput
              label={`角色 ${index + 1} 原图`}
              kind="model"
              projectId={project.id}
              files={role.images}
              onChange={(images) => rename("roles", role.id, { images })}
            />
            {cast.roles.length > 1 && (
              <Button
                type="text"
                size="small"
                onClick={() =>
                  onChange({
                    roles: cast.roles.filter(
                      (item: Item) => item.id !== role.id,
                    ),
                    products: cast.products.map((product: Item) =>
                      product.roleId === role.id
                        ? { ...product, roleId: "" }
                        : product,
                    ),
                  })
                }
              >
                移除角色
              </Button>
            )}
          </div>
        ))}
        {cast.products.map((product: Item, index: number) => (
          <div key={product.id}>
            <Input
              aria-label={`商品 ${index + 1} 名称`}
              maxLength={80}
              value={product.name}
              onChange={(event) =>
                rename("products", product.id, { name: event.target.value })
              }
            />
            <AssetInput
              label={`商品 ${index + 1} 原图`}
              kind="product"
              projectId={project.id}
              files={product.images}
              onChange={(images) => rename("products", product.id, { images })}
            />
            <Select
              aria-label={`${product.name}的归属角色`}
              placeholder="选择商品归属角色"
              value={product.roleId || undefined}
              options={cast.roles.map((role: Item) => ({
                value: role.id,
                label: role.name,
              }))}
              onChange={(roleId) => rename("products", product.id, { roleId })}
            />
            {cast.products.length > 1 && (
              <Button
                type="text"
                size="small"
                onClick={() =>
                  onChange({
                    ...cast,
                    products: cast.products.filter(
                      (item: Item) => item.id !== product.id,
                    ),
                  })
                }
              >
                移除商品
              </Button>
            )}
          </div>
        ))}
      </div>
      <Space wrap>
        {cast.roles.length < 8 && (
          <Button
            onClick={() =>
              onChange({
                ...cast,
                roles: [
                  ...cast.roles,
                  makeRole(`角色 ${cast.roles.length + 1}`),
                ],
              })
            }
          >
            新增角色
          </Button>
        )}
        {cast.products.length < 16 && (
          <Button
            onClick={() =>
              onChange({
                ...cast,
                products: [
                  ...cast.products,
                  {
                    ...makeRole(`商品 ${cast.products.length + 1}`),
                    roleId: "",
                  },
                ],
              })
            }
          >
            新增商品
          </Button>
        )}
      </Space>
    </Space>
  );
}

const attachmentFields = [
  {
    key: "project",
    label: "CozyClay 工程",
    kind: "cozyclayProject",
    accept: ".cclayproject",
    maxMB: 2,
  },
  {
    key: "greybox",
    label: "灰模视频",
    kind: "referenceVideo",
    accept: ".mp4,.mov",
    maxMB: 50,
  },
  {
    key: "firstFrame",
    label: "首帧（审片）",
    kind: "scene",
    accept: "image/jpeg,image/png,image/webp",
    maxMB: 15,
  },
  {
    key: "lastFrame",
    label: "尾帧（审片）",
    kind: "scene",
    accept: "image/jpeg,image/png,image/webp",
    maxMB: 15,
  },
  {
    key: "dialogueAudio",
    label: "完整对白音轨",
    kind: "referenceAudio",
    accept: ".mp3,.wav",
    maxMB: 15,
  },
] as const;

type EditorProps = {
  project: Item;
  model?: Item;
  active: boolean;
  compileId?: string;
  onCast: (value: Item) => void;
  onPending: () => void;
  onSave: (value: Item | null, generate: boolean) => Promise<boolean>;
};

export function CozyClayShotEditor({
  project,
  model,
  active,
  compileId,
  onCast,
  onPending,
  onSave,
}: EditorProps) {
  const { message, modal } = App.useApp();
  const [open, setOpen] = useState(false);
  const [setup, setSetup] = useState<Item>(
    project.cozyclay || { assignments: [], dialogue: [] },
  );
  const [busy, setBusy] = useState("");
  const units = useQuery<Unit[]>({
    queryKey: ["aigc-previs-units", project.id, compileId],
    queryFn: () =>
      studioApi(`/projects/${encodeURIComponent(project.id)}/previs-units`),
    enabled: open && Boolean(compileId),
  });
  const set = (values: Item) => {
    setSetup((current) => ({ ...current, ...values }));
    onPending();
  };
  const shots: PrevisShot[] = setup.project?.mediaInfo?.cozyclay?.shots || [];
  const shot = shots.find((item) => item.id === setup.sourceShotId);
  const unit = units.data?.find((item) => item.id === setup.unitId);
  const roles: Item[] = (project.cast?.roles || []).filter(
    (role: Item) =>
      role.selected !== false &&
      role.images?.length &&
      (!unit?.roleIds || unit.roleIds.includes(role.id)),
  );
  const assignments: { subjectId: string; roleId: string }[] =
    setup.assignments;
  const dialogue: Dialogue[] = setup.dialogue;
  const modelSupported =
    model?.mediaReferences?.audio?.field === "driving_audio";
  const blocked = active || Boolean(busy);
  const ready = Boolean(
    shot &&
    unit &&
    setup.greybox &&
    setup.authorized &&
    assignments.length === shot.characters.length &&
    assignments.every((assignment) =>
      roles.some((role) => role.id === assignment.roleId),
    ) &&
    dialogue.every(
      (cue) =>
        cue.startSeconds != null &&
        cue.endSeconds != null &&
        cue.text.trim() &&
        cue.roleId,
    ) &&
    (!dialogue.length || setup.dialogueAudio),
  );
  const pick = async (field: (typeof attachmentFields)[number], file: File) => {
    if (file.size > field.maxMB * 1024 ** 2) {
      void message.error(`${field.label}不能超过 ${field.maxMB} MB`);
      return;
    }
    setBusy(field.key);
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("projectId", project.id);
      body.set("kind", field.kind);
      const asset = await studioApi("/assets", "POST", body, {
        readTimeoutMs: 90_000,
      });
      set(
        field.key === "project"
          ? {
              project: asset,
              sourceShotId: undefined,
              ...resetShotInputs(),
            }
          : { [field.key]: asset },
      );
    } catch (error) {
      void message.error((error as Error).message);
    } finally {
      setBusy("");
    }
  };
  const save = async (generate: boolean, value: Item | null = setup) => {
    setBusy("save");
    try {
      const saved = await onSave(value, generate);
      if (saved && !value) setSetup({ assignments: [], dialogue: [] });
    } finally {
      setBusy("");
    }
  };
  const changeCue = (index: number, value: Partial<Dialogue>) =>
    set({
      dialogue: dialogue.map((cue, i) =>
        i === index ? { ...cue, ...value } : cue,
      ),
    });
  return (
    <Collapse
      onChange={(keys) => setOpen(keys.includes("previs"))}
      items={[
        {
          key: "previs",
          label: "角色与镜头预演",
          children: (
            <Space
              orientation="vertical"
              size="middle"
              className="aigc-cozyclay-fields"
            >
              <CastEditor project={project} onChange={onCast} />
              <Alert
                type="info"
                title="先保存项目并拆解参考视频，再把 CozyClay 镜头绑定到对应片段。"
                description="灰模视频用于机位、走位和动作。首尾帧保留供审片。带对白时需上传一段按时点合成或录制的完整音轨，成片需核对说话人与口型。"
              />
              {!modelSupported && (
                <Alert
                  type="warning"
                  title="预演生成使用百炼 MiniMax-H3。选择并保存这个模型后可上传灰模视频和对白音轨。"
                />
              )}
              <div className="aigc-form-grid">
                {attachmentFields.map((field) => (
                  <Form.Item
                    key={field.key}
                    label={field.label}
                    htmlFor={`cozyclay-${field.key}`}
                  >
                    <Input
                      id={`cozyclay-${field.key}`}
                      type="file"
                      accept={field.accept}
                      disabled={
                        blocked ||
                        (field.key !== "project" && !shot) ||
                        (!modelSupported &&
                          (field.key === "greybox" ||
                            field.key === "dialogueAudio"))
                      }
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file) void pick(field, file);
                      }}
                    />
                    {busy === field.key && <span role="status">正在导入</span>}
                    {setup[field.key] && (
                      <Space wrap>
                        <a href={assetUrl(setup[field.key].path, true)}>
                          {setup[field.key].name}
                        </a>
                        <Button
                          type="text"
                          size="small"
                          disabled={blocked}
                          onClick={() =>
                            set(
                              field.key === "project"
                                ? {
                                    project: undefined,
                                    sourceShotId: undefined,
                                    ...resetShotInputs(),
                                  }
                                : { [field.key]: undefined },
                            )
                          }
                        >
                          移除
                        </Button>
                      </Space>
                    )}
                  </Form.Item>
                ))}
                <Form.Item label="工程镜头">
                  <Select
                    aria-label="工程镜头"
                    disabled={blocked || !shots.length}
                    value={setup.sourceShotId}
                    options={shots.map((item) => ({
                      value: item.id,
                      label: `${item.sceneName} · ${item.name} · ${item.startFrame}–${item.endFrame} 帧`,
                    }))}
                    onChange={(sourceShotId) =>
                      set({ sourceShotId, ...resetShotInputs() })
                    }
                  />
                </Form.Item>
                <Form.Item label="编译片段">
                  <Select
                    aria-label="编译片段"
                    disabled={blocked || !units.data?.length}
                    loading={units.isFetching}
                    placeholder="拆解完成后选择片段"
                    value={setup.unitId}
                    options={units.data?.map((item) => ({
                      value: item.id,
                      label: `${item.id} · ${item.durationSeconds} 秒`,
                    }))}
                    onChange={(unitId) =>
                      set({ unitId, assignments: [], dialogue: [] })
                    }
                  />
                </Form.Item>
              </div>
              {units.isError && (
                <Button onClick={() => void units.refetch()}>
                  重新读取编译片段
                </Button>
              )}
              {shot?.characters.map((character) => (
                <Form.Item
                  key={character.id}
                  label={character.name || character.id}
                >
                  <Select
                    aria-label={`绑定角色 ${character.name || character.id}`}
                    disabled={blocked}
                    placeholder="绑定当前项目人物"
                    value={
                      assignments.find(
                        (item) => item.subjectId === character.id,
                      )?.roleId
                    }
                    options={roles.map((role) => ({
                      value: role.id,
                      label: role.name,
                      disabled: assignments.some(
                        (item) =>
                          item.roleId === role.id &&
                          item.subjectId !== character.id,
                      ),
                    }))}
                    onChange={(roleId) =>
                      set({
                        assignments: [
                          ...assignments.filter(
                            (item) => item.subjectId !== character.id,
                          ),
                          { subjectId: character.id, roleId },
                        ],
                        dialogue: [],
                      })
                    }
                  />
                </Form.Item>
              ))}
              {shot && (
                <Form.Item label="动作与道具交接">
                  <Input.TextArea
                    aria-label="动作与道具交接"
                    value={setup.direction}
                    maxLength={600}
                    rows={2}
                    disabled={blocked}
                    onChange={(event) => set({ direction: event.target.value })}
                  />
                </Form.Item>
              )}
              {dialogue.map((cue, index) => (
                <div className="aigc-form-grid" key={index}>
                  <InputNumber
                    aria-label={`第 ${index + 1} 句起点（秒）`}
                    placeholder="起点（秒）"
                    min={0}
                    max={15}
                    step={0.1}
                    value={cue.startSeconds}
                    disabled={blocked}
                    onChange={(value) =>
                      changeCue(index, { startSeconds: value ?? undefined })
                    }
                  />
                  <InputNumber
                    aria-label={`第 ${index + 1} 句终点（秒）`}
                    placeholder="终点（秒）"
                    min={0}
                    max={15}
                    step={0.1}
                    value={cue.endSeconds}
                    disabled={blocked}
                    onChange={(value) =>
                      changeCue(index, { endSeconds: value ?? undefined })
                    }
                  />
                  <Select
                    aria-label={`第 ${index + 1} 句发言人`}
                    placeholder="发言人"
                    value={cue.roleId}
                    disabled={blocked}
                    options={roles
                      .filter((role) =>
                        assignments.some((item) => item.roleId === role.id),
                      )
                      .map((role) => ({ value: role.id, label: role.name }))}
                    onChange={(roleId) => changeCue(index, { roleId })}
                  />
                  <Space.Compact>
                    <Input
                      aria-label={`第 ${index + 1} 句对白`}
                      placeholder="对白"
                      maxLength={120}
                      value={cue.text}
                      disabled={blocked}
                      onChange={(event) =>
                        changeCue(index, { text: event.target.value })
                      }
                    />
                    <Button
                      disabled={blocked}
                      aria-label={`移除第 ${index + 1} 句`}
                      onClick={() =>
                        set({
                          dialogue: dialogue.filter((_, i) => i !== index),
                        })
                      }
                    >
                      移除
                    </Button>
                  </Space.Compact>
                </div>
              ))}
              {assignments.length > 0 && (
                <Button
                  disabled={blocked || dialogue.length >= 12}
                  onClick={() =>
                    set({
                      dialogue: [
                        ...dialogue,
                        {
                          startSeconds: dialogue.at(-1)?.endSeconds ?? 0,
                          text: "",
                        },
                      ],
                    })
                  }
                >
                  新增对白
                </Button>
              )}
              <Checkbox
                checked={Boolean(setup.authorized)}
                disabled={blocked}
                onChange={(event) => set({ authorized: event.target.checked })}
              >
                我已取得角色肖像、声音和素材的使用授权，同意生成时将选中的素材交给视频服务。
              </Checkbox>
              <Space wrap>
                <Button
                  disabled={blocked || !ready}
                  onClick={() => void save(false)}
                >
                  保存镜头绑定
                </Button>
                <Button
                  type="primary"
                  disabled={
                    blocked || !ready || !modelSupported || !model?.configured
                  }
                  onClick={() =>
                    modal.confirm({
                      title: "生成绑定片段？",
                      content:
                        "只提交此片段。生成视频和灰模参考按当前模型计费。",
                      okText: "提交生成",
                      cancelText: "取消",
                      onOk: () => save(true),
                    })
                  }
                >
                  生成绑定片段
                </Button>
                {project.cozyclay && (
                  <Button
                    disabled={blocked}
                    onClick={() => void save(false, null)}
                  >
                    清除绑定
                  </Button>
                )}
              </Space>
            </Space>
          ),
        },
      ]}
    />
  );
}
