import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Request, Response } from "express";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Actor } from "../../apps/api/src/core.js";
import type { Studio } from "../../packages/aigc-engine/index.mjs";
import type { Tx } from "../../packages/database/src/index.js";

const fixture = vi.hoisted(() => ({
  database: null as PGlite | null,
  product: vi.fn(),
  presenterOptions: vi.fn(),
}));

vi.mock("../../packages/database/src/index.js", async (original) => {
  const actual =
    await original<typeof import("../../packages/database/src/index.js")>();
  const adapter = (connection: Pick<PGlite, "query">) => ({
    $queryRawUnsafe: async (sql: string, ...parameters: unknown[]) =>
      (await connection.query(sql, parameters)).rows,
    $executeRawUnsafe: async (sql: string, ...parameters: unknown[]) =>
      (await connection.query(sql, parameters)).affectedRows ?? 0,
  });
  return {
    ...actual,
    db: {
      $queryRawUnsafe: (sql: string, ...parameters: unknown[]) =>
        adapter(fixture.database!).$queryRawUnsafe(sql, ...parameters),
      $transaction: (fn: (tx: Tx) => Promise<unknown>) =>
        fixture.database!.transaction((transaction) =>
          fn(adapter(transaction) as unknown as Tx),
        ),
    },
  };
});

vi.mock(
  "../../apps/api/src/modules/aigc/commerce-products.js",
  async (original) => ({
    ...(await original<
      typeof import("../../apps/api/src/modules/aigc/commerce-products.js")
    >()),
    commerceProduct: fixture.product,
  }),
);

vi.mock(
  "../../apps/api/src/modules/aigc/commerce-presenter.js",
  async (original) => ({
    ...(await original<
      typeof import("../../apps/api/src/modules/aigc/commerce-presenter.js")
    >()),
    commercePresenterOptions: fixture.presenterOptions,
  }),
);

import { fail } from "../../apps/api/src/core.js";
import { handleCommerceVideo } from "../../apps/api/src/modules/aigc/commerce-video.js";

const presenterId = randomUUID();
const studio = { config: { openrouterApiKey: "fixture-only" } } as Studio;
const actor = (id = "1"): Actor => ({
  id,
  username: id,
  displayName: id,
  permissions: ["aigc.use", "product.read"],
});
const input = (
  productIds = ["10", "9", "8", "4", "7", "6", "5", "3", "2", "1"],
) => ({
  productIds,
  requestId: randomUUID(),
  presenterId,
  prompt: "展示这件外套的版型和领口，按商品资料撰写。",
});

type BatchResult = {
  id: string;
  createdAt: string;
  items: {
    productId: string;
    styleNo?: string;
    message?: string;
    job?: { id: string; state: string; productId: string };
  }[];
};

async function call<T>(
  suffix: string,
  method: "GET" | "POST",
  who: Actor,
  body?: unknown,
) {
  const request = { method } as Request;
  let status = 200;
  const reply = {
    status(next: number) {
      status = next;
      return reply;
    },
    json(value: T) {
      return { status, body: value };
    },
  };
  return (await handleCommerceVideo(
    studio,
    who,
    suffix,
    request,
    reply as unknown as Response,
    async () => body,
  )) as unknown as { status: number; body: T };
}

beforeAll(async () => {
  fixture.database = new PGlite();
  await fixture.database.exec(
    "CREATE TABLE public.users (id bigint PRIMARY KEY); INSERT INTO public.users VALUES (1), (2);",
  );
  for (const path of [
    "128_commerce_videos.sql",
    "132_commerce_video_batches.sql",
  ])
    await fixture.database.exec(
      await readFile(`packages/database/migrations/${path}`, "utf8"),
    );
}, 15_000);

beforeEach(async () => {
  await fixture.database!.exec(
    "TRUNCATE public.commerce_video_batches, public.commerce_videos;",
  );
  fixture.presenterOptions
    .mockReset()
    .mockResolvedValue({
      available: true,
      presenters: [{ id: presenterId, name: "测试主播", voiceKind: "builtin" }],
    });
  fixture.product
    .mockReset()
    .mockImplementation(async (_who: Actor, productId: string) => {
      if (productId === "99") fail("NOT_FOUND", "missing", 404);
      return {
        id: productId,
        styleNo: `XUTI-${productId}`,
        images:
          productId === "4"
            ? []
            : [{ id: `photo-${productId}` }, { id: "second" }],
      };
    });
});

