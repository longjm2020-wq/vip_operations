/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS adapter resolves the configured local player installation. */
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

async function render(spec) {
  const { chromium } = require(path.join(spec.modules, "playwright-core"));
  const lottie = spec.kind === "lottie";
  const origin = "http://director.invalid";
  const pageSource =
    '<html><style>*{margin:0}html,body,#stage,#canvas{width:100%;height:100%;overflow:hidden;background:transparent}canvas{display:block}</style><div id="stage"></div><script src="/player.js"></script></html>';
  const resources = new Map([
    ["/", ["text/html", Buffer.from(pageSource)]],
    [
      "/player.js",
      [
        "application/javascript",
        await fs.readFile(
          path.join(
            spec.modules,
            lottie
              ? "lottie-web/build/player/lottie_light.min.js"
              : "libpag/lib/libpag.umd.js",
          ),
        ),
      ],
    ],
    [
      "/template",
      [
        lottie ? "application/json" : "application/octet-stream",
        await fs.readFile(spec.template.path),
      ],
    ],
  ]);
  if (!lottie)
    resources.set("/libpag.wasm", [
      "application/wasm",
      await fs.readFile(path.join(spec.modules, "libpag/lib/libpag.wasm")),
    ]);
  if (spec.imagePath)
    resources.set("/image", [
      "image/" +
        path.extname(spec.imagePath).slice(1).replace(/^jpg$/i, "jpeg"),
      await fs.readFile(spec.imagePath),
    ]);
  const browser = await chromium.launch({
    executablePath: spec.chromium,
    headless: true,
    args: ["--enable-unsafe-swiftshader"],
  });
  let encoder;
  try {
    const page = await browser.newPage({
      viewport: { width: spec.width, height: spec.height },
      deviceScaleFactor: 1,
    });
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      const resource = url.origin === origin && resources.get(url.pathname);
      if (!resource) return route.abort();
      await route.fulfill({
        status: 200,
        contentType: resource[0],
        body: resource[1],
      });
    });
    await page.goto(origin);
    await page.evaluate(
      async ({ lottie, fields, template, width, height, withImage }) => {
        const stage = document.querySelector("#stage");
        if (lottie) {
          const animationData = await (await fetch("/template")).json();
          const layers = [
            animationData.layers || [],
            ...(animationData.assets || []).map((a) => a.layers || []),
          ].flat();
          for (const [name, layerName] of Object.entries(
            template.textLayers || {},
          )) {
            const layer = layers.find((l) => l.nm === layerName);
            if (layer && fields[name] !== undefined)
              for (const key of layer.t?.d?.k || []) key.s.t = fields[name];
          }
          if (template.imageAsset && withImage) {
            const asset = animationData.assets?.find(
              (a) => a.id === template.imageAsset,
            );
            if (asset) {
              asset.u = "";
              asset.p = "/image";
              asset.e = 0;
            }
          }
          const anim = window.lottie.loadAnimation({
            container: stage,
            renderer: "svg",
            loop: false,
            autoplay: false,
            animationData,
          });
          if (!anim.isLoaded)
            await new Promise((resolve, reject) => {
              const timeout = setTimeout(
                () => reject(Error("Lottie 加载超时")),
                15000,
              );
              anim.addEventListener("DOMLoaded", () => {
                clearTimeout(timeout);
                resolve();
              });
              anim.addEventListener("data_failed", () => {
                clearTimeout(timeout);
                reject(Error("Lottie 无法加载"));
              });
            });
          window.drawFrame = async (progress) =>
            anim.goToAndStop(
              progress * Math.max(0, anim.totalFrames - 1),
              true,
            );
        } else {
          const PAG = await window.libpag.PAGInit({
            locateFile: () => "/libpag.wasm",
          });
          const file = await PAG.PAGFile.load(
            await (await fetch("/template")).arrayBuffer(),
          );
          for (const [name, index] of Object.entries(
            template.textLayers || {},
          )) {
            if (fields[name] === undefined || !Number.isInteger(index))
              continue;
            const doc = file.getTextData(index);
            if (!doc) throw Error("PAG 缺少可编辑文本");
            doc.text = fields[name];
            file.replaceText(index, doc);
          }
          if (Number.isInteger(template.imageIndex) && withImage) {
            const image = new Image();
            image.src = "/image";
            await image.decode();
            file.replaceImage(
              template.imageIndex,
              await PAG.PAGImage.fromSource(image),
            );
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          stage.appendChild(canvas);
          const view = await PAG.PAGView.init(file, canvas, {
            useScale: false,
          });
          window.drawFrame = async (progress) => {
            view.setProgress(progress);
            await view.flush();
          };
        }
      },
      {
        lottie,
        fields: spec.fields || {},
        template: {
          textLayers: spec.template.textLayers,
          imageAsset: spec.template.imageAsset,
          imageIndex: spec.template.imageIndex,
        },
        width: spec.width,
        height: spec.height,
        withImage: Boolean(spec.imagePath),
      },
    );
    encoder = spawn(
      spec.ffmpeg,
      [
        "-nostdin",
        "-v",
        "error",
        "-f",
        "image2pipe",
        "-framerate",
        String(spec.fps),
        "-c:v",
        "png",
        "-i",
        "pipe:0",
        "-c:v",
        "qtrle",
        "-pix_fmt",
        "argb",
        "-n",
        spec.output,
      ],
      { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] },
    );
    let log = "";
    encoder.stderr.on("data", (data) => {
      log = (log + data).slice(-1000);
    });
    // The stream callback conveys an encode failure even if it occurs between frames.
    encoder.stdin.on("error", () => {});
    const completion = once(encoder, "close");
    completion.catch(() => {});
    const frames = Math.ceil((spec.durationMs * spec.fps) / 1000);
    for (let i = 0; i < frames; i++) {
      await page.evaluate(
        (progress) => window.drawFrame(progress),
        i / Math.max(1, frames - 1),
      );
      const png = await page.screenshot({ omitBackground: true });
      await new Promise((resolve, reject) =>
        encoder.stdin.write(png, (err) => (err ? reject(err) : resolve())),
      );
    }
    encoder.stdin.end();
    const [code] = await completion;
    if (code !== 0) throw Error("FFmpeg 动效编码失败 " + log);
  } finally {
    if (encoder && encoder.exitCode === null) encoder.kill();
    await browser.close();
  }
}

fs.readFile(process.argv[2], "utf8")
  .then(JSON.parse)
  .then(render)
  .catch((error) => {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  });
