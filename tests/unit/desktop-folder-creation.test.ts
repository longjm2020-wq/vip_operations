import { describe, expect, it } from "vitest";
import {
  desktopFolderAttachmentRequest,
  desktopFolderAttachmentFollowup,
  desktopFolderAttachmentTargetPolicy,
  desktopFolderAttachmentSchema,
  desktopFolderAttachmentsSchema,
  desktopFolderBatchAttachmentRequest,
  desktopFolderCompoundRequest,
  desktopFolderCreationPlan,
  desktopFolderCreationPlanSchema,
  desktopFolderCreationRequest,
  desktopFolderNotesIntent,
  desktopFolderNotesSteps,
  desktopFolderSteps,
  looksLikeDesktopFolderAttachment,
  looksLikeDesktopFolderBatchAttachment,
  looksLikeDesktopFolderCompound,
  looksLikeDesktopFolderCreation,
  looksLikeDesktopFolderNotes,
} from "../../packages/contracts/src/desktop-folder-creation.js";
import {
  assistantFollowupAnchor,
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
      steps: ["ensure_directories", "verify"],
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

describe("target folder policy for attachment distribution and original-task retries", () => {
  const singular = "把这张图复制到桌面「样品」里的「春款」";
  const batch = "把这些附件复制到桌面「样品」下的子目录：春款、夏款";
  const followup = "把这些图片复制到刚才建好的每个子目录";
  const compound =
    "在桌面「样品」下新建两个子目录：春款、夏款，然后把这些图片复制到每个子目录";

  it("defaults to completing the original targets, including explicit and relative copy", () => {
    for (const instruction of [singular, batch, followup, compound]) {
      expect(desktopFolderAttachmentTargetPolicy(instruction)).toBe(
        "create-missing",
      );
    }
    expect(desktopFolderAttachmentRequest(singular)?.plan.folderNames).toEqual([
      "春款",
    ]);
    expect(
      desktopFolderBatchAttachmentRequest(batch)?.plan.folderNames,
    ).toEqual(["春款", "夏款"]);
    expect(desktopFolderAttachmentFollowup(followup)).toEqual({
      source: "image",
      quantity: "multiple",
    });
    expect(desktopFolderBatchAttachmentRequest(compound)?.mode).toBe("create");
  });

  it.each([
    "只用已有目录，" + singular,
    singular + "，不要新建文件夹。",
    singular + "。 ，不要新建文件夹",
    singular + "，不自动创建目录",
    singular + "，禁止补建任何缺失子目录",
    "请在后台静默执行，只用已有目录，" + singular,
    singular + "，仅使用已存在的目录，并且不打开窗口。",
  ])(
    "retains the copy scope and flags the explicit no-create rule: %s",
    (instruction) => {
      expect(desktopFolderAttachmentTargetPolicy(instruction)).toBe(
        "existing-only",
      );
      expect(desktopFolderAttachmentRequest(instruction)).toMatchObject({
        existingOnly: true,
        plan: { parentName: "样品", folderNames: ["春款"] },
      });
      expect(looksLikeDesktopFolderAttachment(instruction)).toBe(true);
    },
  );

  it("uses the same restriction for batches and verified relative destinations", () => {
    expect(
      desktopFolderBatchAttachmentRequest(batch + "，禁止新建目录"),
    ).toMatchObject({
      existingOnly: true,
      mode: "existing",
      plan: { parentName: "样品", folderNames: ["春款", "夏款"] },
    });
    expect(
      desktopFolderAttachmentFollowup(followup + "，只用已有目录"),
    ).toEqual({
      source: "image",
      quantity: "multiple",
      existingOnly: true,
    });
    expect(
      desktopFolderAttachmentTargetPolicy(followup + "，只用已有目录"),
    ).toBe("existing-only");
  });

  it("accepts an explicit missing-folder creation clause without adding it as a target", () => {
    const direct = batch + "，缺目录就自动创建目录";
    expect(
      desktopFolderBatchAttachmentRequest(direct)?.plan.folderNames,
    ).toEqual(["春款", "夏款"]);
    expect(desktopFolderAttachmentTargetPolicy(direct)).toBe("create-missing");
    expect(
      desktopFolderAttachmentFollowup(followup + "，自动补齐缺失子目录"),
    ).toEqual({ source: "image", quantity: "multiple" });
    expect(
      desktopFolderBatchAttachmentRequest(compound + "，缺目录就自动创建目录")
        ?.mode,
    ).toBe("create");
  });

  it.each([
    batch + "，跳过缺失",
    batch + "，跳过不存在的目录",
    batch + "，缺目录就跳过",
    followup + "，找不到就略过",
    followup + "，缺少的跳过",
    "把这张图复制到刚才建好的每个文件夹，目录不存在就忽略",
    singular + "，只用已有目录，缺目录就自动创建目录",
    compound + "，禁止新建文件夹",
  ])(
    "requires clarification for skipped targets or conflicting rules: %s",
    (instruction) => {
      expect(desktopFolderAttachmentTargetPolicy(instruction)).toBe(
        "unsupported",
      );
      expect(desktopFolderAttachmentRequest(instruction)).toBeUndefined();
      expect(desktopFolderBatchAttachmentRequest(instruction)).toBeUndefined();
      expect(desktopFolderAttachmentFollowup(instruction)).toBeUndefined();
      expect(
        looksLikeDesktopFolderBatchAttachment(instruction) ||
          looksLikeDesktopFolderAttachment(instruction),
      ).toBe(true);
    },
  );

  it("keeps policy-like words inside literal folder names", () => {
    const instruction =
      "把这些附件复制到桌面「禁止新建目录」下的子目录：『跳过缺失』、『只用已有目录』";
    expect(desktopFolderAttachmentTargetPolicy(instruction)).toBe(
      "create-missing",
    );
    expect(desktopFolderBatchAttachmentRequest(instruction)?.plan).toEqual({
      parentName: "禁止新建目录",
      folderNames: ["跳过缺失", "只用已有目录"],
    });
    expect(
      desktopFolderAttachmentRequest("怎么" + singular + "，不要新建文件夹？"),
    ).toBeUndefined();
  });
});

describe("typed multi-file distribution to new or existing folders", () => {
  const folders =
    '在我的电脑桌面新建父文件夹"测试自动化666"，并在文件内新建100个子文件夹，命名规则按"XUTI-01……XUTI-n"';
  const copy = "把这些图片复制进每一个子文件夹";
  const screenshot = folders + "，然后" + copy;
  const createSteps = ["ensure_directories", "copy_attachments", "verify"];
  const copySteps = ["copy_attachments", "verify"];

  it("compiles the screenshot into verified folders before distributing all chosen images", () => {
    const plan = desktopFolderBatchAttachmentRequest(screenshot);
    expect(plan).toEqual({
      plan: {
        parentName: "测试自动化666",
        folderNames: Array.from(
          { length: 100 },
          (_, i) => `XUTI-${String(i + 1).padStart(2, "0")}`,
        ),
      },
      deviceName: undefined,
      steps: createSteps,
      source: "image",
      quantity: "multiple",
      mode: "create",
    });
    expect(looksLikeDesktopFolderBatchAttachment(screenshot)).toBe(true);
    expect(desktopFolderCreationPlan(screenshot)).toBeUndefined();
    expect(desktopFolderSteps("create_folders_with_attachments")).toEqual(
      plan?.steps,
    );
    expect(classifyAssistantExecution(screenshot)).toEqual({ kind: "desktop" });
  });

  it.each([
    [
      "在桌面「海报组✨」下新建三个子目录：『春、夏』、商品 B、夏日2",
      "把所附文件分发到这些目录，保留原文件名",
    ].join("；"),
    [
      "- 在桌面「海报组✨」下创建三个子目录：『春、夏』、商品 B、夏日2",
      "- 把附件一起复制到每个子目录，不打开窗口",
    ].join("\n"),
    [
      "一、在桌面新建文件夹「海报组✨」",
      "二、在文件夹内新建三个子目录：『春、夏』、商品 B、夏日2",
      "三、将所附文件分发到这些目录。",
    ].join("\r\n"),
  ])(
    "preserves exact named targets across connector and layout variants: %s",
    (text) => {
      expect(desktopFolderBatchAttachmentRequest(text)).toMatchObject({
        mode: "create",
        steps: createSteps,
        source: "attachment",
        quantity: "selected",
        plan: {
          parentName: "海报组✨",
          folderNames: ["春、夏", "商品 B", "夏日2"],
        },
      });
    },
  );

  it("retains a single existing child or a whole explicit batch without assuming what '附件' refers to", () => {
    const explicit =
      "在设备「出样电脑」上把附件复制到桌面『样衣归档』下的子文件夹「核对完成」";
    expect(desktopFolderBatchAttachmentRequest(explicit)).toEqual({
      plan: { parentName: "样衣归档", folderNames: ["核对完成"] },
      deviceName: "出样电脑",
      steps: copySteps,
      source: "attachment",
      quantity: "selected",
      mode: "existing",
    });
    expect(desktopFolderAttachmentRequest(explicit)?.steps).toEqual([
      "copy_attachment",
      "verify",
    ]);
    expect(
      desktopFolderBatchAttachmentRequest(
        "这些图片一起复制到桌面样品下的两个子目录（A、B）",
      ),
    ).toMatchObject({
      plan: { parentName: "样品", folderNames: ["A", "B"] },
      steps: copySteps,
      source: "image",
      quantity: "multiple",
      mode: "existing",
    });
    expect(
      desktopFolderBatchAttachmentRequest(
        "把这张图复制到桌面『样衣归档』下的子文件夹「核对完成」",
      ),
    ).toBeUndefined();
  });

  it.each([
    [
      "把这些附件复制到桌面“样品”下的子文件夹（春款、夏款、秋款），每个文件夹一份",
      ["春款", "夏款", "秋款"],
      "multiple",
    ],
    ["把附件复制到桌面“样品”里的“春款”和“夏款”", ["春款", "夏款"], "selected"],
    [
      "把它们复制到桌面“样品”里的“春款”和“夏款”，每个文件夹各一份",
      ["春款", "夏款"],
      "multiple",
    ],
    ["把这几份复制到桌面“样品”下的子文件夹（秋款）", ["秋款"], "multiple"],
    ["将选中的文件分发到桌面“样品”里的“冬款”", ["冬款"], "selected"],
  ] as const)(
    "uses the named screenshot/example targets and selected uploads: %s",
    (text, children, quantity) => {
      expect(desktopFolderBatchAttachmentRequest(text)).toMatchObject({
        plan: { parentName: "样品", folderNames: children },
        steps: copySteps,
        source: "attachment",
        quantity,
      });
    },
  );

  it("retains explicit source counts and only treats strongly singular phrases as a single reference", () => {
    expect(
      desktopFolderBatchAttachmentRequest(
        folders + "，然后把两张图片复制到每个子文件夹",
      ),
    ).toMatchObject({
      source: "image",
      quantity: "multiple",
      attachmentCount: 2,
    });
    expect(
      desktopFolderBatchAttachmentRequest(
        screenshot + "，两张图片各一份，保留原文件名",
      ),
    ).toMatchObject({
      source: "image",
      quantity: "multiple",
      attachmentCount: 2,
    });
    expect(
      desktopFolderBatchAttachmentRequest(
        folders + "，然后把这张图复制进每个子目录",
      ),
    ).toMatchObject({
      source: "image",
      quantity: "single",
    });
    expect(
      desktopFolderBatchAttachmentRequest(
        folders + "，然后把两张图片复制到每个子文件夹，三张图片各一份",
      ),
    ).toBeUndefined();
  });

  it.each([
    screenshot.replace("100个", "101个"),
    screenshot + "，然后运行脚本",
    screenshot + "，并覆盖同名文件",
    folders + "，然后把这些图片复制到其他电脑",
    folders + "，然后一起复制到每个子目录",
    folders + "，然后把这些图片放进去",
    "把所有图片复制到桌面『样品』下所有子目录",
    "把这些图片复制到桌面『样品』下的两个子目录：A、a",
    "把这些图片复制到桌面『样品』下的两个子目录（A、B），并打开图片",
    "把这些图片复制到桌面『样品』下的子目录：A、B，上传到网盘",
    "把这些附件复制到桌面“样品”里的“春款”，然后执行命令",
  ])(
    "clarifies any incomplete or unsafe clause before either action: %s",
    (text) => {
      expect(looksLikeDesktopFolderBatchAttachment(text)).toBe(true);
      expect(desktopFolderBatchAttachmentRequest(text)).toBeUndefined();
    },
  );

  it.each([
    [copy, { source: "image", quantity: "multiple" }],
    [
      "把附件放进每一个子文件夹",
      { source: "attachment", quantity: "selected" },
    ],
    [
      "把这些附件复制到刚才建好的每个子目录",
      { source: "attachment", quantity: "multiple" },
    ],
    [
      "把这张图复制到刚才建好的每个子目录",
      { source: "image", quantity: "single" },
    ],
    [
      "将这两张图片分发到这些目录",
      { source: "image", quantity: "multiple", attachmentCount: 2 },
    ],
  ])(
    "extracts a relative request without inventing the target plan: %s",
    (text, selected) => {
      expect(desktopFolderAttachmentFollowup(text)).toEqual(selected);
      expect(desktopFolderBatchAttachmentRequest(text)).toBeUndefined();
      expect(looksLikeDesktopFolderBatchAttachment(text)).toBe(true);
      expect(classifyAssistantExecution(text)).toEqual({ kind: "desktop" });
      expect(
        desktopFolderAttachmentFollowup("怎么" + text + "？"),
      ).toBeUndefined();
    },
  );

  it("checks unique attachment IDs, Windows names and total bytes", () => {
    const first = {
      id: "bc14c94d-507d-4c4e-bcd9-fa693e9f9beb",
      name: "5.jpeg",
      bytes: 18,
      sha256: "a".repeat(64),
    };
    const second = {
      id: "26761939-6c82-4ad3-a25a-ec8e7d3b2b7e",
      name: "4.jpeg",
      bytes: 28,
      sha256: "b".repeat(64),
    };
    const files = [first, second];
    expect(desktopFolderAttachmentsSchema.parse(files)).toEqual(files);
    expect(
      desktopFolderAttachmentsSchema.safeParse([
        first,
        { ...second, id: first.id },
      ]).success,
    ).toBe(false);
    expect(
      desktopFolderAttachmentsSchema.safeParse([
        first,
        { ...second, name: "5.JPEG" },
      ]).success,
    ).toBe(false);
    expect(
      desktopFolderAttachmentsSchema.safeParse(
        files.map((file) => ({ ...file, bytes: 50 * 1024 * 1024 })),
      ).success,
    ).toBe(false);
  });

  it("only lets folder callers opt into attachment-bearing desktop anchors", () => {
    const now = new Date().toISOString();
    const user = {
      id: "request",
      role: "user" as const,
      text: screenshot,
      createdAt: now,
      attachments: [
        {
          id: "file",
          name: "5.jpeg",
          mime: "image/jpeg",
          size: 20,
          source: "upload" as const,
          createdAt: now,
        },
      ],
    };
    const reply = {
      id: "reply",
      role: "assistant" as const,
      text: "已提交",
      createdAt: now,
    };
    expect(
      assistantFollowupAnchor([user, { ...reply, desktopTaskId: "task" }]),
    ).toBeUndefined();
    expect(
      assistantFollowupAnchor(
        [user, { ...reply, desktopTaskId: "task" }],
        undefined,
        true,
      ),
    ).toEqual({
      kind: "desktop",
      requestId: "request",
      taskId: "task",
    });
    expect(
      assistantFollowupAnchor(
        [user, { ...reply, browserTaskId: "task" }],
        undefined,
        true,
      ),
    ).toBeUndefined();
  });
});

describe("one uploaded file copied to explicitly named desktop child folders", () => {
  const source =
    "把这张图复制到桌面 “测试自动化9999” 下的100个子文件夹（XUTI-01 至 XUTI-100），每个文件夹一份，保留图片原名。";
  const steps = ["copy_attachment", "verify"];
  const folderNames = Array.from(
    { length: 100 },
    (_, index) => `XUTI-${String(index + 1).padStart(2, "0")}`,
  );

  it.each([
    source,
    source.replace(/[ “”]/gu, "").replace("（", "(").replace("）", ")"),
    "请在后台静默执行：" + source,
    "复制这张图到桌面文件夹「测试自动化9999」的 100 个子目录：XUTI-01 至 XUTI-100，保留原名",
  ])("compiles the image request as one two-operation plan: %s", (text) => {
    expect(desktopFolderAttachmentRequest(text)).toEqual({
      source: "image",
      deviceName: undefined,
      plan: { parentName: "测试自动化9999", folderNames },
      steps,
    });
    expect(looksLikeDesktopFolderAttachment(text)).toBe(true);
    expect(classifyAssistantExecution(text)).toEqual({ kind: "desktop" });
    expect(shouldSearchAssistantPublicWeb(text, { explicitSearch: true })).toBe(
      false,
    );
  });

  it("preserves the named device and literal names for an ordinary attachment", () => {
    const text =
      "在设备「样品电脑」上，将这份附件分别复制到桌面目录『资料』的两个子目录（「春、夏」和商品 A），各文件夹一份，保留原始文件名。";
    expect(desktopFolderAttachmentRequest(text)).toEqual({
      source: "attachment",
      deviceName: "样品电脑",
      plan: { parentName: "资料", folderNames: ["春、夏", "商品 A"] },
      steps,
    });
    expect(classifyAssistantExecution(text)).toEqual({
      kind: "desktop",
      deviceName: "样品电脑",
    });
  });

  it.each([
    ["把附件图片复制", "image"],
    ["把这个文件复制", "attachment"],
    ["把这份文档复制", "attachment"],
    ["把上传的图片复制", "image"],
    ["将这张图片分发", "image"],
  ])(
    "binds the singular reference without changing the original-name rule: %s",
    (command, kind) => {
      const text =
        command +
        "到桌面「样品」下的两个子目录（A、B），每个文件夹一份，保留原文件名。";
      expect(desktopFolderAttachmentRequest(text)).toEqual({
        source: kind,
        deviceName: undefined,
        plan: { parentName: "样品", folderNames: ["A", "B"] },
        steps,
      });
      expect(looksLikeDesktopFolderAttachment("怎么" + text)).toBe(false);
    },
  );

  it.each([
    source.replace("100个", "99个"),
    source.replace("测试自动化9999", "C:\\不应复制"),
    source.replace("XUTI-01 至 XUTI-100", "XUTI-01 至 OTHER-100"),
    source.replace("这张图", "所有附件"),
    source.replace("保留图片原名", "改名为样品.png"),
    source.replace("保留图片原名", "并覆盖已有图片"),
    source.replace("，保留图片原名。", "，保留图片原名，并打开文件夹。"),
    "把当前附件复制到桌面『样品』下的所有子目录，保留原名",
    "将这份附件复制到桌面文件夹『资料』下的子目录：样品 A，不保留原名",
    "把这张图复制到每个子文件夹",
  ])(
    "recognizes the attempt without guessing incomplete or unsupported targets: %s",
    (text) => {
      expect(looksLikeDesktopFolderAttachment(text)).toBe(true);
      expect(desktopFolderAttachmentRequest(text)).toBeUndefined();
      expect(classifyAssistantExecution(text)).toEqual({ kind: "desktop" });
    },
  );

  it.each([
    "怎么" + source,
    source.replace(/。$/u, "可以吗？"),
    "不要" + source,
    "把这张图复制到云端网盘的子目录",
    "把这张图复制到桌面端浏览器下的两个子目录（A、B）",
    "把这张图片复制到桌面网页版下的子目录：A、B",
    "帮我分析这张图",
    "请帮我把这张图片制作成一份报告",
  ])(
    "keeps questions and unrelated attachment text out of desktop routing: %s",
    (text) => {
      expect(looksLikeDesktopFolderAttachment(text)).toBe(false);
      expect(desktopFolderAttachmentRequest(text)).toBeUndefined();
    },
  );

  it("keeps existing explicit local-path copy on its file-copy route", () => {
    const text = String.raw`把「D:\样品\照片.png」复制到「D:\已核对」`;
    expect(looksLikeDesktopFolderAttachment(text)).toBe(false);
    expect(desktopFolderAttachmentRequest(text)).toBeUndefined();
    expect(classifyAssistantExecution(text)).toEqual({ kind: "desktop" });
  });

  it("keeps attachment metadata as the original safe name, exact byte count and digest", () => {
    const metadata = {
      name: "核对照片 final.png",
      bytes: 64 * 1024 * 1024,
      sha256: "ab".repeat(32),
    };
    expect(desktopFolderAttachmentSchema.parse(metadata)).toEqual(metadata);
    expect(desktopFolderSteps("copy_folder_attachment")).toEqual(steps);
    for (const name of [
      "../a.png",
      "C:\\a.png",
      "NUL.png",
      ".hidden",
      "a. ",
      "a".repeat(181),
    ]) {
      expect(
        desktopFolderAttachmentSchema.safeParse({ ...metadata, name }).success,
      ).toBe(false);
    }
    expect(
      desktopFolderAttachmentSchema.safeParse({
        ...metadata,
        bytes: metadata.bytes + 1,
      }).success,
    ).toBe(false);
    expect(
      desktopFolderAttachmentSchema.safeParse({ ...metadata, sha256: "ab" })
        .success,
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
      expect(desktopFolderNotesSteps(text)).toEqual([
        "ensure_same_name_text",
        "verify",
      ]);
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

describe("directories and same-name documents in one batch", () => {
  const folders =
    '在我的电脑桌面新建父文件夹"测试自动化666"，并在文件内新建100个子文件夹，命名规则按"XUTI-01......XUTI-n"';
  const notes = "在每个子文件夹内新建一个记事本，命名按子文件夹名命名";
  const compound = folders + "，然后" + notes;
  const expected = {
    parentName: "测试自动化666",
    folderNames: Array.from(
      { length: 100 },
      (_, index) => `XUTI-${String(index + 1).padStart(2, "0")}`,
    ),
  };
  const steps = ["ensure_directories", "ensure_same_name_text", "verify"];

  it.each([
    compound,
    "请在后台静默执行，" + compound + "，不打开窗口。",
    folders + "接着请" + notes,
    folders + "并" + notes,
    folders + "，然后在每个子文件夹内新建一个同名文本文件",
  ])("parses both operations as one explicit plan: %s", (text) => {
    expect(desktopFolderCompoundRequest(text)?.plan).toEqual(expected);
    expect(desktopFolderCompoundRequest(text)?.steps).toEqual(steps);
    expect(looksLikeDesktopFolderCompound(text)).toBe(true);
    expect(desktopFolderCreationPlan(text)).toBeUndefined();
    expect(desktopFolderNotesIntent(text)).toBe(false);
    expect(classifyAssistantExecution(text)).toEqual({ kind: "desktop" });
    expect(shouldSearchAssistantPublicWeb(text, { explicitSearch: true })).toBe(
      false,
    );
  });

  it("preserves the named computer and literal child names", () => {
    const text =
      "在电脑「样品室」的桌面新建父文件夹「样品」，在父文件夹内建两个子目录，分别叫「商品 A」、商品 B；随后在各个子目录中创建同名空白文本文档";
    expect(desktopFolderCompoundRequest(text)).toEqual({
      deviceName: "样品室",
      plan: { parentName: "样品", folderNames: ["商品 A", "商品 B"] },
      steps,
    });
    expect(classifyAssistantExecution(text)).toEqual({
      kind: "desktop",
      deviceName: "样品室",
    });
  });

  it("never treats text quoted as a folder name as a second instruction", () => {
    const name = "春款，然后在每个子文件夹内新建同名记事本";
    const text = `在桌面新建父文件夹「样品」，在里面新建子目录，命名为「${name}」`;
    expect(looksLikeDesktopFolderCompound(text)).toBe(false);
    expect(desktopFolderCompoundRequest(text)).toBeUndefined();
    expect(desktopFolderCreationPlan(text)?.folderNames).toEqual([name]);
  });

  it.each([
    compound + "，然后打开记事本",
    compound + "，并写入「内容」",
    compound + "，并覆盖已有文件",
    compound.replace("100个", "101个"),
    compound.replace("测试自动化666", "../测试自动化666"),
    folders + "，然后在每个子文件夹内新建两个同名记事本",
    folders + "，然后在每个子文件夹内新建记事本，名称为「统一名称」",
    "在桌面新建父文件夹「样品」，在里面新建子目录，然后" + notes,
    "在桌面新建父文件夹「样品」，在里面新建10个子目录，给每个子目录生成独立报表",
    "在桌面新建父文件夹「样品」，在里面新建10个子目录，然后执行 PowerShell 脚本",
  ])("holds incomplete or mixed requests for clarification: %s", (text) => {
    expect(looksLikeDesktopFolderCompound(text)).toBe(true);
    expect(desktopFolderCompoundRequest(text)).toBeUndefined();
    expect(desktopFolderCreationPlan(text)).toBeUndefined();
    expect(classifyAssistantExecution(text)).toEqual({ kind: "desktop" });
  });

  it.each([
    [
      "1. 在我的电脑桌面新建父文件夹「测试自动化666」。",
      "2. 在父文件夹内新建100个子文件夹，命名规则按「XUTI-01......XUTI-n」；",
      "3. 在每个子文件夹内新建一个同名文本文件。",
    ].join("\n"),
    [
      "请在后台静默执行：",
      "第一步：在我的电脑桌面新建父文件夹「测试自动化666」",
      "（二）在父文件夹内新建100个子文件夹，命名按 XUTI-01 至 XUTI-100",
      "三、在每个子文件夹内新建一个记事本，命名按子文件夹名命名",
    ].join("\r\n"),
  ])(
    "preserves the numbered sequence until the whole request is valid: %s",
    (text) => {
      expect(desktopFolderCompoundRequest(text)).toEqual({
        plan: expected,
        deviceName: undefined,
        steps,
      });
      expect(classifyAssistantExecution(text)).toEqual({ kind: "desktop" });
      expect(
        looksLikeDesktopFolderCompound(text.replace(/(?:3\.|三、)/u, "4.")),
      ).toBe(true);
      expect(
        desktopFolderCompoundRequest(text.replace(/(?:3\.|三、)/u, "4.")),
      ).toBeUndefined();
      expect(
        desktopFolderCompoundRequest(
          text.replace("测试自动化666", "测试\n自动化666"),
        ),
      ).toBeUndefined();
      expect(
        desktopFolderCompoundRequest(text + "\n4. 运行任意命令"),
      ).toBeUndefined();
      expect(looksLikeDesktopFolderCompound(text + "\n4. 运行任意命令")).toBe(
        true,
      );
    },
  );

  it("reconstructs the same ordered opcodes to resume the same saved task", () => {
    expect(desktopFolderSteps("create_folders_with_notes")).toEqual(
      desktopFolderCompoundRequest(compound)?.steps,
    );
    expect(desktopFolderSteps("create_desktop_folders")).toEqual(
      desktopFolderCreationRequest(folders)?.steps,
    );
    expect(desktopFolderSteps("create_folder_notes")).toEqual(
      desktopFolderNotesSteps(notes),
    );
    expect(desktopFolderSteps("run_script")).toBeUndefined();
  });

  it.each([
    folders,
    notes,
    "不要" + compound,
    "怎么" + compound + "？",
    compound + "吗？",
  ])(
    "keeps standalone, negative and explanatory inputs separate: %s",
    (text) => {
      expect(looksLikeDesktopFolderCompound(text)).toBe(false);
      expect(desktopFolderCompoundRequest(text)).toBeUndefined();
    },
  );
});