afterAll(async () => fixture.database?.close());

it("stores one ordered ten-style batch and nine independent jobs, and safely serves retries", async () => {
  const request = input();
  const original = await call<BatchResult>(
    "/batches",
    "POST",
    actor(),
    request,
  );
  expect(original.status).toBe(202);
  expect(original.body.items.map((item) => item.productId)).toEqual(
    request.productIds,
  );
  expect(original.body.items[3]).toEqual({
    productId: "4",
    styleNo: "XUTI-4",
    message: "商品档案缺少已上传的实拍图",
    job: undefined,
  });
  const jobs = original.body.items.flatMap((item) =>
    item.job ? [item.job] : [],
  );
  expect(jobs).toHaveLength(9);
  expect(jobs.every((job) => job.state === "queued")).toBe(true);
  expect(new Set(jobs.map((job) => job.id)).size).toBe(9);
  const persisted = (
    await fixture.database!.query<{
      id: string;
      product_id: string;
      image_ids: string[];
    }>(
      "SELECT id, product_id::text, image_ids FROM commerce_videos ORDER BY product_id",
    )
  ).rows;
  expect(new Set(persisted.map((job) => job.id))).toEqual(
    new Set(jobs.map((job) => job.id)),
  );
  expect(persisted).toHaveLength(9);
  expect(
    persisted.every(
      (job) =>
        job.image_ids.length === 1 &&
        job.image_ids[0] === `photo-${job.product_id}`,
    ),
  ).toBe(true);

  fixture.product.mockClear();
  expect(await call<BatchResult>("/batches", "POST", actor(), request)).toEqual(
    original,
  );
  expect(fixture.product).not.toHaveBeenCalled();
  expect(
    await call<BatchResult>(`/batches/${request.requestId}`, "GET", actor()),
  ).toEqual({ status: 200, body: original.body });
  expect(
    await call<{ batches: unknown[] }>("/batches", "GET", actor()),
  ).toEqual({
    status: 200,
    body: {
      batches: [
        {
          count: 10,
          id: request.requestId,
          createdAt: original.body.createdAt,
        },
      ],
    },
  });
  await expect(
    call("/batches", "POST", actor(), {
      ...request,
      prompt: "另一段不同的内容。",
    }),
  ).rejects.toMatchObject({
    status: 409,
    response: { error: { code: "IDEMPOTENCY_CONFLICT" } },
  });
  await expect(
    call(`/batches/${request.requestId}`, "GET", actor("2")),
  ).rejects.toMatchObject({ status: 404 });
  expect(await call("/batches", "GET", actor("2"))).toEqual({
    status: 200,
    body: { batches: [] },
  });
  await expect(
    call("/batches", "POST", actor("2"), request),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (
      await fixture.database!.query(
        "SELECT id FROM commerce_videos WHERE user_id = 2",
      )
    ).rows,
  ).toEqual([]);
});

it("enforces DTO limits and queue capacity without charging the slots of missing products", async () => {
  await expect(
    call("/batches", "POST", actor(), input(["1", "1"])),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    call(
      "/batches",
      "POST",
      actor(),
      input(Array.from({ length: 11 }, (_, i) => String(i + 1))),
    ),
  ).rejects.toMatchObject({ status: 400 });
  const original = await call<BatchResult>(
    "/batches",
    "POST",
    actor(),
    input(),
  );
  expect(original.body.items.filter((item) => item.job)).toHaveLength(9);
  await expect(
    call("/batches", "POST", actor(), input(["11", "12"])),
  ).rejects.toMatchObject({
    status: 429,
    response: { error: { code: "COMMERCE_QUEUE" } },
  });
  expect(
    (await fixture.database!.query("SELECT id FROM commerce_video_batches"))
      .rows,
  ).toHaveLength(1);
  const next = await call<BatchResult>(
    "/batches",
    "POST",
    actor(),
    input(["99", "11"]),
  );
  expect(next.body.items[0]).toMatchObject({
    productId: "99",
    message: "找不到当前账号可查看的款号",
  });
  expect(next.body.items[1].job).toMatchObject({
    productId: "11",
    state: "queued",
  });
  expect(
    (await fixture.database!.query("SELECT id FROM commerce_videos")).rows,
  ).toHaveLength(10);
});
