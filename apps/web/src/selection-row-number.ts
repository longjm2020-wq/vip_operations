type NumberedRow = { _key?: unknown; id?: unknown; rowNumber?: unknown; sortOrder?: unknown };

const keyOf = (row: NumberedRow) => String(row._key ?? row.id);
const valid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const order = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const canonicalOrder = (left: NumberedRow, right: NumberedRow) => {
  const difference = order(left.sortOrder) - order(right.sortOrder);
  if (difference) return difference;
  const a = String(left.id), b = String(right.id);
  if (/^\d+$/u.test(a) && /^\d+$/u.test(b)) return BigInt(a) > BigInt(b) ? -1 : BigInt(a) < BigInt(b) ? 1 : 0;
  return b.localeCompare(a);
};

/** Shared server numbers survive personal filtering, sorting and pagination.
 * The canonical local fallback supports older API responses; unsaved drafts
 * follow the largest known number until their authoritative response arrives.
 */
export function selectionRowNumbers(rows: readonly NumberedRow[]): Map<string, number> {
  const numbers = new Map<string, number>(), used = new Set<number>();
  for (const row of rows) if (row.id && valid(row.rowNumber)) {
    numbers.set(keyOf(row), row.rowNumber); used.add(row.rowNumber);
  }
  const saved = rows.filter(row => row.id).sort(canonicalOrder);
  for (let index = 0; index < saved.length; index++) {
    const row = saved[index], key = keyOf(row);
    if (numbers.has(key)) continue;
    let number = index + 1;
    while (used.has(number)) number++;
    numbers.set(key, number); used.add(number);
  }
  let next = 1;
  for (const number of used) next = Math.max(next, number + 1);
  for (const row of rows) if (!row.id) numbers.set(keyOf(row), next++);
  return numbers;
}
