type Row = Record<string, any>;

/** Each logical write gets its own key; uncertain retries reuse the exact request. */
export class SelectionSaveAttempts {
  private pending = new Map<string, { key: string; body: Row; sent: Row }>();
  private blocked = new Map<string, { sent: Row; uncertain: boolean }>();

  eligible(row: Row) {
    const failure = this.blocked.get(row._key);
    return !failure || (!failure.uncertain && JSON.stringify(row) !== JSON.stringify(failure.sent));
  }

  start(row: Row, body: Row) {
    let attempt = this.pending.get(row._key);
    if (!attempt) {
      attempt = { key: crypto.randomUUID(), body, sent: row };
      this.pending.set(row._key, attempt);
    }
    return attempt;
  }

  fail(rowKey: string, current: Row, status?: number) {
    const uncertain = !status || status >= 500;
    if (!uncertain) this.pending.delete(rowKey);
    this.blocked.set(rowKey, { sent: current, uncertain: uncertain || status === 409 });
  }

  succeed(rowKey: string) {
    this.pending.delete(rowKey);
    this.blocked.delete(rowKey);
  }

  retry() { this.blocked.clear(); }
}

export function normalizeSelection(row: Row): Row {
  return { ...row, registrationBatch: row.registrationBatch ? String(row.registrationBatch).slice(0, 10) : null,
    images: row.images || [], cellColors: row.cellColors || {}, cellAlignments: row.cellAlignments || {}, cellVerticalAlignments: row.cellVerticalAlignments || {}, cellTextColors: row.cellTextColors || {}, extraFields: row.extraFields || {} };
}

/** Accept server metadata while retaining fields edited during the request. */
export function mergeSelectionSave(current: Row, sent: Row, saved: Row): Row {
  const next: Row = { ...saved, _key: current._key };
  for (const key of Object.keys(current)) {
    if (["id", "updatedAt", "createdAt", "version", "_key"].includes(key)) continue;
    if (JSON.stringify(current[key]) !== JSON.stringify(sent[key])) next[key] = current[key];
  }
  return next;
}
