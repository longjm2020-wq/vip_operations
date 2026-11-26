import { describe, expect, it } from "vitest";
import {
  desktopFolderCreationPlan,
  desktopFolderCreationPlanSchema,
  desktopFolderCreationRequest,
  desktopFolderNotesIntent,
  looksLikeDesktopFolderCreation,
  looksLikeDesktopFolderNotes,
} from "../../packages/contracts/src/desktop-folder-creation.js";
import {
  classifyAssistantExecution,
  desktopExplorerIntent,
  shouldSearchAssistantPublicWeb,
} from "../../packages/contracts/src/assistant-execution.js";

const batch =
  "在我的电脑桌面新建文件夹「测试自动化999」，然后在这个文件夹中新建十个子文件夹，命名为 XUTI-01 至 XUTI-10";
const expected = {
  parentName: "测试自动化999",
  folderNames: Array.from(
    { length: 10 },
    (_, index) => `XUTI-${String(index + 1).padStart(2, "0")}`,
  ),
};

describe("Windows Desktop folder creation plans", () => {
  it.each([
    batch,
    '在我的电脑桌面新建文件夹"测试自动化999"，并在文件内新建10个文件夹，命名规则按"XUTI-01......XUTI-n"',
    "在我的电脑桌面新建文件夹“测试自动化999”，并在文件夹内新建10个文件夹，命名规则按“XUTI-01……XUTI-10”。",
    "在我的电脑桌面新建文件夹「测试自动化999」，并在文件夹内新建10个文件夹，命名规则按「XUTI-01……XUTI-10」",
    batch + "，在后台执行，不要占用鼠标，也不要动键盘。",
    "请在后台静默执行，" + batch,
    "静默执行：" + batch,
    batch + "，后台静默执行，不打开窗口。",
    batch + "，静默执行，别弹出任何窗口。",
    batch.replace("XUTI-01 至 XUTI-10", "「XUTI-01......XUTI-n」"),
    batch.replace("XUTI-01 至 XUTI-10", "XUTI-01……XUTI-n"),
    "请在后台执行，在本机桌面先创建一个叫「测试自动化999」的文件夹，并在里面批量创建10个子目录，名称为XUTI-01~XUTI-10。",
    "在桌面文件夹「测试自动化999」里面批量新建子目录：XUTI-01到XUTI-10，在后台执行。",
  ])(
    "expands exact numbered names from a single requested batch: %s",
    (text) => {
      expect(desktopFolderCreationPlan(text)).toEqual(expected);
      expect(classifyAssistantExecution(text)).toEqual({ kind: "desktop" });
    },
  );

  it("preserves quoted names and the requested device", () => {
    const text =
      "小序，请在电脑「样品室」的桌面创建文件夹“Ａ区”，然后在里面新建 3 个子文件夹，分别叫「秋、冬」、样品 A 和「纸样」";
    expect(desktopFolderCreationRequest(text)).toEqual({
      deviceName: "样品室",
      plan: { parentName: "Ａ区", folderNames: ["秋、冬", "样品 A", "纸样"] },
    });
    expect(classifyAssistantExecution(text)).toEqual({
      kind: "desktop",
      deviceName: "样品室",
    });
    expect(desktopFolderCreationRequest(batch)?.deviceName).toBeUndefined();
  });

  it("keeps mouse preferences out of an explicit directory list", () => {
    const text = "在桌面文件夹『样品』里面批量创建子目录：春款、夏款";
    expect(desktopFolderCreationPlan(text + "，别动鼠标")).toEqual({
      parentName: "样品",
      folderNames: ["春款", "夏款"],
    });
    expect(desktopFolderCreationPlan(text + "、『别动鼠标』")).toEqual({
      parentName: "样品",
      folderNames: ["春款", "夏款", "别动鼠标"],
    });
    expect(desktopFolderCreationPlan(text + "、『请勿打扰我』")).toEqual({
      parentName: "样品",
      folderNames: ["春款", "夏款", "请勿打扰我"],
    });
  });

  it.each([
    batch.replace("十个", "九个"),
    batch.replace("十个", "").replace("XUTI-01 至 XUTI-10", "XUTI-01……XUTI-n"),
    batch.replace("XUTI-01 至 XUTI-10", "XUTI-01 至 XUTI-110"),
    batch.replace("XUTI-01 至 XUTI-10", "XUTI-01 至 XUTI-010"),
    batch.replace("XUTI-01 至 XUTI-10", "XUTI-10 至 XUTI-01"),
    batch.replace("XUTI-01 至 XUTI-10", "XUTI-01 至 XUTI-XX"),
    batch.replace("XUTI-01 至 XUTI-10", "XUTI-01 至 OTHER-10"),
    batch.replace("测试自动化999", "../归档"),
    batch.replace("测试自动化999", ""),
    batch + "，然后打开记事本",
    batch + "，并执行脚本",
    "在桌面新建文件夹「样品」，在里面创建两个子文件夹，分别叫 A、a",
    "在桌面文件夹『样品』里面批量创建子目录：春款、夏款，不要修改原文件",
    "在桌面文件夹『样品』里面批量创建子目录：春款、夏款，也不要修改原文件",
    "在桌面文件夹『样品』里面批量创建子目录：春款、夏款，请勿打扰我",
  ])("routes malformed or mixed batches to clarification: %s", (text) => {
    expect(looksLikeDesktopFolderCreation(text)).toBe(true);
    expect(desktopFolderCreationPlan(text)).toBeUndefined();
  });

  it.each([
    "不要" + batch,
    "如何" + batch,
    "给个示例：" + batch,
    batch + "吗？",
    batch.replace("电脑桌面", "电脑浏览器"),
  ])("ignores explanations, negations and other locations: %s", (text) => {
    expect(looksLikeDesktopFolderCreation(text)).toBe(false);
    expect(desktopFolderCreationPlan(text)).toBeUndefined();
  });

  it("lets the existing visual flow handle a folder plus a document", () => {
    const text =
      "在我的电脑桌面新建文件夹命名“自动化测试1126”，并在文件夹内新建两个子文件夹和1个记事本，在记事本内写入“自动化测试666”";
    expect(looksLikeDesktopFolderCreation(text)).toBe(false);
    expect(desktopExplorerIntent(text)).toBe("folder");
  });

  it.each([
    "..",
    ".hidden",
    "C:root",
    "a/b",
    "a\\b",
    "aux.txt",
    "NUL .txt",
    "lpt²",
    "tail.",
    "tail ",
    "bad\u202e",
    "hidden\u0000",
    "a".repeat(101),
  ])("rejects invalid Windows folder names: %s", (name) => {
    expect(
      desktopFolderCreationPlanSchema.safeParse({
        parentName: name,
        folderNames: ["child"],
      }).success,
    ).toBe(false);
    expect(
      desktopFolderCreationPlanSchema.safeParse({
        parentName: "parent",
        folderNames: [name],
      }).success,
    ).toBe(false);
  });
});

