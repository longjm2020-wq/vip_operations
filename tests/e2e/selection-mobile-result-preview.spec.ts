import { expect, test, type Locator, type Page } from "@playwright/test";

type Photo = { id: string; url: string; color?: string };
type MobileResult = {
  id: string;
  xutiStyleNo: string;
  supplierStyleNo?: string;
  supplierCode?: string;
  color?: string;
  images: Photo[];
  labelImages?: Photo[];
  cellAccess?: Record<string, string>;
  hiddenCells?: string[];
};

const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1sAAAAASUVORK5CYII=",
  "base64",
);
const photos: Photo[] = [
  { id: "front", url: "https://mobile-photos.example.test/front.png", color: "粉色" },
  { id: "back", url: "https://mobile-photos.example.test/back.png", color: "粉色" },
  { id: "detail", url: "https://mobile-photos.example.test/detail.png", color: "黑色" },
];
const standardRows: MobileResult[] = [
  {
    id: "preview-style",
    xutiStyleNo: "PREVIEW-STYLE",
    supplierStyleNo: "SUPPLIER-001",
    supplierCode: "SUPPLIER-A",
    color: "粉色/黑色",
    images: photos,
    labelImages: [{ id: "label", url: "https://mobile-photos.example.test/label.png" }],
  },
  {
    id: "other-style",
    xutiStyleNo: "OTHER-STYLE",
    supplierStyleNo: "SUPPLIER-002",
    color: "白色",
    images: [{ id: "other", url: "https://mobile-photos.example.test/other.png", color: "白色" }],
    labelImages: [],
  },
];

test.use({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });

async function fixture(
  page: Page,
  options: {
    readonly?: boolean;
    rows?: MobileResult[];
    detailRows?: MobileResult[];
    query?: string;
    listResponse?: (query: URLSearchParams) => { data: MobileResult[]; total: number; [key: string]: unknown };
    imageResponse?: (url: string) => Promise<void>;
  } = {},
) {
  const rows = options.rows || standardRows;
  const detailRequests: string[] = [];
  const writes: string[] = [];
  const imageRequests: string[] = [];
  const searches: URLSearchParams[] = [];
  const nextRequests: URLSearchParams[] = [];
  await page.route("https://mobile-photos.example.test/**", async (route) => {
    imageRequests.push(route.request().url());
    await options.imageResponse?.(route.request().url());
    if (route.request().url().endsWith("/broken.png")) {
      await route.fulfill({ status: 404, body: "missing image" });
      return;
    }
    await route.fulfill({ contentType: "image/png", body: pixel });
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== "GET") writes.push(url.pathname);
    if (url.pathname.endsWith("/auth/me")) {
      await route.fulfill({
        json: {
          data: {
            id: "preview-user",
            displayName: "手机图片预览测试",
            permissions: options.readonly
              ? ["selection.read"]
              : ["selection.read", "selection.manage"],
            roleCodes: [],
            csrfToken: "fixture",
          },
        },
      });
      return;
    }
    if (url.pathname === "/api/v1/style-selections") {
      searches.push(url.searchParams);
      await route.fulfill({ json: options.listResponse?.(url.searchParams) || { data: rows, total: rows.length } });
      return;
    }
    if (/^\/api\/v1\/style-selections\/[^/]+\/photo-next$/.test(url.pathname)) {
      nextRequests.push(url.searchParams);
      await route.fulfill({ json: { data: null } });
      return;
    }
    const detailId = url.pathname.match(/^\/api\/v1\/style-selections\/([^/]+)$/)?.[1];
    if (detailId) {
      detailRequests.push(detailId);
      await route.fulfill({
        json: { data: { ...(options.detailRows || rows).find((row) => row.id === detailId), updatedAt: "2026-10-10T00:00:00.000Z" } },
      });
      return;
    }
    await route.fulfill({ json: { data: [] } });
  });
  await page.goto(`/mobile/style-photos${options.query ? `?q=${encodeURIComponent(options.query)}` : ""}`);
  await expect(page.locator(".mobile-photo-result")).toHaveCount(rows.length);
  return { detailRequests, writes, imageRequests, searches, nextRequests };
}

const resultFor = (page: Page, styleNo: string) =>
  page.locator(".mobile-photo-result").filter({ has: page.getByText(styleNo, { exact: true }) });
