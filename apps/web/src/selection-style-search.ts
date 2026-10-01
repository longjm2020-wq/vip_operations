export function parseExactStyleNumbers(value: string): Set<string> {
  return new Set(
    value
      .split(/[,，\r\n]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function parseSelectionSearch(value: string): string[] {
  return [
    ...new Set(
      [...parseExactStyleNumbers(value)].map((term) =>
        term.toLocaleLowerCase(),
      ),
    ),
  ];
}

export function matchesSelectionSearch(
  row: Record<string, any>,
  terms: string[],
  customKeys: string[] = [],
): boolean {
  if (!terms.length) return true;
  const values = [
    "registrationBatch",
    "xutiStyleNo",
    "supplierStyleNo",
    "supplierCode",
    "color",
    "sizeRange",
    "material",
  ]
    .filter(
      (key) =>
        row.cellAccess?.[key] !== "deny" && !row.hiddenCells?.includes(key),
    )
    .map((key) => String(row[key] ?? "").toLocaleLowerCase());
  values.push(
    ...customKeys
      .filter(
        (key) =>
          row.cellAccess?.[key] !== "deny" && !row.hiddenCells?.includes(key),
      )
      .map((key) => String(row.extraFields?.[key] ?? "").toLocaleLowerCase()),
  );
  return terms.some((term) => values.some((value) => value.includes(term)));
}
