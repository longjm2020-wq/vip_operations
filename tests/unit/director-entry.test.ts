import { describe, expect, it } from "vitest";
import {
  directorBriefIntent,
  inferDirectorRole,
  uniqueDirectorKinds,
} from "../../packages/contracts/src/director-intent.js";
import { aiFeatures } from "../../packages/contracts/src/ai-management.js";
import {
  acceptsDirectorFolderRole,
  directorFolderRole,
  directorRoleNames,
} from "../../packages/contracts/src/director-import-roles.js";
import { directorRoles } from "../../packages/contracts/src/director.js";
import { inspectAgentUpload } from "../../apps/api/src/modules/workspace/agent-files.js";

describe("导演台对话入口与素材", () => {
  it("识别创作要求、时长、画幅、人工确认以及脚本交付", () => {
    expect(
      directorBriefIntent(
        "请用这些素材制作三十秒横屏带货视频，只给我分镜，我来确认",
      ),
    ).toEqual({
      mode: "manual",
      aspect: "16:9",
      durationMs: 30000,
      output: "script",
    });
    expect(
      directorBriefIntent(
        "帮我用这几张商品图做一条 30 秒短视频，先出分镜然后导出成片",
      )?.output,
    ).toBe("video");
    expect(directorBriefIntent("短视频怎么剪辑？")).toBeUndefined();
    expect(directorBriefIntent("帮我把产品视频复制到桌面")).toBeUndefined();
    expect(directorBriefIntent("搜索最近的短视频案例")).toBeUndefined();
  });
  it("区分参考片、商品图、授权主体和成品配音", () => {
    expect(
      inferDirectorRole(
        "1.mp4",
        "video/mp4",
        "参考这个视频做一条原创短片",
        true,
      ),
    ).toBe("reference");
    expect(
      inferDirectorRole(
        "2.jpg",
        "image/jpeg",
        "1.jpg 是产品图，2.jpg 是人物肖像",
      ),
    ).toBe("portrait");
    expect(inferDirectorRole("竞品参考.mp4", "video/mp4")).toBe("reference");
    expect(inferDirectorRole("商品面料.mp4", "video/mp4")).toBe("product");
    expect(inferDirectorRole("主播肖像.jpg", "image/jpeg")).toBe("portrait");
    expect(inferDirectorRole("正式配音.mp3", "audio/mpeg", "请克隆音色")).toBe(
      "narration",
    );
    expect(
      inferDirectorRole("录音.wav", "audio/wav", "用我的声音样本克隆口播"),
    ).toBe("voiceSample");
  });
  it("同批导入时按各文件的用途分类，通用音色要求只用于唯一的录音", () => {
    const media = [
      ["产品实拍.mp4", "video/mp4"],
      ["对标参考片.MP4", "video/mp4"],
      ["授权肖像.jpg", "image/jpeg"],
      ["声音样本.wav", "audio/wav"],
      ["正式配音.m4a", "audio/mp4"],
      ["录音03.wav", "audio/wav"],
      ["资料.pdf", "application/pdf"],
    ];
    const singles = uniqueDirectorKinds(media.map(([, mime]) => mime));
    const brief = "使用我的肖像和音色样本制作视频，拆解参考片后加入正式配音";
    expect(
      media.map(([name, mime]) =>
        inferDirectorRole(name, mime, brief, singles.has(mime.split("/")[0])),
      ),
    ).toEqual([
      "product",
      "reference",
      "portrait",
      "voiceSample",
      "narration",
      "narration",
      "document",
    ]);
    expect(
      inferDirectorRole(
        "2.wav",
        "audio/wav",
        "授权音色：2.wav；正式配音：3.wav",
        false,
      ),
    ).toBe("voiceSample");
    expect(
      inferDirectorRole(
        "3.wav",
        "audio/wav",
        "授权音色：2.wav；正式配音：3.wav",
        false,
      ),
    ).toBe("narration");
    expect(
      inferDirectorRole(
        "1.wav",
        "audio/wav",
        "11.wav 用作声音样本，1.wav 是正式配音",
        false,
      ),
    ).toBe("narration");
  });
  it("区分视频画面和明确指定以视频提供的音色或配音", () => {
    expect(inferDirectorRole("授权音色.mp4", "video/mp4")).toBe("voiceSample");
    expect(inferDirectorRole("正式配音.mp4", "video/mp4")).toBe("narration");
    expect(inferDirectorRole("商品介绍-正式配音.mp4", "video/mp4")).toBe(
      "narration",
    );
    expect(
      inferDirectorRole("1.mp4", "video/mp4", "1.mp4 用作正式配音", false),
    ).toBe("narration");
    expect(
      inferDirectorRole(
        "商品素材.mp4",
        "video/mp4",
        "做产品视频，还需要一段参考片",
        true,
      ),
    ).toBe("product");
    expect(inferDirectorRole("商品带旁白.mp4", "video/mp4")).toBe("product");
  });
  it("把云端模型的设置入口和本机能力分开登记", () => {
    expect(
      aiFeatures
        .filter((f) => f.id.startsWith("director_"))
        .map((f) => [f.id, f.kind]),
    ).toEqual(
      expect.arrayContaining([
        ["director_storyboard", "structured"],
        ["director_reference", "vision_structured"],
        ["director_voice_clone", "fixed"],
        ["director_talking_head", "fixed"],
      ]),
    );
  });
  it("按最近的完整目录名识别六种素材用途", () => {
    for (const role of directorRoles)
      expect(
        directorFolderRole(`工作用包/${directorRoleNames[role]}/第一批/01`),
      ).toBe(role);
    expect(directorFolderRole("授权肖像\\参考片\\A.mp4")).toBe("reference");
    expect(directorFolderRole("商品素材/01.png")).toBe("product");
    expect(directorFolderRole("参考片旧版/文字资料")).toBeUndefined();
    expect(directorFolderRole("授权音色.wav")).toBeUndefined();
  });
  it("素材文件夹按用途检查可接收的文件种类", () => {
    expect(acceptsDirectorFolderRole("portrait", "image/jpeg")).toBe(true);
    expect(acceptsDirectorFolderRole("portrait", "video/mp4")).toBe(false);
    expect(acceptsDirectorFolderRole("voiceSample", "video/mp4")).toBe(true);
    expect(acceptsDirectorFolderRole("narration", "audio/wav")).toBe(true);
    expect(acceptsDirectorFolderRole("reference", "image/png")).toBe(false);
    expect(acceptsDirectorFolderRole("document", "image/png")).toBe(false);
    expect(acceptsDirectorFolderRole("document", "text/plain")).toBe(true);
  });
  it("用真实解码器校验上传音频，拒绝仅改后缀的文件", async () => {
    const wav = Buffer.alloc(44 + 16000);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(16000, 40);
    const result = await inspectAgentUpload("配音.wav", wav);
    expect(result.mime).toBe("audio/wav");
    expect(result.metadata.duration).toBe(1);
    await expect(
      inspectAgentUpload("假录音.mp3", Buffer.from("not a recording")),
    ).rejects.toThrow();
  });
});
