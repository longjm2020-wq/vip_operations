const identifier = /^[\w-]{1,128}$/u;
const asId = (value) =>
  typeof value === "string" && identifier.test(value) ? value : "";
const short = (value, limit) =>
  typeof value === "string" ? value.trim().slice(0, limit) : "";
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);

export function inspectCozyClayProject(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw Error("CozyClay 工程不是有效的 JSON");
  }
  if (
    data?.app !== "cozyclay" ||
    data.kind !== "project" ||
    data.version !== 5 ||
    !Array.isArray(data.scenes?.scenes) ||
    data.scenes.scenes.length > 50
  ) {
    throw Error("请选择 CozyClay 导出的第 5 版 .cclayproject 工程");
  }
  const shots = [];
  const ids = new Set();
  for (const scene of data.scenes.scenes) {
    const document = scene?.shotDocument;
    if (
      !asId(scene?.id) ||
      !Array.isArray(document?.shots) ||
      document.shots.length > 100 ||
      !Number.isSafeInteger(document.frameCount)
    )
      throw Error("CozyClay 工程中的镜头列表无效");
    const sceneName = short(scene.name, 80);
    const subjects = new Map(
      (Array.isArray(scene.stage?.characters) ? scene.stage.characters : [])
        .filter((character) => asId(character?.id))
        .map((character) => [character.id, short(character.subject, 120)]),
    );
    for (const shot of document.shots) {
      const id = asId(shot?.id);
      const { startFrame, endFrame } = shot || {};
      if (
        !id ||
        ids.has(id) ||
        !Number.isSafeInteger(startFrame) ||
        !Number.isSafeInteger(endFrame) ||
        startFrame < 0 ||
        endFrame <= startFrame ||
        endFrame > document.frameCount
      )
        throw Error("CozyClay 工程中的镜头编号或帧范围无效");
      ids.add(id);
      const characters = [
        ...new Set(
          Array.isArray(shot.subjectIds)
            ? shot.subjectIds.filter((subjectId) => subjects.has(subjectId))
            : [],
        ),
      ].map((subjectId) => ({ id: subjectId, name: subjects.get(subjectId) }));
      shots.push({
        id,
        name: short(shot.name, 100) || id,
        sceneName,
        startFrame,
        endFrame,
        characters,
      });
    }
  }
  if (!shots.length)
    throw Error("工程中没有已保存的镜头，请先在 CozyClay 中创建镜头并导出工程");
  if (shots.length > 100) throw Error("本次导入最多支持 100 个 CozyClay 镜头");
  return { name: short(data.name, 100), shots };
}

export function cleanCozyClayBinding(value, resolveAsset) {
  if (value == null) return undefined;
  if (
    !object(value) ||
    value.authorized !== true ||
    !asId(value.unitId) ||
    !asId(value.sourceShotId)
  )
    throw Error("请选择编译片段和工程镜头，并确认素材授权");
  const requireAsset = (input, kind, label) => {
    const asset = resolveAsset(input, kind);
    if (!asset) throw Error(`请上传${label}`);
    return asset;
  };
  const project = requireAsset(
    value.project,
    "cozyclayProject",
    "CozyClay 工程",
  );
  const shot = project.mediaInfo?.cozyclay?.shots?.find(
    (item) => item.id === value.sourceShotId,
  );
  if (!shot) throw Error("所选镜头不属于当前 CozyClay 工程");
  const greybox = requireAsset(
    value.greybox,
    "referenceVideo",
    "该镜头的灰模视频",
  );
  if (greybox.mediaInfo?.referenceType === "depth")
    throw Error("请使用 CozyClay 镜头的灰模视频");
  const firstFrame = resolveAsset(value.firstFrame, "scene");
  const lastFrame = resolveAsset(value.lastFrame, "scene");
  const dialogueAudio = resolveAsset(value.dialogueAudio, "referenceAudio");
  const assignments = Array.isArray(value.assignments) ? value.assignments : [];
  if (
    assignments.length > 8 ||
    new Set(assignments.map((item) => item?.subjectId)).size !==
      assignments.length ||
    new Set(assignments.map((item) => item?.roleId)).size !==
      assignments.length ||
    assignments.some(
      (item) =>
        !shot.characters.some(
          (character) => character.id === item?.subjectId,
        ) || !asId(item?.roleId),
    )
  )
    throw Error("工程角色与人物身份需要一一对应");
  const roleIds = assignments.map((item) => item.roleId);
  const dialogue = Array.isArray(value.dialogue) ? value.dialogue : [];
  if (dialogue.length > 12) throw Error("一个镜头最多支持 12 句对白");
  let lastEnd = 0;
  const cues = dialogue.map((item) => {
    const { startSeconds, endSeconds, roleId, text } = item || {};
    if (
      !Number.isFinite(startSeconds) ||
      !Number.isFinite(endSeconds) ||
      startSeconds < lastEnd ||
      endSeconds <= startSeconds ||
      endSeconds > 15 ||
      !roleIds.includes(roleId) ||
      !short(text, 120) ||
      text.trim().length > 120
    )
      throw Error("对白须按时间顺序、互不重叠，并绑定同镜中已选的发言人");
    lastEnd = endSeconds;
    return { startSeconds, endSeconds, roleId, text: text.trim() };
  });
  if (cues.length && !dialogueAudio)
    throw Error("请上传与对白时间一致的合成或录制音轨");
  return {
    authorized: true,
    unitId: value.unitId,
    sourceShotId: shot.id,
    project,
    greybox,
    ...(firstFrame ? { firstFrame } : {}),
    ...(lastFrame ? { lastFrame } : {}),
    ...(dialogueAudio ? { dialogueAudio } : {}),
    assignments: assignments.map(({ subjectId, roleId }) => ({
      subjectId,
      roleId,
    })),
    dialogue: cues,
    direction: short(value.direction, 600),
  };
}