const viewer = (page: Page) => page.locator(".mobile-photo-result-image-preview");
const previewImage = (page: Page) => viewer(page).locator(".ant-image-preview-img");
const previewCount = (page: Page) => viewer(page).locator(".mobile-photo-result-image-count");
const swipeSurface = (page: Page) => viewer(page).locator(".mobile-photo-result-swipe");
const swipeTrack = (page: Page) => viewer(page).locator(".mobile-photo-result-swipe-track");

type TouchPoint = { identifier: number; x: number; y: number };
type WarmImageState = { requested: string[]; decoded: string[] };

async function observeImageWarming(page: Page) {
  await page.addInitScript(() => {
    const nativeImage = window.Image;
    const source = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")!;
    const state: WarmImageState = { requested: [], decoded: [] };
    (window as typeof window & { __photoWarmState: WarmImageState }).__photoWarmState = state;
    const trackedImage = function (width?: number, height?: number) {
      const image = new nativeImage(width, height);
      Object.defineProperty(image, "src", {
        get: () => source.get!.call(image),
        set: (value: string) => {
          state.requested.push(value);
          source.set!.call(image, value);
        },
      });
      const decode = image.decode.bind(image);
      image.decode = async () => {
        await decode();
        state.decoded.push(image.src);
      };
      return image;
    } as unknown as typeof Image;
    trackedImage.prototype = nativeImage.prototype;
    window.Image = trackedImage;
  });
  return () => page.evaluate(() =>
    (window as typeof window & { __photoWarmState: WarmImageState }).__photoWarmState,
  );
}

async function touches(
  surface: Locator,
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  active: TouchPoint[],
  changed = active,
) {
  await surface.evaluate((element, { type, active, changed }) => {
    const touch = (point: TouchPoint) => new Touch({
      identifier: point.identifier,
      target: element,
      clientX: point.x,
      clientY: point.y,
    });
    element.dispatchEvent(new TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      touches: active.map(touch),
      changedTouches: changed.map(touch),
    }));
  }, { type, active, changed });
}

const trackOffset = (page: Page) => swipeTrack(page).evaluate(element => {
  const transform = getComputedStyle(element).transform;
  return transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m41;
});

async function swipe(surface: Locator, direction: "next" | "previous", vertical = false) {
  await surface.evaluate((element, { direction, vertical }) => {
    const startX = direction === "next" ? 270 : 100;
    const endX = vertical ? startX + 8 : direction === "next" ? 100 : 270;
    const start = new Touch({ identifier: 1, target: element, clientX: startX, clientY: 350 });
    const end = new Touch({ identifier: 1, target: element, clientX: endX, clientY: vertical ? 520 : 355 });
    element.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [start], changedTouches: [start] }));
    element.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches: [end], changedTouches: [end] }));
    element.dispatchEvent(new TouchEvent("touchend", { bubbles: true, touches: [], changedTouches: [end] }));
  }, { direction, vertical });
}

test("只读账号可从搜索缩略图预览并滑动同款图片，关闭后仍停留在结果列表", async ({ page }) => {
  const state = await fixture(page, { readonly: true });
  const firstResult = resultFor(page, "PREVIEW-STYLE");
  const thumbnail = firstResult.locator(".mobile-photo-result-preview");
  await expect(thumbnail.locator("img")).toBeVisible();
  await expect(thumbnail.locator("img")).toHaveAttribute("src", photos[0].url);
  await expect(resultFor(page, "OTHER-STYLE").locator(".mobile-photo-result-preview img")).toBeVisible();
  await expect(page.getByRole("button", { name: "新增款式", exact: true })).toHaveCount(0);
  expect(state.searches[0].get("photoSearch")).toBe("true");

  await thumbnail.tap();
  await expect(viewer(page)).toBeVisible();
  await expect(previewCount(page)).toHaveText("1 / 3");
  await expect(previewImage(page)).toHaveAttribute("src", photos[0].url);
  expect(new URL(page.url()).searchParams.get("id")).toBeNull();
  expect(state.detailRequests).toEqual([]);

  const surface = viewer(page).locator(".mobile-photo-result-swipe");
  await swipe(surface, "next");
  await expect(previewCount(page)).toHaveText("2 / 3");
  await expect(previewImage(page)).toHaveAttribute("src", photos[1].url);
  await swipe(surface, "next");
  await expect(previewCount(page)).toHaveText("3 / 3");
  await expect(previewImage(page)).toHaveAttribute("src", photos[2].url);
  await swipe(surface, "previous");
  await expect(previewCount(page)).toHaveText("2 / 3");
  await expect(previewImage(page)).toHaveAttribute("src", photos[1].url);
  await swipe(surface, "next", true);
  await expect(previewCount(page)).toHaveText("2 / 3");

  await viewer(page).locator(".ant-image-preview-close").tap();
  await expect(viewer(page)).toHaveCount(0);
  await expect(firstResult).toBeVisible();
  await expect(page.locator(".mobile-photo-result")).toHaveCount(2);
  expect(new URL(page.url()).searchParams.get("id")).toBeNull();
  expect(state.detailRequests).toEqual([]);
  expect(state.writes).toEqual([]);
});

