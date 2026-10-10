export function parseChoiceOptions(text: string): string[] {
  return [...new Set(text.split(/\r\n|[\n\r\u2028\u2029]/).map(value => value.trim()).filter(Boolean))];
}

export function choiceOptionsError(options: readonly string[], required: boolean, allowSlash: boolean): string | null {
  if (required && !options.length) return "请填写至少1个选项，每行一个";
  if (options.length > 100) return `有效选项共${options.length}项，最多100项`;
  const long = options.findIndex(value => value.length > 80);
  if (long >= 0) return `第${long + 1}个选项超过80字（当前${options[long].length}字）`;
  const slash = allowSlash ? -1 : options.findIndex(value => value.includes("/"));
  if (slash >= 0) return `第${slash + 1}个选项「${options[slash]}」不能包含 /，此字段使用 / 分隔内容`;
  return null;
}
