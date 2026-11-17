import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  defaultProtection,
  type SelectionProtection,
} from "../../packages/contracts/src/selection-protection.js";
import { emptyOperatingFeedback } from "../../packages/contracts/src/product-operating-decisions.js";
import { shiftCompassDate } from "../../packages/contracts/src/compass-analytics.js";
import { selectionScope } from "../../packages/database/src/selection-scope.js";
import type { Row, Tx } from "../../packages/database/src/index.js";
import type { Context } from "../../apps/api/src/core.js";

const fixture = vi.hoisted(() => ({
  database: null as PGlite | null,
  protection: {} as SelectionProtection,
}));
vi.mock("../../packages/database/src/index.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../packages/database/src/index.js")
    >();
  const wrap = (db: Pick<PGlite, "query">) =>
    ({
      $queryRawUnsafe: async (sql: string, ...values: unknown[]) =>
        (await db.query<Row>(sql, values)).rows,
      $executeRawUnsafe: async (sql: string, ...values: unknown[]) =>
        (await db.query(sql, values)).affectedRows || 0,
    }) as unknown as Tx;
  return {
    ...original,
    db: {
      $transaction: async (work: (tx: Tx) => Promise<unknown>) =>
        fixture.database!.transaction((tx) => work(wrap(tx))),
    },
  };
});
vi.mock(
  "../../apps/api/src/modules/style-selections/protection.js",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("../../apps/api/src/modules/style-selections/protection.js")
      >();
    const policy = async () => ({ settings: fixture.protection, revision: 1 });
    return { ...original, policy, writeLocks: policy };
  },
);
import {
  operatingDecisionDetail,
  queryOperatingDecisions,
  saveOperatingDecision,
} from "../../apps/api/src/modules/style-selections/operating-decisions.js";
const q = async (sql: string, values: unknown[] = []) =>
  (await fixture.database!.query<Row>(sql, values)).rows;
const context = (
  permissions = ["selection.read", "selection.manage", "analytics.read"],
): Context => ({
  actor: {
    id: "1",
    username: "test",
    displayName: "测试员工",
    permissions,
    roleCodes: ["BUYER"],
    selectionWorkspaceScoped: true,
  },
  key: randomUUID(),
  requestId: randomUUID(),
});
const scope = <T>(work: () => T, id = "3") => selectionScope.run(id, work);
const feedback = {
  ...emptyOperatingFeedback(),
  supply: "allow" as const,
  supplyReasons: ["stock" as const],
  backlog: true,
};
const saveBody = () => ({
  version: 0,
  rowVersion: 0,
  styleNo: "ABC",
  feedback,
});
beforeAll(async () => {
  fixture.database = new PGlite();
  await fixture.database.exec(`
    CREATE TABLE users(id bigint PRIMARY KEY,display_name text);
    INSERT INTO users VALUES(1,'测试员工');
    CREATE TABLE project_tables(id bigint PRIMARY KEY,system_key text);
    INSERT INTO project_tables VALUES(3,'PRODUCT_ARCHIVE'),(4,NULL);
    CREATE TABLE style_selections(id bigint PRIMARY KEY,xuti_style_no text,version integer,created_by bigint,migration_locked boolean DEFAULT false);
    CREATE TABLE compass_imports(id bigint PRIMARY KEY,start_date date,end_date date,completed_at timestamptz,status text,dimension text);
    CREATE TABLE compass_active_imports(dimension text,import_id bigint);
    CREATE TABLE compass_records(import_id bigint,business_date date,entity_key text,style_no text,payload jsonb);
    CREATE TABLE idempotency_records(actor_id bigint,operation text,idempotency_key text,request_hash text,response_status integer,response_body jsonb);
    CREATE TABLE audit_logs(id bigint GENERATED ALWAYS AS IDENTITY, actor_id bigint,actor_label text,action text,entity_type text,entity_id text,request_id text,before_data jsonb,after_data jsonb,reason text,selection_table_id bigint);
  `);
  await fixture.database.exec(
    await readFile(
      "packages/database/migrations/102_product_operating_decisions.sql",
      "utf8",
    ),
  );
}, 30000);
beforeEach(async () => {
  fixture.protection = structuredClone(defaultProtection);
  await fixture.database!.exec(
    "TRUNCATE product_operating_decisions,product_operating_decision_history,style_selections,compass_imports,compass_active_imports,compass_records,idempotency_records,audit_logs;",
  );
  await q(
    "INSERT INTO style_selections(id,xuti_style_no,version,created_by) VALUES(1,'ABC',0,1),(2,'ABCD',0,1)",
  );
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
  }).format(new Date());
  const end = shiftCompassDate(today, -1),
    start = shiftCompassDate(end, -29);
  await q(
    "INSERT INTO compass_imports VALUES(1,$1,$2,now(),'COMPLETE','style')",
    [start, end],
  );
  await q("INSERT INTO compass_active_imports VALUES('style',1)");
  for (let i = 0; i < 30; i++)
    await q(
      "INSERT INTO compass_records VALUES(1,$1,'platform-A','abc',$2::jsonb)",
      [
        shiftCompassDate(start, i),
        JSON.stringify({
          saleAge: 60,
          metrics: {
            salesQty: 10,
            returnsQty: 9,
            exposure: 200,
            detailViews: 20,
            cartUsers: 2,
          },
        }),
      ],
    );
});
afterAll(async () => fixture.database?.close());