test("仅打开预览后预热当前和相邻图片，等待慢图不阻塞预览，返回已预热图片不会重复解码", async ({ page }) => {
  const warmState = await observeImageWarming(page);
  const gallery = [
    ...photos,
    { id: "side", url: "https://mobile-photos.example.test/side.png" },
    { id: "fabric", url: "https://mobile-photos.example.test/fabric.png" },
  ];
  let releaseBack!: () => void;
  const backResponse = new Promise<void>(resolve => { releaseBack = resolve; });
  const state = await fixture(page, {
    readonly: true,
    rows: [{ ...standardRows[0], images: gallery }, standardRows[1]],
    imageResponse: async url => { if (url === photos[1].url) await backResponse; },
  });
  const card = resultFor(page, "PREVIEW-STYLE");
  await expect(card.locator(".mobile-photo-result-preview img")).toBeVisible();
  expect(await warmState()).toEqual({ requested: [], decoded: [] });
  expect(state.imageRequests).not.toContain(photos[1].url);
  expect(state.imageRequests).not.toContain(photos[2].url);
  try {
    await card.locator(".mobile-photo-result-preview").tap();
    await expect(previewCount(page)).toHaveText("1 / 5");
    await expect(previewImage(page)).toHaveAttribute("src", photos[0].url);
    await expect.poll(async () => (await warmState()).requested).toEqual([photos[0].url, photos[1].url]);
    await expect.poll(() => state.imageRequests.includes(photos[1].url)).toBe(true);
    expect((await warmState()).decoded).not.toContain(photos[1].url);
    for (const url of [photos[2].url, gallery[3].url, gallery[4].url, standardRows[0].labelImages![0].url, standardRows[1].images[0].url]) {
      expect((await warmState()).requested).not.toContain(url);
    }
  } finally {
    releaseBack();
  }
  await expect.poll(async () => (await warmState()).decoded.includes(photos[1].url)).toBe(true);
  await swipe(swipeSurface(page), "next");
  await expect(previewCount(page)).toHaveText("2 / 5");
  await expect.poll(async () => (await warmState()).decoded.includes(photos[2].url)).toBe(true);
  expect((await warmState()).requested).toEqual(gallery.slice(0, 3).map(photo => photo.url));
  await swipe(swipeSurface(page), "next");
  await expect(previewCount(page)).toHaveText("3 / 5");
  await expect.poll(async () => (await warmState()).decoded.includes(gallery[3].url)).toBe(true);
  const warmed = await warmState();
  expect(warmed.requested).toEqual(gallery.slice(0, 4).map(photo => photo.url));
  await swipe(swipeSurface(page), "previous");
  await expect(previewCount(page)).toHaveText("2 / 5");
  await swipe(swipeSurface(page), "previous");
  await expect(previewCount(page)).toHaveText("1 / 5");
  await swipe(swipeSurface(page), "next");
  await expect(previewCount(page)).toHaveText("2 / 5");
  expect(await warmState()).toEqual(warmed);
  expect(state.writes).toEqual([]);
});

