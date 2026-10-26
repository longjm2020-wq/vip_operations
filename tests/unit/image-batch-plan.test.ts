import { describe, expect, test } from "vitest";
import { assignImageGroups, buildImageBatchPlan, carouselNumbers, detectImageKind, validFolderName, type BatchImageItem } from "../../apps/web/src/image-batch-plan.js";
import { canReadManual } from "../../apps/api/src/manual.js";
import { imagePalette, inferImageColorGroups } from "../../apps/web/src/image-batch-recognition.js";
const image = (sourcePath: string, patch: Partial<BatchImageItem> = {}): BatchImageItem => ({ id: sourcePath, sourcePath, style: "XFW19X31755L", group: "", kind: "carousel", order: 1, size: 1000, width: 1200, height: 1200, format: "jpeg", transparent: false, ...patch });
describe("local delivery image naming", () => {
  test("single color uses exact carousel sequence and independent detail numbering", () => {
    const items = [...Array.from({ length: 12 }, (_, i) => image(`主图${i + 1}.jpg`, { order: i + 1 })),
      ...Array.from({ length: 50 }, (_, i) => image(`详情${i + 1}.jpg`, { kind: "detail", width: 900, height: 1230, order: i + 1 })),
      image("平铺.png", { kind: "flat", transparent: true, format: "png" }),
      image("列表.jpg", { kind: "listing", width: 950, height: 1200 }), image("吊牌.jpg", { kind: "certificate", width: 640, height: 840 })];
    const plan = buildImageBatchPlan(items);
    expect(plan.issues).toEqual({});
    expect(plan.entries.filter(entry => entry.item.kind === "carousel").map(entry => entry.target.split("/").at(-1))).toEqual(carouselNumbers.map(number => `${number}.jpg`));
    expect(plan.entries.filter(entry => entry.item.kind === "detail").map(entry => entry.target.split("/").at(-1))).toEqual(Array.from({ length: 50 }, (_, index) => `${601 + index}.jpg`));
    expect(plan.entries.every(entry => entry.target.split("/").length === 2)).toBe(true);
    expect(plan.entries.find(entry => entry.item.kind === "flat")?.limit).toBe(600 * 1024);
    expect(plan.entries.find(entry => entry.item.kind === "detail")?.limit).toBeUndefined();
  });
  test("multi color scopes carousel and special numbers to each group, details and certificate stay at style root", () => {
    const items = [image("黑色/1.jpg", { group: "黑色" }), image("白色/1.jpg", { group: "白色" }),
      image("黑色/30.png", { group: "黑色", kind: "flat", format: "png", transparent: true }),
      image("白色/50.jpg", { group: "白色", kind: "listing", width: 950, height: 1200 }),
      image("黑色/601.jpg", { group: "黑色", kind: "detail", width: 900, height: 2600 }),
      image("白色/826.jpg", { group: "白色", kind: "certificate", width: 640, height: 840 })];
    const plan = buildImageBatchPlan(items);
    expect(plan.issues).toEqual({});
    expect(plan.entries.map(entry => entry.target)).toEqual(expect.arrayContaining(["XFW19X31755L/黑色/1.jpg", "XFW19X31755L/白色/1.jpg", "XFW19X31755L/黑色/30.png", "XFW19X31755L/白色/50.jpg", "XFW19X31755L/601.jpg", "XFW19X31755L/826.jpg"]));
    expect(buildImageBatchPlan(items, "numbered").entries.some(entry => /颜色分组文件夹（1）\/1.jpg$/.test(entry.target))).toBe(true);
  });
  test("overflow, duplicate singleton, missing color and invalid path never silently overwrite", () => {
    const items = [...Array.from({ length: 13 }, (_, i) => image(`${i}.jpg`, { group: "黑色" })), image("white.jpg", { group: "白色" }), image("unassigned.jpg"),
      image("flat1.png", { kind: "flat", transparent: true, group: "白色" }), image("flat2.png", { kind: "flat", transparent: true, group: "白色" }),
      image("unsafe.jpg", { style: "../outside" })];
    const plan = buildImageBatchPlan(items);
    expect(plan.issues["0.jpg"]).toBeUndefined();
    expect(plan.issues["12.jpg"][0]).toContain("12 张");
    expect(plan.issues["unassigned.jpg"][0]).toContain("必须指定颜色组");
    expect(plan.issues["flat2.png"][0]).toContain("1 张");
    expect(plan.issues["unsafe.jpg"][0]).toContain("款号目录名称无效");
    expect(plan.entries.length + plan.review.length).toBe(items.length);
    expect(plan.entries.every(entry => !plan.issues[entry.item.id])).toBe(true);
    expect(plan.review.find(entry => entry.item.id === "unsafe.jpg")?.target).toBe("_待确认/unsafe.jpg");
  });
  test("real alpha and square geometry required for 30, bad source can only be skipped", () => {
    expect(buildImageBatchPlan([image("30.png", { kind: "flat" })]).issues["30.png"][0]).toContain("透明像素");
    expect(buildImageBatchPlan([image("wide.jpg", { height: 1100 })]).issues["wide.jpg"][0]).toContain("正方形");
    const plan = buildImageBatchPlan([image("bad.jpg", { kind: "skip", error: "无法解码" })]);
    expect(plan.entries).toEqual([]); expect(plan.issues).toEqual({}); expect(plan.skipped).toBe(1);
  });
  test("reference root and color folders are kept, metadata identifies flat/list/certificate and long detail", () => {
    const files = [image("XFW19X31755L/XFW19X31755L001/1.jpg"), image("XFW19X31755L/XFW19X31755L052/1.jpg"),
      image("XFW19X31755L/601.jpg", { width: 900, height: 2600 }), image("XFW25X31777L/1.jpg")];
    const assigned = assignImageGroups("交付成品参考", files, "auto");
    expect(buildImageBatchPlan(assigned).entries.map(entry => entry.target).sort()).toEqual(files.map(file => file.sourcePath).sort());
    expect(detectImageKind("unknown.jpg", image("", { width: 950, height: 1200 }))).toBe("listing");
    expect(detectImageKind("unknown.jpg", image("", { width: 640, height: 840 }))).toBe("certificate");
    expect(detectImageKind("unknown.png", image("", { transparent: true, format: "png" }))).toBe("flat");
    expect(detectImageKind("unknown.jpg", image("", { width: 900, height: 2600 }))).toBe("detail");
    expect(detectImageKind("unknown.jpg", image("", { width: 1400, height: 900 }))).toBe("unknown");
  });
  test("natural sorting, role folders and explicit layout avoid mixing categories and styles", () => {
    const files = [image("主图/黑色_10.jpg"), image("主图/黑色_2.jpg"), image("详情/详情1.jpg", { width: 900, height: 1230 })];
    const assigned = assignImageGroups("XFW123L", files, "auto");
    expect(assigned.map(item => item.sourcePath)).toEqual(["主图/黑色_2.jpg", "主图/黑色_10.jpg", "详情/详情1.jpg"].sort((a,b) => a.localeCompare(b, "zh-CN", { numeric: true })));
    expect(assigned.filter(item => item.kind === "carousel").map(item => item.group)).toEqual(["黑色", "黑色"]);
    expect(new Set(assigned.map(item => item.style))).toEqual(new Set(["XFW123L"]));
    expect(assignImageGroups("my-style", files, "single").every(item => item.style === "my-style")).toBe(true);
  });
  test.each(["../foo", "a/b", "a\\b", "CON", "NUL.txt", "name.", "name ", "", "LPT1"])('rejects unsafe Windows output name "%s"', name => expect(validFolderName(name)).toBe(false));
  test("manual has the same any-module visibility as the toolbox", () => {
    for (const permissions of [["product.read"], ["selection.read"], ["project.read"]]) expect(canReadManual({ permissions } as any, "37-image-batch-naming", null)).toBe(true);
    expect(canReadManual({ permissions: ["supply.portal"] } as any, "37-image-batch-naming", null)).toBe(false);
  });
  test("mixed colours match image references within each style, including more flat colours than list images", () => {
    const red = [{ color: [40, 65, 40] as [number, number, number], weight: 1 }];
    const blue = [{ color: [40, 5, -50] as [number, number, number], weight: 1 }];
    const white = [{ color: [90, 0, 0] as [number, number, number], weight: 1 }];
    const items = inferImageColorGroups([image("30.png", { kind: "flat", palette: red }), image("31.png", { kind: "flat", palette: blue }), image("32.png", { kind: "flat", palette: white }), image("51.jpg", { kind: "listing", palette: blue }), image("52.jpg", { kind: "listing", palette: red }), image("1.jpg", { palette: red }), image("2.jpg", { palette: blue }), image("3.jpg", { palette: white }), image("other/1.jpg", { style: "OTHER", palette: blue })]);
    expect(items.find(i => i.id === "1.jpg")?.group).toBe(items[0].group);
    expect(items.find(i => i.id === "2.jpg")?.group).toBe(items[1].group);
    expect(items.find(i => i.id === "51.jpg")?.group).toBe(items[1].group);
    expect(items.find(i => i.id === "3.jpg")?.group).toBe(items[2].group);
    expect(items.at(-1)?.group).toBe("");
  });
  test("known colour names win, ambiguous visual references do not invent new colours", () => {
    const palette = [{ color: [50, 0, 0] as [number, number, number], weight: 1 }];
    const items = inferImageColorGroups([image("30.png", { kind: "flat", palette }), image("31.png", { kind: "flat", palette }), image("1.jpg", { palette })]);
    expect(items.every(item => !item.group)).toBe(true);
    const labeled = inferImageColorGroups([image("black/1.jpg", { group: "黑色", palette }), image("loose.jpg", { palette })]);
    expect(labeled.map(item => item.group)).toEqual(["黑色", "黑色"]);
  });
  test("palette excludes transparent pixels and records actual image colours", () => {
    const rgba = new Uint8ClampedArray(32 * 32 * 4);
    for (let i = 0; i < rgba.length; i += 4) { rgba[i] = 255; rgba[i + 3] = 255; }
    const palette = imagePalette(rgba, 32, 32);
    expect(palette[0].color[1]).toBeGreaterThan(60);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 0;
    expect(imagePalette(rgba, 32, 32)).toEqual([]);
  });
  test("invalid or unmatched pictures do not consume valid naming slots", () => {
    const plan = buildImageBatchPlan([image("30.jpg", { kind: "flat", transparent: false }), image("flat.png", { kind: "flat", transparent: true }), image("black.jpg", { group: "黑色" }), image("white.jpg", { group: "白色" }), image("missing.jpg")]);
    expect(plan.review.map(entry => entry.item.id)).toEqual(["30.jpg", "flat.png", "missing.jpg"]);
    expect(plan.entries.map(entry => entry.target)).toEqual(["XFW19X31755L/黑色/1.jpg", "XFW19X31755L/白色/1.jpg"]);
    const single = buildImageBatchPlan([image("30.jpg", { kind: "flat", transparent: false }), image("flat.png", { kind: "flat", transparent: true })]);
    expect(single.entries.map(entry => entry.target)).toEqual(["XFW19X31755L/30.png"]);
    expect(single.review.map(entry => entry.item.id)).toEqual(["30.jpg"]);
  });
});