describe("product decisions persistence, permissions and source linkage", () => {
  it("matches complete style codes, uses real report metrics and persists backlog with history", async () =>
    scope(async () => {
      const result = await queryOperatingDecisions(context(), {
        rowIds: ["1", "2"],
      });
      expect(
        result.items.find((item) => item.rowId === "1")?.decision,
      ).toMatchObject({
        replenishment: "待确认",
        sales: "建议停售",
        evidence: { salesQty: 300, returnRate: 0.9 },
      });
      expect(
        result.items.find((item) => item.rowId === "2")?.decision.evidence
          .salesQty,
      ).toBeNull();
      const saved = await saveOperatingDecision(context(), "1", saveBody());
      expect(saved.item).toMatchObject({
        version: 1,
        decision: {
          replenishment: "允许补货",
          sales: "继续销售",
          ruleVersion: "2026-11-17.1",
          tags: expect.arrayContaining(["高退货率", "压仓库存"]),
        },
      });
      const detail = await operatingDecisionDetail(context(), "1");
      expect(detail.history).toHaveLength(1);
      expect(detail.history[0].actorLabel).toBe("测试员工");
      expect(detail.history[0].decision).toMatchObject({
        replenishment: "允许补货",
        sales: "继续销售",
        ruleVersion: "2026-11-17.1",
      });
      expect(await q("SELECT * FROM audit_logs")).toHaveLength(1);
    }));
  it("uses the current sales report until a structured procurement conclusion is saved", async () =>
    scope(async () => {
      await q(
        "UPDATE compass_records SET payload=jsonb_set(payload, '{metrics,returnsQty}', '0'::jsonb)",
      );
      const read = () => queryOperatingDecisions(context(), { rowIds: ["1"] });
      expect((await read()).items[0]?.decision).toMatchObject({
        replenishment: "允许补货",
        sales: "继续销售",
      });
      await saveOperatingDecision(context(), "1", {
        ...saveBody(),
        feedback: {
          ...emptyOperatingFeedback(),
          supply: "deny",
          supplyReasons: ["moq"],
        },
      });
      expect((await read()).items[0]?.decision).toMatchObject({
        replenishment: "不允许补货",
        sales: "继续销售",
        evidence: { salesQty: 300, returnRate: 0 },
      });
    }));
  it("rejects lost updates and changed archive identity without appending history", async () =>
    scope(async () => {
      await saveOperatingDecision(context(), "1", saveBody());
      await expect(
        saveOperatingDecision(context(), "1", saveBody()),
      ).rejects.toMatchObject({
        response: {
          error: { message: expect.stringContaining("经营决策已被其他人修改") },
        },
      });
      await q("UPDATE style_selections SET version=1 WHERE id=1");
      await expect(
        saveOperatingDecision(context(), "1", { ...saveBody(), version: 1 }),
      ).rejects.toMatchObject({
        response: {
          error: { message: expect.stringContaining("商品档案已变化") },
        },
      });
      expect(
        await q("SELECT * FROM product_operating_decision_history"),
      ).toHaveLength(1);
    }));
  it("keeps request retries idempotent", async () =>
    scope(async () => {
      const c = context();
      await saveOperatingDecision(c, "1", saveBody());
      await saveOperatingDecision(c, "1", saveBody());
      expect(
        await q("SELECT * FROM product_operating_decision_history"),
      ).toHaveLength(1);
    }));
  it("does not leak sales data through query or history without analytics permission", async () =>
    scope(async () => {
      await saveOperatingDecision(context(), "1", saveBody());
      const result = await operatingDecisionDetail(
        context(["selection.read"]),
        "1",
      );
      expect(result.item.decision).toMatchObject({
        replenishment: "允许补货",
        sales: "继续销售",
        evidence: { source: null, salesQty: null },
      });
      expect(result.item.canEdit).toBe(false);
      expect(result.history[0].decision).toBeNull();
      await expect(
        saveOperatingDecision(context(["selection.read"]), "1", saveBody()),
      ).rejects.toMatchObject({
        response: {
          error: { message: expect.stringContaining("没有此操作权限") },
        },
      });
    }));
  it("enforces existing region protection for both viewing and saving", async () =>
    scope(async () => {
      fixture.protection = {
        ...defaultProtection,
        enabled: true,
        regions: [
          {
            id: randomUUID(),
            name: "款号保护",
            scope: "columns",
            rowIds: [],
            columnKeys: ["xutiStyleNo"],
            users: {},
            others: "deny",
          },
        ],
      };
      expect(
        (await queryOperatingDecisions(context(), { rowIds: ["1"] })).items,
      ).toEqual([]);
      await expect(
        operatingDecisionDetail(context(), "1"),
      ).rejects.toMatchObject({
        response: {
          error: { message: expect.stringContaining("款号不可查看") },
        },
      });
      await expect(
        saveOperatingDecision(context(), "1", saveBody()),
      ).rejects.toMatchObject({
        response: {
          error: { message: expect.stringContaining("款号所在区域不可编辑") },
        },
      });
    }));
  it("respects transferred-row locks and rejects non-archive scopes", async () => {
    await q("UPDATE style_selections SET migration_locked=true WHERE id=1");
    await scope(async () => {
      expect((await operatingDecisionDetail(context(), "1")).item.canEdit).toBe(
        false,
      );
      await expect(
        saveOperatingDecision(context(), "1", saveBody()),
      ).rejects.toMatchObject({
        response: {
          error: { message: expect.stringContaining("款号所在区域不可编辑") },
        },
      });
    });
    await expect(
      scope(() => queryOperatingDecisions(context(), { rowIds: ["1"] }), "4"),
    ).rejects.toMatchObject({
      response: {
        error: { message: expect.stringContaining("经营决策仅用于商品档案") },
      },
    });
  });
  it("does not apply one style's saved feedback to a renamed style", async () =>
    scope(async () => {
      await saveOperatingDecision(context(), "1", saveBody());
      await q(
        "UPDATE style_selections SET xuti_style_no='NEW',version=1 WHERE id=1",
      );
      const detail = await operatingDecisionDetail(context(), "1");
      expect(detail.item).toMatchObject({
        needsReconfirmation: true,
        feedback: { backlog: false, supply: "pending" },
      });
      expect(detail.history).toHaveLength(1);
    }));
});
