export type SelectionOrganizationColumn = {
  key: string;
  label: string;
  type?: string;
  fallbackType?: string;
};

export const isSelectionCreationTimeColumn = (column: SelectionOrganizationColumn) =>
  column.key === "registrationBatch" || (column.type || column.fallbackType) === "createdTime";

/** Checkbox controls omit merged aliases; retain them when editing other choices. */
export function selectionOrganizationSortConfiguration(
  columns: readonly SelectionOrganizationColumn[],
  selected: readonly string[],
  previous: readonly string[],
): string[] {
  const creationKeys = new Set(columns.filter(isSelectionCreationTimeColumn).map(column => column.key));
  return [...new Set([...selected, ...previous.filter(key => creationKeys.has(key))])];
}

/** Collapse system creation-time aliases without rewriting saved field sorts. */
export function selectionOrganizationSortOptions(
  columns: readonly SelectionOrganizationColumn[],
  configured: readonly string[],
  current: string,
): { value: string; label: string }[] {
  const byKey = new Map(columns.map(column => [column.key, column]));
  const currentKey = current.startsWith("field:") ? current.slice(6, current.lastIndexOf(":")) : null;
  const currentField = currentKey ? byKey.get(currentKey) : undefined;
  // Keep a selected legacy system field, including its display and access rules.
  const creationPrefix = currentField && isSelectionCreationTimeColumn(currentField)
    ? `field:${currentKey}`
    : "registrationBatch";
  const options = [
    { value: "sortOrder:asc", label: "手动排序" },
    { value: "updatedAt:desc", label: "最近修改" },
    { value: "createdAt:desc", label: "最新创建" },
    { value: `${creationPrefix}:asc`, label: "创建时间 ↑" },
    { value: `${creationPrefix}:desc`, label: "创建时间 ↓" },
    ...[...new Set(configured)].flatMap(key => {
      const column = byKey.get(key);
      return !column || isSelectionCreationTimeColumn(column) ||
        (column.type || column.fallbackType) === "image" || ["images", "labelImages"].includes(key)
        ? []
        : [
          { value: `field:${key}:asc`, label: `${column.label} ↑` },
          { value: `field:${key}:desc`, label: `${column.label} ↓` },
        ];
    }),
  ];
  if (!options.some(option => option.value === current))
    options.push({
      value: current,
      label: currentKey
        ? `${currentField?.label || currentKey} ${current.endsWith(":asc") ? "↑" : "↓"}`
        : "当前列排序",
    });
  return options;
}
