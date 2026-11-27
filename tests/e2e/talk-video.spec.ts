import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { runMedia } from "../../apps/api/src/modules/workspace/agent-media.js";
import { bailianCommerceVoiceModels } from "../../packages/contracts/src/bailian-commerce-voice.js";

const root = "/api/v1/aigc/commerce-video";
const presenter = {
  id: "902fbe61-ec05-44b1-8e43-804eed2f6560",
  name: "主播小林",
  voiceKind: "default",
};
const otherPresenter = {
  id: "5d1720ea-33c4-4f44-86b3-c3df680eeb8e",
  name: "主播小余",
  voiceKind: "default",
};
const photo = (id: string, color: string) => ({
  id,
  color,
  url: `${root}/products/123/images/${id}`,
});
const photos = [
  photo("first", "蓝灰色"),
  photo("detail", "领口细节"),
  photo("alternate", "袖口细节"),
];
const product = {
  id: "123",
  styleNo: "XUTI-123",
  name: "通勤短外套",
  images: photos,
};
const prompt = "给这款外套拍竖屏口播，重点展示版型和袖口。";
const originalScenes = [
  { caption: "这件外套适合日常通勤。", start: 0, end: 0.5 },
  {
    caption: "近一点看衣服的细节。",
    start: 0.5,
    end: 1,
    imageId: photos[1].id,
    imageUrl: photos[1].url,
  },
  {
    caption: "搭配简单的内搭就能出门。",
    start: 1,
    end: 1.5,
    imageId: photos[0].id,
    imageUrl: photos[0].url,
  },
];

