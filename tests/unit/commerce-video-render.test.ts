import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { expect, it } from "vitest";
import {
  inspectVideo,
  runMedia,
} from "../../apps/api/src/modules/workspace/agent-media.js";
import {
  inspectCommercePresenter,
  renderCommerceVideo,
} from "../../apps/api/src/modules/workspace/commerce-video-render.js";

it("renders a portrait MP4 with timed product images, narration and Chinese captions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xuti-commerce-test-"));
  try {
    const sourcePath = join(dir, "source.mp4");
    await runMedia([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=360x640:d=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "1",
      sourcePath,
    ]);
    const presenter = await readFile(sourcePath);
    const product = await sharp({
      create: { width: 320, height: 420, channels: 3, background: "#dc2828" },
    })
      .png()
      .toBuffer();

    const { duration } = await inspectCommercePresenter(presenter);
    const result = await renderCommerceVideo({
      presenter,
      productImages: [product],
      scenes: [
        { start: 0, end: 1, caption: "看这款外套的剪裁" },
        { start: 1, end: duration, caption: "", productImageIndex: 0 },
      ],
    });
    expect(result.duration).toBeCloseTo(2, 1);
    expect(await inspectVideo(result.content)).toMatchObject({
      width: 720,
      height: 1280,
      audio: true,
    });
    const resultPath = join(dir, "result.mp4");
    await writeFile(resultPath, result.content);
    for (const [name, second] of [
      ["presenter", "0.5"],
      ["product", "1.5"],
    ]) {
      await runMedia([
        "-y",
        "-ss",
        second,
        "-i",
        resultPath,
        "-frames:v",
        "1",
        "-threads",
        "1",
        join(dir, name + ".png"),
      ]);
    }
    const center = { left: 355, top: 640, width: 1, height: 1 };
    const pixelAt = (name: string) =>
      sharp(join(dir, `${name}.png`))
        .extract(center)
        .raw()
        .toBuffer();
    const [presenterPixel, productPixel] = await Promise.all([
      pixelAt("presenter"),
      pixelAt("product"),
    ]);
    expect(presenterPixel[2]).toBeGreaterThan(150);
    expect(productPixel[0]).toBeGreaterThan(150);

    const text = await sharp(join(dir, "presenter.png"))
      .extract({ left: 180, top: 1100, width: 360, height: 90 })
      .raw()
      .toBuffer();
    let whiteTextPixels = 0;
    for (let i = 0; i < text.length; i += 3) {
      if (text[i] > 200 && text[i + 1] > 200 && text[i + 2] > 200)
        whiteTextPixels++;
    }
    expect(whiteTextPixels).toBeGreaterThan(300);

    const narrationOnly = await renderCommerceVideo({
      presenter,
      productImages: [],
      scenes: [{ start: 0, end: duration, caption: "" }],
    });
    expect(await inspectVideo(narrationOnly.content)).toMatchObject({
      width: 720,
      height: 1280,
      audio: true,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 45000);
