type Category = { id: string; name: string; parentId?: string | null };
export type CategoryNode = {
  title: string;
  value: string;
  selectable: boolean;
  children: CategoryNode[];
};
export function categoryTree(categories: Category[]): CategoryNode[] {
  const visit = (
    parent: string | null,
    path: string[],
    seen: string[],
  ): CategoryNode[] =>
    categories
      .filter(
        (c) =>
          (c.parentId == null ? null : String(c.parentId)) === parent &&
          !seen.includes(String(c.id)),
      )
      .map((c) => {
        const names = [...path, c.name];
        const children = visit(String(c.id), names, [...seen, String(c.id)]);
        return {
          title: c.name,
          value: names.join(" / "),
          selectable: names.length === 3 && children.length === 0,
          children,
        };
      });
  return visit(null, [], []);
}
