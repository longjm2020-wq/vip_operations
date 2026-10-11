export type TableFindOptions = {
  query: string;
  replacement: string;
  matchCase: boolean;
  wholeCell: boolean;
};
export type TableFindCell = {
  id: string;
  rowKey: string;
  columnKey: string;
  rowLabel: string;
  columnLabel: string;
  text: string;
  replaceable: boolean;
};
export type TableFindChange = TableFindCell & { after: string };

const pattern = (query: string, matchCase: boolean) => new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), matchCase ? "gu" : "giu");

/** Plain text only: punctuation, dollar signs and slashes have no special meaning. */
export function tableFindMatches(text: string, options: Pick<TableFindOptions, "query" | "matchCase" | "wholeCell">): boolean {
  if (!options.query) return false;
  if (options.wholeCell) return options.matchCase ? text === options.query : text.toLowerCase() === options.query.toLowerCase();
  return pattern(options.query, options.matchCase).test(text);
}
export function tableReplaceText(text: string, options: TableFindOptions): string {
  if (!tableFindMatches(text, options)) return text;
  return options.wholeCell ? options.replacement : text.replace(pattern(options.query, options.matchCase), () => options.replacement);
}
