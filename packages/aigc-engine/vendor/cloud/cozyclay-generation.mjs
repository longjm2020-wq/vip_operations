import { selectedCast } from "../shared/project-cast.mjs";
import { projectMediaReferences } from "./media-references.mjs";

export function prepareCozyClayGeneration(store, project, route, artifacts) {
  const binding = project.cozyclay;
  if (!binding) throw Error("请先保存 CozyClay 镜头绑定");
  if (
    route.protocol !== "bailian" ||
    route.model.id !== "minimax-h3" ||
    route.model.mediaReferences?.audio?.field !== "driving_audio"
  )
    throw Error("预演镜头使用百炼 MiniMax-H3 多模态视频模式");
  const unit = artifacts.units.find((item) => item.id === binding.unitId);
  if (!unit) throw Error("编译片段已变化，请重新绑定预演镜头");
  if (!artifacts.referenceSnapshot?.assets)
    throw Error("旧版编译记录缺少素材锁定清单，请重新拆解");
  const greyboxDuration = binding.greybox.mediaInfo?.durationSeconds;
  if (
    !Number.isFinite(greyboxDuration) ||
    Math.abs(greyboxDuration - unit.duration_s) > 0.75
  )
    throw Error(
      "灰模视频与编译片段时长差超过 0.75 秒，请重新导出或选择对应片段",
    );
  const shot = binding.project.mediaInfo.cozyclay.shots.find(
    (item) => item.id === binding.sourceShotId,
  );
  const cast = selectedCast(project);
  const unitRoles = new Set(
    unit.character_ids || cast.roles.map((role) => role.id),
  );
  const roles = new Map(
    cast.roles
      .filter((role) => unitRoles.has(role.id))
      .map((role) => [role.id, role]),
  );
  if (
    binding.assignments.some(
      ({ roleId }) => !roles.get(roleId)?.images?.length,
    ) ||
    binding.assignments.length !== shot.characters.length
  )
    throw Error("请为工程镜头中的每个出镜角色绑定本片段的人物原图");
  const assignedImages = binding.assignments.flatMap(({ roleId }) =>
    roles.get(roleId).images.map((image) => image.path),
  );
  if (new Set(assignedImages).size !== assignedImages.length)
    throw Error("同框角色不能共用一张人物原图");
  const audioDuration = binding.dialogueAudio?.mediaInfo?.durationSeconds;
  if (
    binding.dialogue.length &&
    (!Number.isFinite(audioDuration) ||
      Math.abs(audioDuration - unit.duration_s) > 0.75 ||
      binding.dialogue.some(
        (cue) =>
          cue.endSeconds > Math.min(unit.duration_s, audioDuration) + 0.05,
      ))
  )
    throw Error(
      "对白须在编译片段及驱动音频范围内，音频与片段时长差不得超过 0.75 秒",
    );
  const assets = {
    ...artifacts.referenceSnapshot.assets,
    referenceVideos: [binding.greybox],
    referenceAudios: binding.dialogueAudio ? [binding.dialogueAudio] : [],
  };
  const inputProject = { ...project, assets };
  projectMediaReferences(store, inputProject, route);
  const names = binding.assignments.map(({ subjectId, roleId }) => {
    const character = shot.characters.find((item) => item.id === subjectId);
    return `${roles.get(roleId).name}（角色 ${roleId}）与灰模角色 ${character.name || character.id} 对应`;
  });
  const cues = binding.dialogue.map(
    (cue) =>
      `${cue.startSeconds}–${cue.endSeconds} 秒只有 ${roles.get(cue.roleId).name}（${cue.roleId}）说“${cue.text}”`,
  );
  const cozyclayDirection = [
    `执行本片段的 CozyClay 镜头“${shot.name}”（第 ${shot.startFrame}–${shot.endFrame} 帧）。灰模视频覆盖本片段的机位、走位、时间和道具轨迹。人物与商品外观以原图为准。交接只改变道具当时的持有者，保持同一件商品的设计和身份。`,
    names.join("。"),
    binding.direction,
    ...(cues.length
      ? [
          `驱动音频与指定说话人轮流对应，其他人闭口，不交换声音；以准确对白时点为准。${cues.join("。")}`,
        ]
      : []),
  ]
    .filter(Boolean)
    .join("\n");
  return {
    ...artifacts,
    units: [{ ...unit, cozyclayDirection }],
    referenceSnapshot: { ...artifacts.referenceSnapshot, assets },
    cozyclay: { unitId: unit.id, sourceShotId: shot.id },
  };
}