test("图片拖动按帧跟手，连续来回切换后归零，边界、短拖、纵向和取消不误切页", async ({ page }) => {
  await fixture(page, { readonly: true });
  await resultFor(page, "PREVIEW-STYLE").locator(".mobile-photo-result-preview").tap();
  await expect(previewCount(page)).toHaveText("1 / 3");
  const surface = swipeSurface(page);
  const first = { identifier: 1, x: 270, y: 350 };
  const moved = { identifier: 1, x: 120, y: 354 };

  await touches(surface, "touchstart", [first]);
  await touches(surface, "touchmove", [moved]);
  await expect.poll(() => trackOffset(page)).toBeLessThan(0);
  await expect(previewCount(page)).toHaveText("1 / 3");
  await touches(surface, "touchend", [], [moved]);
  await expect(previewCount(page)).toHaveText("2 / 3");
  await expect.poll(() => trackOffset(page)).toBe(0);

  for (const [direction, count] of [
    ["next", "3 / 3"], ["previous", "2 / 3"], ["previous", "1 / 3"],
    ["next", "2 / 3"], ["previous", "1 / 3"],
  ] as const) {
    await swipe(surface, direction);
    await expect(previewCount(page)).toHaveText(count);
    await expect.poll(() => trackOffset(page)).toBe(0);
  }

  await swipe(surface, "previous");
  await expect(previewCount(page)).toHaveText("1 / 3");
  await expect.poll(() => trackOffset(page)).toBe(0);
  await touches(surface, "touchstart", [first]);
  const short = { identifier: 1, x: first.x - 47, y: first.y };
  await touches(surface, "touchmove", [short]);
  await expect.poll(() => trackOffset(page)).toBeLessThan(0);
  await touches(surface, "touchend", [], [short]);
  await expect(previewCount(page)).toHaveText("1 / 3");
  await expect.poll(() => trackOffset(page)).toBe(0);

  await touches(surface, "touchstart", [first]);
  const vertical = { identifier: 1, x: first.x - 8, y: first.y + 170 };
  await touches(surface, "touchmove", [vertical]);
  await expect.poll(() => trackOffset(page)).toBe(0);
  await touches(surface, "touchend", [], [vertical]);
  await expect(previewCount(page)).toHaveText("1 / 3");
  await touches(surface, "touchstart", [first]);
  await touches(surface, "touchmove", [moved]);
  await expect.poll(() => trackOffset(page)).toBeLessThan(0);
  await touches(surface, "touchcancel", [], [moved]);
  await expect.poll(() => trackOffset(page)).toBe(0);
  await expect(previewCount(page)).toHaveText("1 / 3");

  await touches(surface, "touchstart", [first]);
  const threshold = { identifier: 1, x: first.x - 48, y: first.y };
  await touches(surface, "touchmove", [threshold]);
  await touches(surface, "touchend", [], [threshold]);
  await expect(previewCount(page)).toHaveText("2 / 3");
  await swipe(surface, "next");
  await expect(previewCount(page)).toHaveText("3 / 3");
  await swipe(surface, "next");
  await expect(previewCount(page)).toHaveText("3 / 3");
  await expect.poll(() => trackOffset(page)).toBe(0);
});

test("同一地址重复出现在相邻图片时只预热和解码一次", async ({ page }) => {
  const warmState = await observeImageWarming(page);
  await fixture(page, {
    readonly: true,
    rows: [{
      ...standardRows[0],
      images: [photos[0], { ...photos[0], id: "front-repeat" }, photos[1]],
    }],
  });
  await resultFor(page, "PREVIEW-STYLE").locator(".mobile-photo-result-preview").tap();
  await expect(previewCount(page)).toHaveText("1 / 3");
  await expect.poll(async () => (await warmState()).decoded).toEqual([photos[0].url]);
  expect((await warmState()).requested).toEqual([photos[0].url]);
  await swipe(swipeSurface(page), "next");
  await expect(previewCount(page)).toHaveText("2 / 3");
  await expect.poll(async () => (await warmState()).decoded).toEqual([photos[0].url, photos[1].url]);
  await swipe(swipeSurface(page), "next");
  await expect(previewCount(page)).toHaveText("3 / 3");
  await swipe(swipeSurface(page), "previous");
  await expect(previewCount(page)).toHaveText("2 / 3");
  expect((await warmState()).requested).toEqual([photos[0].url, photos[1].url]);
  expect((await warmState()).decoded).toEqual([photos[0].url, photos[1].url]);
});

