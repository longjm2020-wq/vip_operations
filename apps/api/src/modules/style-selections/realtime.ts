import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import pg from "pg";
import type { Response } from "express";
import { db, one } from "../../../../../packages/database/src/index.js";
import { selectionScope } from "../../../../../packages/database/src/selection-scope.js";
import { requirePermission } from "../../core.js";
import type { AuthRequest } from "../../http.js";
import { actorFor } from "../auth/service.js";
import { tableAccess } from "../projects/library.js";

type Change = {
  tableId: string | null;
  kind: "records" | "permissions" | "view";
};
type Listener = (change: Change) => void;

/** One LISTEN connection per API process; committed changes reach every replica. */
export class SelectionChangeListener {
  private client?: pg.Client;
  private retry?: ReturnType<typeof setTimeout>;
  private connecting?: Promise<void>;
  private stopped = false;
  private listeners = new Set<Listener>();

  constructor(private url = process.env.DATABASE_URL) {}

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): Promise<void> {
    if (this.client || this.stopped) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const client = new pg.Client({
      connectionString: this.url,
      keepAlive: true,
      connectionTimeoutMillis: 5000,
    });
    let disconnected = false;
    const reconnect = () => {
      if (disconnected) return;
      disconnected = true;
      if (this.client === client) this.client = undefined;
      void client.end().catch(() => undefined);
      if (!this.stopped && !this.retry) {
        this.retry = setTimeout(() => {
          this.retry = undefined;
          void this.start();
        }, 3000);
        this.retry.unref();
      }
    };
    client.on("error", reconnect);
    client.on("end", reconnect);
    client.on("notification", (notification) => {
      if (notification.channel !== "selection_changes") return;
      try {
        const change = JSON.parse(notification.payload || "") as Change;
        if (
          (change.tableId !== null &&
            !/^(?:|[1-9]\d{0,18})$/.test(change.tableId)) ||
          !["records", "permissions", "view"].includes(change.kind)
        )
          return;
        this.publish(change);
      } catch {
        /* Ignore unrelated or malformed notifications. */
      }
    });
    this.connecting = (async () => {
      try {
        await client.connect();
        await client.query("LISTEN selection_changes");
        if (this.stopped || disconnected) {
          await client.end();
          return;
        }
        this.client = client;
        // Resync after starting or reconnecting: LISTEN cannot replay a missed change.
        this.publish({ tableId: null, kind: "permissions" });
      } catch {
        reconnect();
      } finally {
        this.connecting = undefined;
      }
    })();
    return this.connecting;
  }

  private publish(change: Change) {
    for (const listener of this.listeners) listener(change);
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    await this.connecting;
    const client = this.client;
    this.client = undefined;
    this.listeners.clear();
    await client?.end();
  }
}

@Injectable()
export class SelectionRealtime implements OnModuleInit, OnModuleDestroy {
  private changes = new SelectionChangeListener();
  private connections = new Set<() => void>();

  onModuleInit() {
    return this.changes.start();
  }
  async onModuleDestroy() {
    for (const close of this.connections) close();
    await this.changes.stop();
  }

  async open(request: AuthRequest, response: Response) {
    const tableId = selectionScope.getStore() || "";
    // A long-lived stream must recheck the session, role and table access, rather
    // than reuse the actor captured when the HTTP connection was opened.
    const authorize = () =>
      selectionScope.run("", async () => {
        const actor = await actorFor(request.cookies?.session);
        if (!tableId) {
          requirePermission(actor, "selection.read");
          return;
        }
        await tableAccess(db, actor, tableId);
        const table = await one(
          db,
          "SELECT system_key FROM public.project_tables WHERE id=$1::bigint",
          tableId,
        );
        requirePermission(
          actor,
          table?.system_key === "PRODUCT_ARCHIVE"
            ? "product.read"
            : "project.read",
        );
      });
    await authorize();
    if (response.destroyed) return;
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();
    let closed = false;
    let pendingPermissions = false;
    let pending = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {};
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      unsubscribe();
      this.connections.delete(close);
      response.end();
    };
    const send = (event: string, value: unknown) => {
      if (
        !closed &&
        !response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)
      )
        close();
    };
    const flush = async () => {
      timer = undefined;
      if (closed || running) return;
      running = true;
      try {
        while (pending && !closed) {
          const permissions = pendingPermissions;
          pending = pendingPermissions = false;
          if (permissions) await authorize();
          send("refresh", { permissions });
        }
      } catch (error) {
        // No row values or protected identifiers are sent over the stream.
        if (
          [401, 403, 404, 410].includes(
            (error as { getStatus?: () => number }).getStatus?.() || 0,
          )
        )
          send("access-revoked", {});
        close();
      } finally {
        running = false;
      }
    };
    unsubscribe = this.changes.subscribe((change) => {
      if (change.tableId !== null && change.tableId !== tableId) return;
      pending = true;
      pendingPermissions ||= change.kind === "permissions";
      if (!timer && !running) timer = setTimeout(() => void flush(), 100);
    });
    this.connections.add(close);
    response.once("close", close);
    const heartbeat = setInterval(() => {
      void authorize()
        .then(() => send("heartbeat", {}))
        .catch((error) => {
          if ([401, 403, 404, 410].includes(error.getStatus?.() || 0))
            send("access-revoked", {});
          close();
        });
    }, 15000);
    heartbeat.unref();
    send("ready", {});
  }
}