describe("empty documents for the previous verified folder batch", () => {
  const followup = "在每个子文件夹内新建一个记事本，命名按文件夹名命名";

  it.each([
    followup,
    "请在后台静默执行，" + followup,
    "静默执行：" + followup,
    followup + "，后台静默执行，不打开窗口。",
    followup + "，静默执行，别弹出任何窗口。",
    "请在各个子目录里创建一个空白文本文档，名称以子目录名称为名。",
    "接着请在刚建好的每个子目录下新建一个同名的空白 .txt 文件。",
    "在所有子文件夹内建立同名纯文本文件，在后台执行，不要占用鼠标。",
  ])(
    "recognizes a standalone instruction to create same-name documents: %s",
    (text) => {
      expect(desktopFolderNotesIntent(text)).toBe(true);
      expect(looksLikeDesktopFolderNotes(text)).toBe(true);
      expect(classifyAssistantExecution(text)).toEqual({ kind: "desktop" });
      expect(
        shouldSearchAssistantPublicWeb(text, { explicitSearch: true }),
      ).toBe(false);
    },
  );

  it.each([
    "在每个子文件夹内新建一个记事本",
    followup + "，再写入一段说明",
    followup + "，然后打开记事本",
    followup + "，在命令行静默执行",
    followup + "，如果有同名文件就覆盖",
    "在每个子文件夹内新建三个同名记事本",
    "在每个子文件夹里创建记事本，文件名使用 test",
  ])(
    "keeps incomplete or compound instructions out of the typed operation: %s",
    (text) => {
      expect(desktopFolderNotesIntent(text)).toBe(false);
      expect(looksLikeDesktopFolderNotes(text)).toBe(true);
    },
  );

  it.each([
    "没有反应了",
    "不要" + followup,
    "怎么才能" + followup + "？",
    followup + "会不会有问题",
    "想了解「" + followup + "」的操作方法",
    "在浏览器的每个子文件夹内新建一个同名记事本",
    "在研发电脑上" + followup,
    "后台静默执行 PowerShell 命令",
  ])(
    "does not dispatch questions, negations or arbitrary targets: %s",
    (text) => {
      expect(desktopFolderNotesIntent(text)).toBe(false);
      expect(looksLikeDesktopFolderNotes(text)).toBe(false);
      expect(classifyAssistantExecution(text)).toEqual({ kind: "site" });
    },
  );
});