test("放大后的拖图与双指手势保留当前图片，中途增加手指取消切页并归零", async ({ page }) => {
  await fixture(page, { readonly: true });
  await resultFor(page, "PREVIEW-STYLE").locator(".mobile-photo-result-preview").tap();
  await expect(previewCount(page)).toHaveText("1 / 3");
  const surface = swipeSurface(page);
  await viewer(page).getByRole("button", { name: "放大图片", exact: true }).tap();
  await expect.poll(() => previewImage(page).evaluate(element =>
    new DOMMatrixReadOnly(getComputedStyle(element).transform).m11,
  )).toBeGreaterThan(1);
  const first = { identifier: 1, x: 270, y: 350 };
  const moved = { identifier: 1, x: 100, y: 354 };
  const second = { identifier: 2, x: 240, y: 430 };
  const enlargedOffset = await previewImage(page).evaluate(element =>
    new DOMMatrixReadOnly(getComputedStyle(element).transform).m41,
  );
  await touches(previewImage(page), "touchstart", [first]);
  await touches(previewImage(page), "touchmove", [moved]);
  await expect.poll(() => previewImage(page).evaluate(element =>
    new DOMMatrixReadOnly(getComputedStyle(element).transform).m41,
  )).not.toBe(enlargedOffset);
  await expect(previewCount(page)).toHaveText("1 / 3");
  await expect.poll(() => trackOffset(page)).toBe(0);
  await touches(previewImage(page), "touchend", [], [moved]);
  await viewer(page).getByRole("button", { name: "还原图片", exact: true }).tap();
  await expect.poll(() => previewImage(page).evaluate(element =>
    new DOMMatrixReadOnly(getComputedStyle(element).transform).m11,
  )).toBe(1);

  await touches(previewImage(page), "touchstart", [first, second]);
  await touches(previewImage(page), "touchmove", [moved, second]);
  await expect.poll(() => previewImage(page).evaluate(element =>
    new DOMMatrixReadOnly(getComputedStyle(element).transform).m11,
  )).toBeGreaterThan(1);
  await touches(previewImage(page), "touchend", [], [moved, second]);
  await expect(previewCount(page)).toHaveText("1 / 3");
  await expect.poll(() => trackOffset(page)).toBe(0);
  await viewer(page).getByRole("button", { name: "还原图片", exact: true }).tap();
  await expect.poll(() => previewImage(page).evaluate(element =>
    new DOMMatrixReadOnly(getComputedStyle(element).transform).m11,
  )).toBe(1);

  await touches(surface, "touchstart", [first]);
  await touches(surface, "touchmove", [moved]);
  await expect.poll(() => trackOffset(page)).toBeLessThan(0);
  await touches(surface, "touchmove", [moved, second]);
  await expect.poll(() => trackOffset(page)).toBe(0);
  await touches(surface, "touchend", [], [moved, second]);
  await expect(previewCount(page)).toHaveText("1 / 3");
  await swipe(surface, "next");
  await expect(previewCount(page)).toHaveText("2 / 3");
});

