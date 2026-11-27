import { expect, it } from "vitest";
import {
  cleanCozyClayBinding,
  inspectCozyClayProject,
  // @ts-expect-error JavaScript engine contract.
} from "../../packages/aigc-engine/vendor/shared/cozyclay.mjs";
// @ts-expect-error JavaScript engine contract.
import { prepareCozyClayGeneration } from "../../packages/aigc-engine/vendor/cloud/cozyclay-generation.mjs";
import {
  bailianVideoBody,
  bailianVideoProvider,
  // @ts-expect-error JavaScript engine contract.
} from "../../packages/aigc-engine/vendor/cloud/bailian-video.mjs";
// @ts-expect-error JavaScript engine contract.
import { prepareVideoPrompt } from "../../packages/aigc-engine/vendor/cloud/video-prompt.mjs";

function projectFile() {
  return {
    app: "cozyclay",
    kind: "project",
    version: 5,
    name: "门店机位",
    scenes: {
      scenes: [
        {
          id: "scene-1",
          name: "外套交接",
          stage: {
            characters: [
              { id: "char-a", subject: "左侧角色" },
              { id: "char-b", subject: "右侧角色" },
            ],
          },
          shotDocument: {
            frameCount: 240,
            shots: [
              {
                id: "shot-1",
                name: "接外套",
                startFrame: 0,
                endFrame: 96,
                subjectIds: ["char-a", "char-b"],
              },
            ],
          },
        },
      ],
    },
  };
}

function fixture() {
  const asset = (id: string, kind: string, name: string, mediaInfo = {}) => ({
    id,
    path: id,
    ownerId: "creator",
    projectId: "project-1",
    source: "upload",
    kind,
    name,
    size: 2000,
    mediaInfo,
  });
  const files = [
    asset("file-project", "cozyclayProject", "scene.cclayproject", {
      cozyclay: inspectCozyClayProject(JSON.stringify(projectFile())),
    }),
    asset("file-greybox", "referenceVideo", "greybox.mp4", {
      durationSeconds: 4.17,
      fps: 24,
      width: 1920,
      height: 1080,
    }),
    asset("file-audio", "referenceAudio", "dialogue.wav", {
      durationSeconds: 4,
    }),
    asset("file-start", "scene", "start.png"),
    asset("file-end", "scene", "end.png"),
  ];
  const resolve = (id: string, kind: string) =>
    files.find((item) => item.id === id && item.kind === kind);
  const store = {
    getAssetMetadata: (id: string) => files.find((item) => item.id === id),
  };
  const source = {
    authorized: true,
    unitId: "S02",
    sourceShotId: "shot-1",
    project: "file-project",
    greybox: "file-greybox",
    dialogueAudio: "file-audio",
    firstFrame: "file-start",
    lastFrame: "file-end",
    assignments: [
      { subjectId: "char-a", roleId: "presenter" },
      { subjectId: "char-b", roleId: "model" },
    ],
    dialogue: [
      {
        startSeconds: 0,
        endSeconds: 2,
        roleId: "presenter",
        text: "看这件外套。",
      },
      {
        startSeconds: 2.1,
        endSeconds: 4,
        roleId: "model",
        text: "我给你展示领口。",
      },
    ],
    direction: "在中间接过同一件外套。",
  };
  const images = [
    { path: "presenter-image", name: "presenter.png" },
    { path: "model-image", name: "model.png" },
  ];
  const products = [{ path: "product-image", name: "jacket.png" }];
  const project = {
    id: "project-1",
    ownerId: "creator",
    sceneMode: "reference",
    cozyclay: cleanCozyClayBinding(source, resolve),
    assets: { modelImages: images, productImages: products, sceneImages: [] },
    cast: {
      roles: [
        {
          id: "presenter",
          name: "主播",
          images: [images[0]],
          measurements: [],
        },
        { id: "model", name: "模特", images: [images[1]], measurements: [] },
      ],
      products: [
        {
          id: "jacket",
          name: "外套",
          roleId: "model",
          images: products,
          measurements: [],
        },
      ],
    },
  };
  const artifacts = {
    units: [
      {
        id: "S01",
        duration_s: 4,
        character_ids: ["presenter"],
        product_ids: [],
      },
      {
        id: "S02",
        duration_s: 4,
        character_ids: ["presenter", "model"],
        product_ids: ["jacket"],
      },
    ],
    referenceSnapshot: { assets: project.assets },
    productLock: [],
  };
  const provider = bailianVideoProvider({
    bailianWorkspaceId: "ws-fixture12345678",
  });
  const route = {
    protocol: provider.protocol,
    model: provider.models[0],
    resolution: "768P",
  };
  return { source, resolve, store, project, route, artifacts };
}

