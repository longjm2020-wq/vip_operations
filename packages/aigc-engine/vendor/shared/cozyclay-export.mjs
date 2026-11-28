/**
 * 将服装口播分镜脚本转换为 CozyClay 第 5 版 (.cclayproject) 工程 JSON。
 * 导出结果严格遵循 packages/aigc-engine/vendor/shared/cozyclay.mjs 中的 inspectCozyClayProject 校验规则。
 */

const FPS = 24;

function sanitizeId(value, fallback) {
  const cleaned = String(value || "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 64);
  return cleaned || fallback;
}

function shortText(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

/**
 * 根据工作流分镜、角色、道具与场景生成标准 CozyClay v5 工程对象。
 * @param {object} input
 * @param {string} input.workflowId 工作流 ID
 * @param {string} input.title 项目名称
 * @param {Array<{id?: string, name: string}>} [input.characters] 角色列表
 * @param {Array<{id?: string, name: string, note?: string}>} [input.props] 道具/商品列表
 * @param {Array<{id: string, title?: string, type?: string, caption?: string, camera?: string, action?: string, props?: string, scene?: string, characterNames?: string[], durationSec?: number}>} input.shots 分镜列表
 */
export function buildCozyClayProjectV5(input) {
  const projectName = shortText(input?.title, 100) || "服装口播预演工程";
  const rawCharacters =
    Array.isArray(input?.characters) && input.characters.length
      ? input.characters
      : [{ id: "char_presenter", name: "主播" }];

  const stageCharacters = rawCharacters.slice(0, 8).map((char, index) => ({
    id: sanitizeId(char.id, `char_${index + 1}`),
    subject: shortText(char.name, 120) || `角色 ${index + 1}`,
    position: { x: (index - (rawCharacters.length - 1) / 2) * 1.2, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
  }));

  const characterByName = new Map(
    stageCharacters.map((c) => [c.subject.toLowerCase(), c.id]),
  );

  const stageProps = (Array.isArray(input?.props) ? input.props : [])
    .slice(0, 12)
    .map((prop, index) => ({
      id: sanitizeId(prop.id, `prop_${index + 1}`),
      name: shortText(prop.name, 80) || `道具 ${index + 1}`,
      note: shortText(prop.note, 200),
      position: { x: 0.6 + index * 0.35, y: 0.9, z: 0.4 },
    }));

  const rawShots =
    Array.isArray(input?.shots) && input.shots.length
      ? input.shots.slice(0, 50)
      : [
          {
            id: "shot_01",
            title: "开场口播",
            durationSec: 5,
            camera: "中景正机位",
            action: "主播微笑开场并展示服装版型",
          },
        ];

  let cursorFrame = 0;
  const shots = rawShots.map((shot, index) => {
    const durationSec = Math.max(
      2,
      Math.min(30, Number(shot.durationSec) || 5),
    );
    const spanFrames = Math.max(24, Math.round(durationSec * FPS));
    const startFrame = cursorFrame;
    const endFrame = cursorFrame + spanFrames;
    cursorFrame = endFrame;

    const matchedIds = Array.isArray(shot.characterNames)
      ? shot.characterNames
          .map((name) => characterByName.get(String(name).trim().toLowerCase()))
          .filter(Boolean)
      : [];
    const subjectIds = matchedIds.length
      ? [...new Set(matchedIds)]
      : [stageCharacters[0].id];

    return {
      id: sanitizeId(shot.id, `shot_${String(index + 1).padStart(2, "0")}`),
      name:
        shortText(shot.title, 100) ||
        `分镜 ${index + 1}${shot.type === "talking_head" ? " · 口播" : ""}`,
      startFrame,
      endFrame,
      subjectIds,
      notes: [
        shot.camera ? `机位：${shortText(shot.camera, 200)}` : "",
        shot.action ? `动作：${shortText(shot.action, 300)}` : "",
        shot.props ? `道具：${shortText(shot.props, 160)}` : "",
        shot.caption ? `台词：${shortText(shot.caption, 180)}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  });

  const sceneId = sanitizeId(input?.workflowId, "scene_main");
  return {
    app: "cozyclay",
    kind: "project",
    version: 5,
    name: projectName,
    fps: FPS,
    aspectRatio: "9:16",
    scenes: {
      activeSceneId: sceneId,
      scenes: [
        {
          id: sceneId,
          name: shortText(rawShots[0]?.scene, 80) || "服装口播主场景",
          stage: {
            characters: stageCharacters,
            props: stageProps,
          },
          shotDocument: {
            fps: FPS,
            frameCount: Math.max(cursorFrame, FPS * 5),
            shots,
          },
        },
      ],
    },
  };
}