test("设置主播可独立创建百炼音色、读取试听并保存主播", async ({
  page,
  baseURL,
}) => {
  const photoBytes = await sharp({
    create: { width: 320, height: 400, channels: 3, background: "#627d93" },
  })
    .png()
    .toBuffer();
  await signInAsCreator(page, baseURL!, photoBytes);
  const temp = await mkdtemp(join(tmpdir(), "bailian-voice-e2e-"));
  let recording: Buffer;
  try {
    const file = join(temp, "fixture.mp3");
    await runMedia([
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=6",
      file,
    ]);
    recording = await readFile(file);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  const voice = {
    id: randomUUID(),
    name: "通勤口播",
    model: "cosyvoice-v3.5-flash",
    status: "ready",
  };
  const avatar = {
    id: "preview-avatar",
    name: "已授权的主播形象",
    engine: "fal",
  };
  const catalogVoice = {
    ...voice,
    id: `bailian:${voice.id}`,
    kind: "cloned",
    provider: "bailian",
  };
  let created = false;
  let saved = false;
  let portraitUploaded = false;
  let previews = 0;
  let previewId: string;
  await page.route("**/api/v1/aigc/digital-human/lip-sync", (route) =>
    route.fulfill({
      json: {
        configured: true,
        minSeconds: 5,
        maxSeconds: 15,
        priceUsdPerSecond: 0.08,
        jobs: [],
      },
    }),
  );
  await page.route("**/api/v1/aigc/commerce-video/**", async (route) => {
    const req = route.request();
    const suffix = new URL(req.url()).pathname.slice(root.length);
    if (suffix === "/options")
      return route.fulfill({
        json: {
          available: false,
          presenters: saved
            ? [
                {
                  ...presenter,
                  voiceKind: "cloned",
                  voiceProvider: "bailian",
                  voiceModel: voice.model,
                  engine: avatar.engine,
                },
              ]
            : [],
          avatars: portraitUploaded ? [avatar] : [],
          voices: created ? [catalogVoice] : [],
          templates: [],
          bailian: { configured: true, models: bailianCommerceVoiceModels },
          readiness: {
            script: false,
            presenter: false,
            fal: true,
            profile: saved,
            issues: ["请管理员启用并验证 OpenRouter 脚本服务。"],
          },
        },
      });
    if (suffix === "/jobs") return route.fulfill({ json: { jobs: [] } });
    if (suffix === "/voices" && req.method() === "GET")
      return route.fulfill({ json: { voices: created ? [voice] : [] } });
    if (suffix === "/voices" && req.method() === "POST") {
      expect(created).toBe(false);
      const multipart = await new Response(
        new Uint8Array(req.postDataBuffer()!),
        {
          headers: { "Content-Type": req.headers()["content-type"] },
        },
      ).formData();
      expect(multipart.get("name")).toBe(voice.name);
      expect(multipart.get("model")).toBe(voice.model);
      expect(multipart.get("authorized")).toBe("true");
      expect(multipart.get("requestId")).toMatch(/^[0-9a-f-]{36}$/);
      expect((multipart.get("file") as File).size).toBe(recording.length);
      created = true;
      return route.fulfill({ json: { ...voice, status: "pending" } });
    }
    if (suffix === `/voices/${voice.id}` && req.method() === "GET")
      return route.fulfill({ json: voice });
    if (suffix === `/voices/${voice.id}/preview`) {
      const body = req.postDataJSON();
      expect(body.text).toContain("日常通勤款");
      if (previews++ === 0) {
        previewId = body.requestId;
        return route.fulfill({
          status: 409,
          json: {
            error: "试听仍在生成，请稍后读取。",
            code: "BAILIAN_VOICE_PREVIEW_PENDING",
          },
        });
      }
      expect(body.requestId).toBe(previewId);
      return route.fulfill({ contentType: "audio/mpeg", body: recording });
    }
    if (suffix === "/presenters/portrait" && req.method() === "POST") {
      const multipart = await new Response(
        new Uint8Array(req.postDataBuffer()!),
        {
          headers: { "Content-Type": req.headers()["content-type"] },
        },
      ).formData();
      expect(multipart.get("name")).toBe(presenter.name);
      expect(multipart.get("authorized")).toBe("true");
      expect(multipart.get("templateId")).toBeNull();
      expect((multipart.get("file") as File).size).toBe(photoBytes.length);
      portraitUploaded = true;
      return route.fulfill({ json: { avatar } });
    }
    if (suffix === "/presenters" && req.method() === "POST") {
      expect(portraitUploaded).toBe(true);
      expect(req.postDataJSON()).toEqual({
        name: presenter.name,
        avatarId: avatar.id,
        voiceId: catalogVoice.id,
        authorized: true,
      });
      saved = true;
      return route.fulfill({
        json: {
          ...presenter,
          voiceKind: "cloned",
          voiceProvider: "bailian",
          voiceModel: voice.model,
          engine: avatar.engine,
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: "测试接口不存在" } });
  });
  await page.setViewportSize({ width: 420, height: 900 });
  await page.goto("/aigc?view=talk-video&mode=commerce");
  await expect(
    page.getByText("请管理员启用并验证 OpenRouter 脚本服务。"),
  ).toBeVisible();
  await page.getByRole("button", { name: "设置主播", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置主播" });
  await dialog.getByRole("button", { name: "百炼音色复刻" }).click();
  const panel = dialog.getByRole("region", { name: "百炼音色", exact: true });
  await panel.getByRole("combobox", { name: "复刻模型" }).click();
  await expect(
    page.getByText("CosyVoice 3.5 Plus", { exact: true }),
  ).toBeVisible();
  await page.getByText("CosyVoice 3.5 Flash", { exact: true }).click();
  await expect(panel.getByText(/0\.8 元／万字符/)).toBeVisible();
  await panel.getByRole("textbox", { name: "音色名称" }).fill(voice.name);
  await panel.getByLabel("参考录音").setInputFiles({
    name: "fixture.mp3",
    mimeType: "audio/mpeg",
    buffer: recording,
  });
  const create = panel.getByRole("button", { name: "创建百炼音色" });
  await expect(create).toBeDisabled();
  await panel.getByRole("checkbox").check();
  await create.click();
  const row = panel.getByRole("listitem", { name: voice.name });
  await row.getByRole("button", { name: "试听" }).click();
  const listen = panel.getByRole("button", { name: "生成试听" });
  await listen.click();
  await expect(panel.getByRole("alert")).toContainText("试听仍在生成");
  await listen.click();
  await expect(panel.getByLabel("合成试听音频")).toBeVisible();
  await expect
    .poll(() =>
      panel
        .getByLabel("合成试听音频")
        .evaluate((audio: HTMLAudioElement) => audio.duration),
    )
    .toBeGreaterThan(5);
  await row.getByRole("button", { name: "使用此音色" }).click();
  await dialog.getByRole("textbox", { name: "主播名称" }).fill(presenter.name);
  await dialog.getByLabel("主播照片", { exact: true }).setInputFiles({
    name: "portrait.png",
    mimeType: "image/png",
    buffer: photoBytes,
  });
  await dialog.getByRole("checkbox", { name: /取得肖像和声音/ }).check();
  await dialog.getByRole("button", { name: "保存主播" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("spinbutton", { name: "克隆配音预算上限（元）" }),
  ).toBeVisible();
  await expect(page.getByText(/5～15 秒.*US\$0\.08/)).toBeVisible();
  expect(saved).toBe(true);
  expect(previews).toBe(2);
});

async function signInAsCreator(page: Page, origin: string, photoBytes: Buffer) {
  expect((await page.request.get(`${root}/jobs`)).status()).toBe(401);
  const password = process.env.E2E_PASSWORD!;
  const admin = await page.request.post("/api/v1/auth/login", {
    data: { username: "admin", password },
  });
  await expect(admin).toBeOK();
  const {
    data: { csrfToken },
  } = await admin.json();
  expect((await page.request.get(`${root}/jobs`)).status()).toBe(403);
  const archive = await page.request.get("/api/v1/product-archive-table");
  await expect(archive).toBeOK();
  const {
    data: { id: archiveId },
  } = await archive.json();
  const write = (path: string, data: object) =>
    page.request.post(`/api/v1${path}`, {
      data,
      headers: {
        Origin: origin,
        "X-CSRF-Token": csrfToken,
        "Idempotency-Key": randomUUID(),
      },
    });
  const suffix = randomUUID().slice(0, 8);
  const upload = await write(`/style-selections/images?tableId=${archiveId}`, {
    data: `data:image/png;base64,${photoBytes.toString("base64")}`,
  });
  await expect(upload).toBeOK();
  const {
    data: { url: storedPhoto },
  } = await upload.json();
  const styleNo = `TALK-VIDEO-${suffix}`;
  const row = await write(`/style-selections?tableId=${archiveId}`, {
    xutiStyleNo: styleNo,
    images: [{ id: "uploaded-photo", url: storedPhoto, color: "" }],
  });
  await expect(row).toBeOK();
  const {
    data: { id: rowId },
  } = await row.json();
  const role = await write("/roles", {
    code: `E2E_TALK_VIDEO_${suffix}`,
    name: "口播测试创作者",
    permissionCodes: ["aigc.use", "product.read"],
  });
  await expect(role).toBeOK();
  const {
    data: { id: roleId },
  } = await role.json();
  const username = `talk_creator_${suffix}`;
  const user = await write("/users", {
    username,
    displayName: "口播测试",
    password,
    roleIds: [String(roleId)],
  });
  await expect(user).toBeOK();
  const creator = await page.request.post("/api/v1/auth/login", {
    data: { username, password },
  });
  await expect(creator).toBeOK();

  const gets = await Promise.all(
    [
      "options",
      "jobs",
      `products?q=${styleNo}`,
      `products/${rowId}`,
      `products/${rowId}/images/uploaded-photo`,
    ].map((path) => page.request.get(`${root}/${path}`)),
  );
  for (const response of gets) await expect(response).toBeOK();
  expect(await gets[0].json()).toMatchObject({
    available: expect.any(Boolean),
    presenters: [],
  });
  expect(await gets[1].json()).toEqual({ jobs: [] });
  const expected = {
    id: String(rowId),
    styleNo,
    images: [
      expect.objectContaining({
        id: "uploaded-photo",
        url: `${root}/products/${rowId}/images/uploaded-photo`,
      }),
    ],
  };
  expect(await gets[2].json()).toEqual({
    products: [expect.objectContaining(expected)],
  });
  expect(await gets[3].json()).toMatchObject(expected);
  expect(gets[4].headers()["content-type"]).toContain("image/png");
  expect(await gets[4].body()).toEqual(photoBytes);
}

test("服装口播在窄屏上可完成创建、播放下载和更换指定分镜", async ({
  page,
  baseURL,
}, testInfo) => {
  const temp = await mkdtemp(join(tmpdir(), "talk-video-e2e-"));
  let video: Buffer;
  try {
    const file = join(temp, "fixture.mp4");
    await runMedia([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=navy:s=144x256:d=1.5",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1.5",
      "-c:a",
      "aac",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      file,
    ]);
    video = await readFile(file);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  const preview = await sharp({
    create: { width: 96, height: 120, channels: 3, background: "#627d93" },
  })
    .png()
    .toBuffer();

  await signInAsCreator(page, baseURL!, preview);

  type State = "queued" | "editing" | "completed";
  let state: State = "queued";
  let taskId = "";
  let revision = 0;
  let creates = 0;
  let changes = 0;
  let scenes = originalScenes;
  function job() {
    const videoUrl = `/api/v1/aigc/assets/mock-talk-video-r${revision}.mp4`;
    return {
      id: taskId,
      productId: product.id,
      styleNo: product.styleNo,
      presenterName: presenter.name,
      prompt,
      state,
      createdAt: "2026-11-27T06:00:00Z",
      scenes: state === "queued" ? [] : scenes,
      ...(state === "completed" || revision > 0
        ? { videoUrl, downloadUrl: `${videoUrl}?download=1` }
        : {}),
    };
  }

  await page.route("**/api/v1/aigc/commerce-video/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const suffix = url.pathname.slice(root.length);
    if (suffix === "/options") {
      return route.fulfill({
        json: {
          available: true,
          presenters: [otherPresenter, presenter],
          avatars: [],
          voices: [],
        },
      });
    }
    if (suffix === "/products") {
      expect(url.searchParams.get("q")).toBe(product.styleNo);
      return route.fulfill({ json: { products: [product] } });
    }
    if (suffix === `/products/${product.id}`)
      return route.fulfill({ json: product });
    if (photos.some((photo) => photo.url === url.pathname))
      return route.fulfill({ body: preview, contentType: "image/png" });
    if (suffix === "/jobs" && request.method() === "GET")
      return route.fulfill({ json: { jobs: taskId ? [job()] : [] } });
    if (suffix === "/jobs" && request.method() === "POST") {
      const body = request.postDataJSON();
      expect(body).toEqual({
        productId: product.id,
        presenterId: presenter.id,
        prompt,
        imageIds: ["first", "detail"],
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      });
      taskId = body.requestId;
      creates++;
      return route.fulfill({ status: 202, json: job() });
    }
    if (taskId && suffix === `/jobs/${taskId}`)
      return route.fulfill({ json: job() });
    if (
      taskId &&
      suffix === `/jobs/${taskId}/scenes/1` &&
      request.method() === "PATCH"
    ) {
      expect(request.postDataJSON()).toEqual({
        imageId: "alternate",
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      });
      changes++;
      state = "editing";
      scenes = [
        originalScenes[0],
        {
          ...originalScenes[1],
          imageId: photos[2].id,
          imageUrl: photos[2].url,
        },
        originalScenes[2],
      ];
      return route.fulfill({
        status: 202,
        json: { ...job(), message: "正在替换指定分镜" },
      });
    }
    return route.fulfill({ status: 404, json: { error: "未配置此测试接口" } });
  });
  await page.route("**/api/v1/aigc/assets/mock-talk-video-r*.mp4*", (route) => {
    const download = new URL(route.request().url()).searchParams.has(
      "download",
    );
    return route.fulfill({
      contentType: "video/mp4",
      body: video,
      headers: {
        "Content-Disposition": download
          ? 'attachment; filename="talk-video.mp4"'
          : "inline",
      },
    });
  });

  await page.setViewportSize({ width: 420, height: 900 });
  await page.goto("/aigc?view=talk-video&mode=commerce");
  const panel = page.getByRole("region", { name: "服装口播", exact: true });
  await expect(panel).toBeVisible();
  const run = panel.getByRole("button", { name: "生成视频" });
  await expect(run).toBeDisabled();
  await panel.getByRole("textbox", { name: "视频要求" }).fill(prompt);
  await panel
    .getByRole("combobox", { name: "商品", exact: true })
    .fill(product.styleNo);
  await page.getByText("XUTI-123 · 通勤短外套", { exact: true }).click();
  await panel.getByRole("combobox", { name: "主播", exact: true }).click();
  await page.getByText(presenter.name, { exact: true }).click();
  const images = panel.getByText("商品图 1 张", { exact: true });
  const secondPhoto = panel.getByRole("checkbox", {
    name: "使用商品图 2（领口细节）",
  });
  await expect(secondPhoto).toBeHidden();
  await images.click();
  await secondPhoto.check();
  await panel.getByText("商品图 2 张", { exact: true }).click();
  await expect(secondPhoto).toBeHidden();
  expect(
    await panel.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await run.click();

  const result = panel.getByRole("region", { name: "视频任务" });
  await expect(result.getByText("排队中", { exact: true })).toBeVisible();
  expect(creates).toBe(1);
  state = "completed";
  const player = result.getByLabel("服装口播成片");
  await expect(player).toHaveJSProperty("videoWidth", 144, { timeout: 12000 });
  await player.evaluate((el: HTMLVideoElement) => {
    el.muted = true;
    return el.play();
  });
  await expect
    .poll(() => player.evaluate((el: HTMLVideoElement) => el.currentTime))
    .toBeGreaterThan(0);
  const download = page.waitForEvent("download");
  await result.getByRole("link", { name: "下载 MP4" }).click();
  expect((await download).suggestedFilename()).toBe("talk-video.mp4");

  const firstShot = result.getByText(originalScenes[0].caption, {
    exact: true,
  });
  await expect(firstShot).toBeHidden();
  await result.getByText("脚本与分镜 · 3 镜", { exact: true }).click();
  await expect(firstShot).toBeVisible();
  const shots = result.getByRole("listitem");
  const secondShot = shots.nth(1);
  await expect(secondShot.getByRole("img")).toHaveAttribute(
    "src",
    photos[1].url,
  );
  await secondShot.getByRole("button", { name: "换画面" }).click();
  const edit = page.getByRole("dialog", { name: "更换第 2 镜画面" });
  await expect(edit.getByRole("button", { name: "重新剪辑" })).toBeDisabled();
  await edit.getByRole("combobox", { name: "替换画面" }).click();
  await page.getByText("商品图 3 · 袖口细节", { exact: true }).click();
  await edit.getByRole("button", { name: "重新剪辑" }).click();
  await expect(result.getByText("正在替换指定分镜")).toBeVisible();
  revision = 1;
  state = "completed";
  await expect(player).toHaveAttribute("src", /mock-talk-video-r1/, {
    timeout: 12000,
  });
  await expect(secondShot.getByRole("img")).toHaveAttribute(
    "src",
    photos[2].url,
  );
  await expect(shots.nth(2).getByRole("img")).toHaveAttribute(
    "src",
    photos[0].url,
  );
  await expect(firstShot).toBeVisible();
  expect(creates).toBe(1);
  expect(changes).toBe(1);
  await page.setViewportSize({ width: 680, height: 900 });
  await page.screenshot({
    path: testInfo.outputPath("talk-video-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: testInfo.outputPath("talk-video-desktop.png"),
    fullPage: true,
  });
});

test("原声对口型可独立提交照片和录音，并播放及下载已保存的视频", async ({
  page,
}) => {
  const preview = await sharp({
    create: { width: 384, height: 512, channels: 3, background: "#627d93" },
  })
    .jpeg()
    .toBuffer();
  const temp = await mkdtemp(join(tmpdir(), "lip-sync-e2e-"));
  let recording: Buffer;
  let video: Buffer;
  try {
    const media = join(temp, "sample.mp4");
    const audio = join(temp, "recording.wav");
    await runMedia([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=navy:s=144x192:d=5.72",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=5.72",
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      media,
      "-map",
      "1:a",
      "-c:a",
      "pcm_s16le",
      audio,
    ]);
    [recording, video] = await Promise.all([readFile(audio), readFile(media)]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  await page.route("**/api/v1/**", (route) =>
    route.fulfill({
      json: {
        data:
          new URL(route.request().url()).pathname === "/api/v1/auth/me"
            ? {
                id: "100",
                displayName: "拍视频",
                permissions: ["aigc.use"],
                roleCodes: [],
                csrfToken: "fixture",
              }
            : [],
      },
    }),
  );
  let submits = 0;
  let completed = false;
  const task = () => ({
    id: "lip-sync-sample",
    status: completed ? "completed" : "submitting",
    createdAt: "2026-11-27T06:00:00Z",
    ...(completed ? { output: "lip-sync-video" } : {}),
  });
  await page.route("**/api/v1/aigc/digital-human/lip-sync", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postData() || "";
      expect(body).toContain('name="image"; filename="portrait.jpg"');
      expect(body).toContain('name="audio"; filename="recording.wav"');
      expect(body).toMatch(/name="authorized"\r\n\r\ntrue\r\n/);
      expect(body).toMatch(/name="requestId"\r\n\r\n[\da-f-]{36}\r\n/);
      submits++;
      return route.fulfill({ status: 202, json: task() });
    }
    await route.fulfill({
      json: {
        configured: true,
        minSeconds: 5,
        maxSeconds: 15,
        maxImageBytes: 20 * 1024 * 1024,
        maxAudioBytes: 10 * 1024 * 1024,
        resolution: "768P",
        priceUsdPerSecond: 0.08,
        jobs: submits ? [task()] : [],
      },
    });
  });
  await page.route("**/api/v1/aigc/assets/lip-sync-video*", (route) =>
    route.fulfill({
      contentType: "video/mp4",
      body: video,
      headers: {
        "Content-Disposition": new URL(route.request().url()).searchParams.has(
          "download",
        )
          ? 'attachment; filename="lip-sync.mp4"'
          : "inline",
      },
    }),
  );
  await page.setViewportSize({ width: 420, height: 900 });
  await page.goto("/aigc?view=talk-video&mode=lip-sync");
  await expect(page.getByRole("heading", { name: "数字人口播" })).toBeVisible();
  await expect(page.getByText("商品口播", { exact: true })).toHaveCount(0);
  const generate = page.getByRole("button", { name: "生成视频" });
  await expect(generate).toBeDisabled();
  await page.getByLabel("人物照片", { exact: true }).setInputFiles({
    name: "portrait.jpg",
    mimeType: "image/jpeg",
    buffer: preview,
  });
  await page.getByLabel("原声录音", { exact: true }).setInputFiles({
    name: "recording.wav",
    mimeType: "audio/wav",
    buffer: recording,
  });
  await expect(page.getByText("预估 US$0.46", { exact: false })).toBeVisible();
  await expect(generate).toBeDisabled();
  await page.getByRole("checkbox", { name: /我已获肖像和声音授权/ }).check();
  await generate.click();
  const result = page.getByRole("region", { name: "数字人口播任务" });
  await expect(result.getByText("正在提交")).toBeVisible();
  await expect(page.getByRole("button", { name: "已提交" })).toBeDisabled();
  completed = true;
  const player = result.getByLabel("数字人口播成片");
  await expect(player).toHaveAttribute(
    "src",
    "/api/v1/aigc/assets/lip-sync-video",
    { timeout: 7000 },
  );
  await expect
    .poll(() =>
      player.evaluate((element) => (element as HTMLVideoElement).readyState),
    )
    .toBeGreaterThanOrEqual(1);
  const download = page.waitForEvent("download");
  await result.getByRole("link", { name: "下载 MP4" }).click();
  expect((await download).suggestedFilename()).toBe("lip-sync.mp4");
  expect(submits).toBe(1);
});
