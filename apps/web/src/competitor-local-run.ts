import type {
  CompetitorBrand,
  CompetitorProduct,
} from "../../../packages/contracts/src/competitor-analysis.js";
import {
  localDetailImport,
  localListImport,
  type LocalCaptureReply,
} from "../../../packages/contracts/src/competitor-local.js";

export type LocalCommand = "PING" | "NAVIGATE" | "READ" | "FOCUS" | "RELEASE";
export function localCollectorRequest(
  cmd: LocalCommand,
  runId: string,
  url?: string,
): Promise<any> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener("message", receive);
    };
    const receive = (event: MessageEvent) => {
      if (
        event.source !== window ||
        event.origin !== location.origin ||
        event.data?.channel !== "XUTI_LOCAL_RESPONSE" ||
        event.data.v !== 1 ||
        event.data.id !== id
      )
        return;
      cleanup();
      if (event.data.reply?.ok === true) resolve(event.data.reply.data);
      else reject(Error(event.data.reply?.error || "采集助手响应无效"));
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(Error("未连接本机采集助手，请安装后刷新经营系统页面再检测"));
    }, 6000);
    window.addEventListener("message", receive);
    window.postMessage(
      { channel: "XUTI_LOCAL_REQUEST", v: 1, id, cmd, runId, url },
      location.origin,
    );
  });
}

export type LocalBrandProgress = {
  brand: CompetitorBrand;
  status: "待采集" | "采集中" | "已暂停" | "已停止" | "已完成";
  captured: number;
  details: number;
  note: string;
};
type Dependencies = {
  request: (cmd: LocalCommand, runId: string, url?: string) => Promise<any>;
  save: (path: string, body: unknown, key: string) => Promise<any>;
  changed: () => void;
  saved: () => void;
  delay?: (ms: number) => Promise<void>;
};

export class LocalCompetitorRun {
  readonly id = crypto.randomUUID();
  readonly rows: LocalBrandProgress[];
  running = false;
  stopped = false;
  done = false;
  error = "";
  private index = 0;
  private productIndex = 0;
  private products: CompetitorProduct[] = [];
  private snapshotId = "";
  private pending: { path: string; body: unknown; key: string } | null = null;
  private pauseRequested = false;
  constructor(
    brands: CompetitorBrand[],
    private deps: Dependencies,
  ) {
    this.rows = brands.map((brand) => ({
      brand,
      status: "待采集",
      captured: 0,
      details: 0,
      note: "",
    }));
  }
  private async delay(ms: number) {
    await (this.deps.delay || ((n) => new Promise((r) => setTimeout(r, n))))(
      ms,
    );
    this.check();
  }
  private check() {
    if (this.stopped) throw Error("本机更新已停止，已保存的数据保留");
    if (this.pauseRequested) throw Error("本机更新已暂停，已保存的数据保留");
  }
  pause() {
    this.pauseRequested = true;
  }
  stop() {
    this.stopped = true;
    void this.deps.request("RELEASE", this.id).catch(() => {});
    if (!this.running) {
      this.rows
        .filter((r) => r.status !== "已完成")
        .forEach((r) => {
          r.status = "已停止";
        });
      this.deps.changed();
    }
  }
  focus() {
    return this.deps.request("FOCUS", this.id);
  }
  private async collect(url: string) {
    this.check();
    await this.deps.request("NAVIGATE", this.id, url);
    await this.delay(2200);
    let lastNote = "页面尚未取得有效商品，请在采集页检查登录、验证或网络状态";
    let shorterList: unknown;
    let stableCount = 0,
      priorLength = 0;
    for (let attempt = 0; attempt < 20; attempt++) {
      this.check();
      const result: LocalCaptureReply = await this.deps.request(
        "READ",
        this.id,
      );
      this.check();
      if (["LOGIN", "VERIFY", "ERROR"].includes(result.status))
        throw Error(result.note || "唯品会要求处理后继续");
      if (result.status === "READY") {
        const value = result.data as { kind: string; products: unknown[] };
        if (
          value?.kind === "DETAILS" ||
          (value?.kind === "LIST" && value.products?.length >= 50)
        )
          return value;
        if (value?.kind === "LIST" && value.products?.length > 0) {
          stableCount =
            value.products.length === priorLength ? stableCount + 1 : 0;
          priorLength = value.products.length;
          shorterList = value;
          // Allow normal lazy loading to settle before accepting fewer than fifty.
          if (stableCount >= 5) return shorterList;
        }
      }
      if (result.note) lastNote = result.note;
      await this.delay(1000);
    }
    throw Error(lastNote + "；未用空数据覆盖样本");
  }
  private async write(path: string, body: unknown) {
    this.check();
    this.pending ||= { path, body, key: crypto.randomUUID() };
    const p = this.pending;
    const result = await this.deps.save(p.path, p.body, p.key);
    this.pending = null;
    this.deps.saved();
    return result.data;
  }
  async start() {
    if (this.running || this.stopped || this.done) return;
    this.running = true;
    this.pauseRequested = false;
    this.error = "";
    this.deps.changed();
    try {
      await this.deps.request("PING", this.id);
      for (; this.index < this.rows.length; this.index++) {
        const row = this.rows[this.index];
        this.check();
        row.status = "采集中";
        if (!this.snapshotId) {
          row.note = "读取并保存公开销量榜";
          this.deps.changed();
          const body =
            this.pending?.body ||
            localListImport(await this.collect(row.brand.searchUrl), row.brand);
          const saved = await this.write(
            "/analytics/competitors/imports",
            body,
          );
          this.snapshotId = String(saved.id);
          this.products = (body as ReturnType<typeof localListImport>).products;
          row.captured = saved.count;
          this.deps.changed();
        }
        for (; this.productIndex < this.products.length; this.productIndex++) {
          this.check();
          const product = this.products[this.productIndex];
          row.note = `核对第 ${this.productIndex + 1} / ${this.products.length} 款规格参数`;
          this.deps.changed();
          const body =
            this.pending?.body ||
            localDetailImport(
              await this.collect(product.productUrl),
              row.brand,
              this.snapshotId,
              product.productUrl,
            );
          const saved = await this.write(
            "/analytics/competitors/details",
            body,
          );
          if (saved.count !== 1 || saved.unmatched)
            throw Error("商品未匹配本次榜单，请停止后重新更新");
          row.details++;
          this.deps.changed();
        }
        row.status = "已完成";
        row.note = "榜单和本次详情已保存，公开页面未提供的材质保留为空";
        this.products = [];
        this.productIndex = 0;
        this.snapshotId = "";
        this.deps.changed();
      }
      this.done = true;
      await this.deps.request("RELEASE", this.id).catch(() => {});
    } catch (error) {
      this.error = error instanceof Error ? error.message : "本机更新未完成";
      const row = this.rows[this.index];
      if (row) {
        row.status = this.stopped ? "已停止" : "已暂停";
        row.note = this.error;
      }
      if (this.stopped)
        this.rows
          .filter((r) => r.status === "待采集")
          .forEach((r) => {
            r.status = "已停止";
          });
    } finally {
      this.running = false;
      this.deps.changed();
    }
  }
}