test("点击搜索结果文字继续选择款式，预览操作不会替代原有选择行为", async ({ page }) => {
  const state = await fixture(page, { query: "PREVIEW" });
  const card = resultFor(page, "PREVIEW-STYLE");
  await card.locator(".mobile-photo-result-select").tap();
  await expect(page).toHaveURL(/id=preview-style/);
  await expect(page.getByRole("heading", { name: "PREVIEW-STYLE", exact: true })).toBeVisible();
  await expect(page.locator(".mobile-photo-results")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("q")).toBe("PREVIEW");
  expect(state.detailRequests).toContain("preview-style");
  await expect(page.getByRole("button", { name: "编辑款号 / 颜色", exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
});

test("禁止查看或隐藏的商品图片不会显示缩略图、预览入口或加载图片地址", async ({ page }) => {
  const secretUrls = ["https://mobile-photos.example.test/denied.png", "https://mobile-photos.example.test/hidden.png"];
  const state = await fixture(page, {
    readonly: true,
    rows: [
      { id: "denied", xutiStyleNo: "DENIED-STYLE", images: [{ id: "secret-a", url: secretUrls[0] }], cellAccess: { images: "deny" } },
      { id: "hidden", xutiStyleNo: "HIDDEN-STYLE", images: [{ id: "secret-b", url: secretUrls[1] }], hiddenCells: ["images"] },
    ],
  });
  for (const styleNo of ["DENIED-STYLE", "HIDDEN-STYLE"]) {
    const card = resultFor(page, styleNo);
    await expect(card.locator(".mobile-photo-result-placeholder")).toHaveText("图片受保护");
    await expect(card.locator(".mobile-photo-result-preview")).toHaveCount(0);
    await expect(card.locator("img")).toHaveCount(0);
  }
  for (const url of secretUrls) {
    await expect(page.locator(`img[src="${url}"]`)).toHaveCount(0);
    expect(state.imageRequests).not.toContain(url);
    expect(await page.locator(".mobile-photo-results").innerHTML()).not.toContain(url);
  }
  await expect(viewer(page)).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test("无商品图片的结果保留占位，失效图片在缩略图和预览中显示回退图", async ({ page }) => {
  await fixture(page, {
    rows: [
      { id: "empty", xutiStyleNo: "EMPTY-STYLE", images: [], labelImages: [{ id: "label-only", url: "https://mobile-photos.example.test/label-only.png" }] },
      { id: "broken", xutiStyleNo: "BROKEN-STYLE", images: [{ id: "broken-photo", url: "https://mobile-photos.example.test/broken.png" }] },
    ],
  });
  const empty = resultFor(page, "EMPTY-STYLE");
  await expect(empty.locator(".mobile-photo-result-placeholder")).toHaveText("暂无图片");
  await expect(empty.locator(".mobile-photo-result-preview")).toHaveCount(0);
  await expect(empty.locator("img")).toHaveCount(0);
  const broken = resultFor(page, "BROKEN-STYLE").locator(".mobile-photo-result-preview");
  await expect(broken.locator("img")).toHaveAttribute("src", /^data:image\/svg\+xml/);
  await broken.tap();
  await expect(viewer(page)).toBeVisible();
  await expect(previewCount(page)).toHaveText("1 / 1");
  await expect(previewImage(page)).toHaveAttribute("src", /^data:image\/svg\+xml/);
  await viewer(page).locator(".ant-image-preview-close").tap();
  await expect(viewer(page)).toHaveCount(0);
  await empty.locator(".mobile-photo-result-select").tap();
  await expect(page.getByRole("heading", { name: "EMPTY-STYLE", exact: true })).toBeVisible();
});

test("320px 手机宽度和长款号不会使结果卡片或预览横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 852 });
  const longStyleNo = "LONG-STYLE-" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(3);
  await fixture(page, {
    readonly: true,
    rows: [{
      id: "long-style",
      xutiStyleNo: longStyleNo,
      supplierStyleNo: "供应商长款号".repeat(15),
      supplierCode: "SUPPLIER-CODE-".repeat(10),
      color: "长颜色名称".repeat(12),
      images: photos,
    }],
  });
  const card = resultFor(page, longStyleNo);
  await expect(card.locator(".mobile-photo-result-preview img")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await card.locator(".mobile-photo-result-preview").tap();
  await expect(previewCount(page)).toHaveText("1 / 3");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const previewBox = await previewImage(page).boundingBox();
  expect(previewBox).not.toBeNull();
  expect(previewBox!.width).toBeLessThanOrEqual(320);
  await viewer(page).locator(".ant-image-preview-close").tap();
  await expect(card).toBeVisible();
});

const missingStyleRows: MobileResult[] = [
  { id: "missing-preview", xutiStyleNo: "", supplierStyleNo: "MISSING-PREVIEW", color: "粉色/黑色", images: photos },
  { id: "missing-other", xutiStyleNo: "", supplierStyleNo: "MISSING-OTHER", color: "白色", images: [standardRows[1].images[0]] },
];

test("款号缺失快捷筛选采用服务器数量，保留搜索词且每次切换重置分页，筛选后仍可预览", async ({ page }) => {
  const state = await fixture(page, {
    readonly: true,
    query: "SUPPLIER",
    listResponse: (query) => {
      const missingCount = query.get("q") === "UPDATED" ? 13 : 47;
      return {
        data: query.get("missingStyleNo") === "true" ? missingStyleRows : standardRows,
        total: query.get("missingStyleNo") === "true" ? missingCount : 80,
        missingStyleNoCount: missingCount,
      };
    },
  });
  const missingFilter = page.getByRole("button", { name: "筛选序缇款号缺失", exact: true });
  await expect(missingFilter).toHaveText("款号缺失（47）");
  await expect(missingFilter).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("共 80 款", { exact: true })).toBeVisible();
  expect(state.searches.at(-1)?.has("missingStyleNo")).toBe(false);
  await page.getByRole("button", { name: "下一页", exact: true }).tap();
  await expect(page.getByText("第 2 页", { exact: true })).toBeVisible();
  await expect.poll(() => state.searches.at(-1)?.get("page")).toBe("2");
  await expect(missingFilter).toHaveText("款号缺失（47）");

  await missingFilter.tap();
  await expect(missingFilter).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("第 1 页", { exact: true })).toBeVisible();
  await expect(page.getByText("共 47 款", { exact: true })).toBeVisible();
  await expect.poll(() => state.searches.at(-1)?.get("missingStyleNo")).toBe("true");
  expect(state.searches.at(-1)?.get("q")).toBe("SUPPLIER");
  expect(state.searches.at(-1)?.get("page")).toBe("1");
  expect(new URL(page.url()).searchParams.get("missingStyleNo")).toBe("true");
  expect(new URL(page.url()).searchParams.get("q")).toBe("SUPPLIER");
  await expect(missingFilter).toHaveText("款号缺失（47）");

  const filteredCard = page.locator(".mobile-photo-result").filter({ hasText: "MISSING-PREVIEW" });
  await filteredCard.locator(".mobile-photo-result-preview").tap();
  await expect(previewCount(page)).toHaveText("1 / 3");
  await swipe(viewer(page).locator(".mobile-photo-result-swipe"), "next");
  await expect(previewCount(page)).toHaveText("2 / 3");
  await viewer(page).locator(".ant-image-preview-close").tap();
  await expect(filteredCard).toBeVisible();
  await expect(missingFilter).toHaveAttribute("aria-pressed", "true");
  expect(new URL(page.url()).searchParams.get("id")).toBeNull();
  expect(state.detailRequests).toEqual([]);

  await page.getByRole("button", { name: "下一页", exact: true }).tap();
  await expect.poll(() => state.searches.at(-1)?.get("page")).toBe("2");
  expect(state.searches.at(-1)?.get("missingStyleNo")).toBe("true");
  await missingFilter.tap();
  await expect(missingFilter).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("第 1 页", { exact: true })).toBeVisible();
  await expect(page.getByText("共 80 款", { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.has("missingStyleNo")).toBe(false);
  expect(new URL(page.url()).searchParams.get("q")).toBe("SUPPLIER");
  await page.getByLabel("搜索款号或供应商编码", { exact: true }).fill("UPDATED");
  await expect.poll(() => state.searches.at(-1)?.get("q")).toBe("UPDATED");
  expect(state.searches.at(-1)?.has("missingStyleNo")).toBe(false);
  expect(state.searches.at(-1)?.get("page")).toBe("1");
  await expect(missingFilter).toHaveText("款号缺失（13）");
  await missingFilter.tap();
  await expect(page.getByText("共 13 款", { exact: true })).toBeVisible();
  expect(state.searches.at(-1)?.get("q")).toBe("UPDATED");
  expect(state.searches.at(-1)?.get("missingStyleNo")).toBe("true");
  expect(new URL(page.url()).searchParams.get("q")).toBe("UPDATED");
  expect(state.writes).toEqual([]);
});

test("款号缺失筛选选择款式后，完成本款的下一款请求继续携带筛选和搜索词", async ({ page }) => {
  const state = await fixture(page, {
    query: "SUPPLIER",
    detailRows: missingStyleRows,
    listResponse: (query) => ({
      data: query.get("missingStyleNo") === "true" ? missingStyleRows : standardRows,
      total: query.get("missingStyleNo") === "true" ? 47 : 80,
      missingStyleNoCount: 47,
    }),
  });
  await page.getByRole("button", { name: "筛选序缇款号缺失", exact: true }).tap();
  const filteredCard = page.locator(".mobile-photo-result").filter({ hasText: "MISSING-PREVIEW" });
  await filteredCard.locator(".mobile-photo-result-select").tap();
  await expect(page.getByRole("heading", { name: "MISSING-PREVIEW", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "完成本款 · 下一款", exact: true }).tap();
  await expect.poll(() => state.nextRequests.length).toBe(1);
  expect(state.nextRequests[0].get("q")).toBe("SUPPLIER");
  expect(state.nextRequests[0].get("missingStyleNo")).toBe("true");
  expect(new URL(page.url()).searchParams.get("missingStyleNo")).toBe("true");
  expect(new URL(page.url()).searchParams.get("id")).toBe("missing-preview");
  expect(state.writes).toEqual([]);
});