it("extracts real v5 project shot information without executing project content", () => {
  expect(inspectCozyClayProject(JSON.stringify(projectFile()))).toEqual({
    name: "门店机位",
    shots: [
      {
        id: "shot-1",
        name: "接外套",
        sceneName: "外套交接",
        startFrame: 0,
        endFrame: 96,
        characters: [
          { id: "char-a", name: "左侧角色" },
          { id: "char-b", name: "右侧角色" },
        ],
      },
    ],
  });
  const file = projectFile();
  file.scenes.scenes[0].shotDocument.shots[0].endFrame = 1000;
  expect(() => inspectCozyClayProject(JSON.stringify(file))).toThrow(/帧范围/);
  expect(() =>
    inspectCozyClayProject(JSON.stringify({ ...projectFile(), version: 4 })),
  ).toThrow(/第 5 版/);
});

it("rejects mismatched shots, cue timing, and absent recorded or composed audio", () => {
  const { source, resolve } = fixture();
  expect(() =>
    cleanCozyClayBinding({ ...source, authorized: false }, resolve),
  ).toThrow(/确认素材授权/);
  expect(() =>
    cleanCozyClayBinding({ ...source, sourceShotId: "other" }, resolve),
  ).toThrow(/不属于当前/);
  expect(() =>
    cleanCozyClayBinding({ ...source, dialogueAudio: undefined }, resolve),
  ).toThrow(/上传.*音轨/);
  const overlap = [
    source.dialogue[0],
    { ...source.dialogue[1], startSeconds: 1 },
  ];
  expect(() =>
    cleanCozyClayBinding({ ...source, dialogue: overlap }, resolve),
  ).toThrow(/互不重叠/);
  expect(() =>
    cleanCozyClayBinding(
      {
        ...source,
        assignments: [
          source.assignments[0],
          { ...source.assignments[1], roleId: "presenter" },
        ],
      },
      resolve,
    ),
  ).toThrow(/一一对应/);
});

it("submits exactly one compiled unit via native Bailian greybox and driving audio media types", () => {
  const { store, project, route, artifacts } = fixture();
  const generation = prepareCozyClayGeneration(
    store,
    project,
    route,
    artifacts,
  );
  expect(generation.units).toHaveLength(1);
  expect(generation.units[0].id).toBe("S02");
  expect(
    generation.referenceSnapshot.assets.referenceVideos.map(
      (item: { path: string }) => item.path,
    ),
  ).toEqual(["file-greybox"]);
  expect(
    generation.referenceSnapshot.assets.referenceAudios.map(
      (item: { path: string }) => item.path,
    ),
  ).toEqual(["file-audio"]);
  const result = prepareVideoPrompt(
    { ...project, assets: generation.referenceSnapshot.assets },
    generation.units[0],
    3,
    [],
    route.model,
    false,
  );
  expect(result.roleBinding.roleCount).toBe(2);
  expect(result.prompt).toContain("0–2 秒只有 主播（presenter）说");
  expect(result.prompt).toContain("2.1–4 秒只有 模特（model）说");
  expect(result.prompt).toContain("在中间接过同一件外套");
  const input = bailianVideoBody(route, {
    prompt: result.prompt,
    duration: 4,
    aspectRatio: "16:9",
    referenceImages: [
      "https://media.test/presenter.png",
      "https://media.test/model.png",
      "https://media.test/product.png",
    ],
    referenceVideos: ["https://media.test/greybox.mp4"],
    referenceAudios: ["https://media.test/dialogue.wav"],
  });
  expect(input.input.media.map((item: { type: string }) => item.type)).toEqual([
    "image_url",
    "image_url",
    "image_url",
    "feature",
    "driving_audio",
  ]);
  expect(artifacts.units).toHaveLength(2);
  expect(() =>
    prepareCozyClayGeneration(
      store,
      project,
      { ...route, protocol: "other" },
      artifacts,
    ),
  ).toThrow(/百炼 MiniMax-H3/);
  expect(() =>
    prepareCozyClayGeneration(
      store,
      { ...project, ownerId: "another" },
      route,
      artifacts,
    ),
  ).toThrow(/不属于当前项目/);
  expect(() =>
    prepareCozyClayGeneration(
      store,
      { ...project, cozyclay: { ...project.cozyclay, unitId: "S01" } },
      route,
      artifacts,
    ),
  ).toThrow(/人物原图/);
});
