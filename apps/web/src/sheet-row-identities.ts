import type { SheetRow } from "./sheet-data.js";

/** Local identity only: never add metadata to a business row or its API payload. */
export class SheetRowIdentities {
  private identities = new WeakMap<SheetRow, string>();
  private saved = new Map<string, string>();

  private businessKey(row: SheetRow): string | undefined {
    return row._key != null && String(row._key) ? `key:${String(row._key)}` : row.id != null && String(row.id) ? `id:${String(row.id)}` : undefined;
  }
  keys(rows: SheetRow[]): string[] {
    const counts = new Map<string, number>();
    for (const row of rows) { const key = this.businessKey(row); if (key) counts.set(key, (counts.get(key) || 0) + 1); }
    return rows.map(row => {
      const business = this.businessKey(row), unique = business && counts.get(business) === 1 ? business : undefined;
      const identity = this.identities.get(row) || (unique && this.saved.get(unique)) || crypto.randomUUID();
      this.identities.set(row, identity);
      if (unique) this.saved.set(unique, identity);
      return identity;
    });
  }
  inherit(source: SheetRow, target: SheetRow): SheetRow {
    const identity = this.identities.get(source);
    if (identity) this.identities.set(target, identity);
    return target;
  }
}
