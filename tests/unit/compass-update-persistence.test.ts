import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { initialCompassUpdateProgress, verifiedCompassUpdateProgress } from "../../packages/contracts/src/compass-update.js";

describe("verified report progress", () => {
  it("preserves measured counters and requires actual verified dimensions for complete stages", () => {
    const progress = initialCompassUpdateProgress(["style", "article", "barcode"]);
    Object.assign(progress.dimensions.style!, { parsedRows: 1001, totalRows: 1001, processedRows: 1000, batch: 1, totalBatches: 2 });
    const result = verifiedCompassUpdateProgress(progress, ["style"]);
    expect(result.phase).toBe("VERIFYING_SOURCES");
    expect(result.dimensions.style).toMatchObject({ stage: "COMPLETE", processedRows: 1000, totalRows: 1001 });
    expect(result.dimensions.article?.stage).toBe("VERIFYING");
    expect(result.dimensions.barcode?.stage).toBe("VERIFYING");
    expect(verifiedCompassUpdateProgress(result, ["style", "article", "barcode"])).toMatchObject({ phase: "COMPLETE", activeDimension: null });
  });

  it("does not invent historical import counters for old verified sources", () => {
    const result = verifiedCompassUpdateProgress({}, ["style", "article", "barcode"]);
    expect(result.phase).toBe("COMPLETE");
    expect(result.dimensions.style).toMatchObject({ stage: "COMPLETE", totalRows: null, parsedRows: null, totalBatches: null });
  });
});

describe("retired report schedule migration", () => {
  it("disables legacy scheduling and stops only unfinished automatic jobs while preserving manual work and old sources", async () => {
    const database = new PGlite();
    try {
      await database.exec(`CREATE TABLE compass_session(id integer PRIMARY KEY,auto_update_enabled boolean,auto_update_by bigint,last_scheduled_day date);
        INSERT INTO compass_session VALUES(1,true,17,'2026-10-19');
        CREATE TABLE compass_update_jobs(id bigint PRIMARY KEY,trigger text,status text,completed_dimensions jsonb,
          source_ids jsonb,claim_token uuid,completed_at timestamptz,note text);
        INSERT INTO compass_update_jobs VALUES
          (1,'SCHEDULED','RUNNING','["style"]','{"style":"source-1"}','fdf28b4d-0906-4202-8d99-cba675ba4c36',null,''),
          (2,'SCHEDULED','QUEUED','[]','{}',null,null,''),
          (3,'MANUAL','RUNNING','[]','{}','fdf28b4d-0906-4202-8d99-cba675ba4c36',null,''),
          (4,'SCHEDULED','COMPLETE','["style","article","barcode"]','{}',null,now(),'旧成功');`);
      const migration = await readFile(new URL("../../packages/database/migrations/068_compass_update_progress.sql", import.meta.url), "utf8");
      expect(migration.indexOf("pg_advisory_xact_lock(2026101140)")).toBeLessThan(migration.indexOf("ALTER TABLE"));
      // Production migrations run in a single transaction, including the shared scheduler lock.
      await database.transaction(async tx => { await tx.exec(migration); });
      const session = await database.query<{ auto_update_enabled: boolean; auto_update_by: string | null }>("SELECT * FROM compass_session");
      expect(session.rows[0]).toMatchObject({ auto_update_enabled: false, auto_update_by: null, last_scheduled_day: null });
      const jobs = await database.query<{ id: number; status: string; claim_token: string | null; source_ids: unknown; progress: unknown }>("SELECT * FROM compass_update_jobs ORDER BY id");
      expect(jobs.rows.map(row => row.status)).toEqual(["PARTIAL", "FAILED", "RUNNING", "COMPLETE"]);
      expect(jobs.rows[0]).toMatchObject({ claim_token: null, source_ids: { style: "source-1" }, progress: {} });
      expect(jobs.rows[2].claim_token).not.toBeNull();
      await expect(database.exec("UPDATE compass_session SET auto_update_enabled=true")).rejects.toThrow(/compass_report_schedule_removed/);
      await expect(database.exec("UPDATE compass_update_jobs SET progress='[]' WHERE id=3")).rejects.toThrow(/compass_update_progress_object/);
    } finally { await database.close(); }
  }, 30000);
});
