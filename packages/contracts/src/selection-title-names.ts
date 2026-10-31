/** Names are explicit 2–4 Han characters; punctuation cannot disguise duplicates. */
export const normalizeTitleName = (value: unknown) => String(value ?? "").normalize("NFKC").trim();
export function titleNameIssue(value: string) {
  return value && !/^\p{Script=Han}{2,4}$/u.test(normalizeTitleName(value)) ? "款名/别名须为 2–4 个汉字" : "";
}

const seasons = /^(?:春夏|秋冬|春秋|春季|夏季|秋季|冬季|早春|初秋)[·・\s]*/u;
export function titleNameBody(value: string) {
  return value.normalize("NFKC").trim().replace(/^(?:【[^】]*】|\[[^\]]*\])\s*/u, "");
}
export function titleStartsWithName(value: string, name: string) {
  const body = titleNameBody(value);
  return !!name && (body.startsWith(name) || body.replace(seasons, "").startsWith(name));
}
export function replaceTitleName(value: string, previous: string, next: string) {
  if (previous && !titleStartsWithName(value, previous)) return value;
  const prefix = value.match(/^\s*(?:【[^】]*】|\[[^\]]*\])\s*/u)?.[0] || "";
  return prefix + (previous ? value.slice(prefix.length).replace(previous, next) : next + value.slice(prefix.length));
}

// Historical titles did not store a separate name. Only recognize a short Han
// prefix followed by an apparel/season/design word; never assume any first 3 chars are a name.
const descriptionStart = /^(?:春夏|秋冬|春秋|春季|夏季|秋季|冬季|早春|初秋|女式|女士|女装|男式|男士|新中式|中式|国风|简约|复古|通勤|休闲|圆领|翻领|立领|连帽|V领|无袖|长袖|短袖|七分袖|盘扣|拉链|抽绳|收腰|松紧|高腰|直筒|阔腿|宽松|修身|短款|长款|中长|提花|印花|刺绣|绣花|拼接|毛领|毛边|缎面|风琴|百褶|包臀|半身|连衣|外套|衬衫|马甲|背心|羽绒|棉衣|针织|开衫|毛衣|皮衣|短裙|长裙|长裤|短裤|裙|裤)/u;
export function inferTitleName(value: string) {
  const body = titleNameBody(value).replace(seasons, "");
  if (descriptionStart.test(body)) return "";
  for (let length = 2; length <= 4; length++) {
    const chars = Array.from(body), name = chars.slice(0, length).join(""), rest = chars.slice(length).join("").replace(/^[·・\s]+/u, "");
    if (!titleNameIssue(name) && Array.from(name).length === length && descriptionStart.test(rest)) return name;
  }
  return "";
}

export type TitleNameOwner = { id: string; style: string; series: string; names: string[]; titles: string[] };
export function titleNameConflict(name: string, owner: Pick<TitleNameOwner, "id" | "style" | "series">, existing: TitleNameOwner[]) {
  const others = existing.filter(other => other.id !== owner.id && !(owner.style && other.style === owner.style) && !(owner.series && other.series === owner.series));
  if (others.some(other => other.names.includes(name) || other.titles.some(title => {
    const recordedName = inferTitleName(title);
    return recordedName ? recordedName === name : titleStartsWithName(title, name);
  })))
    return "款名与其他款式重名；只有「所属系列」相同且非空的配套款式可共用名称";
  const similar = new Set(others.flatMap(other => other.names).filter(value => {
    const left = Array.from(name), right = Array.from(value);
    return left.length >= 3 && left.length === right.length && left.filter((character, index) => character !== right[index]).length === 1;
  }));
  return similar.size >= 2 ? "款名与多个已有名字仅差一个字，请换用不同的词组，减少雷同" : "";
}
