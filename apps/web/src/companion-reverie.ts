import "./companion-reverie.css";

type Area = { x: number; y: number; width: number; height: number };
// Public-domain text, modernized characters/punctuation:
// https://zh.wikisource.org/wiki/道德真經
const verses = [
  [8, "上善若水"],
  [16, "致虚极，守静笃"],
  [19, "见素抱朴，少私寡欲"],
  [22, "少则得，多则惑"],
  [23, "希言自然"],
  [25, "道法自然"],
  [26, "静为躁君"],
  [41, "大音希声，大象无形"],
  [44, "知足不辱，知止不殆"],
  [45, "大巧若拙，大辩若讷"],
  [48, "为学日益，为道日损"],
  [52, "见小曰明，守柔曰强"],
  [58, "光而不耀"],
  [63, "图难于其易，为大于其细"],
  [64, "千里之行，始于足下"],
  [64, "慎终如始，则无败事"],
] as const;
let lastVerse = -1;
function pickVerse() {
  // Pick among all other entries; no unbounded retries with a mocked RNG.
  let index = Math.floor(
    Math.random() * (verses.length - (lastVerse >= 0 ? 1 : 0)),
  );
  if (index >= lastVerse && lastVerse >= 0) index++;
  lastVerse = index;
  return verses[index];
}
const clear = (area: Area, obstacles: DOMRect[]) =>
  !obstacles.some(
    (item) =>
      area.x < item.right + 16 &&
      area.x + area.width > item.left - 16 &&
      area.y < item.bottom + 16 &&
      area.y + area.height > item.top - 16,
  );

/** Search only visible, genuinely empty workspace space; never reserve a fixed corner. */
export function findReverieSpace(workspace: HTMLElement, obstacles: DOMRect[]) {
  const bounds = workspace.getBoundingClientRect();
  const left = Math.max(12, bounds.left + 16);
  const top = Math.max(80, bounds.top + 16);
  const right = Math.min(innerWidth - 12, bounds.right - 16);
  const bottom = Math.min(innerHeight - 12, bounds.bottom - 16);
  for (const [width, height] of [
    [360, 300],
    [300, 250],
    [240, 210],
  ]) {
    const candidates: Area[] = [];
    for (let y = top; y + height <= bottom; y += 36)
      for (let x = left; x + width <= right; x += 36) {
        const area = { x, y, width, height };
        if (clear(area, obstacles)) candidates.push(area);
      }
    if (candidates.length)
      return candidates[Math.floor(Math.random() * candidates.length)];
  }
  return null;
}

/** A decorative projection of the existing companion figure, never another assistant or voice session. */
export function beginCompanionReverie(
  workspace: HTMLElement,
  robot: HTMLElement,
  area: Area,
  onComplete: () => void,
) {
  const frame = document.createElement("div");
  frame.className = "workspace-companion-reverie";
  frame.setAttribute("aria-hidden", "true");
  frame.inert = true;
  const origin = workspace.getBoundingClientRect();
  Object.assign(frame.style, {
    left: `${area.x - origin.left}px`,
    top: `${area.y - origin.top}px`,
    width: `${area.width}px`,
    height: `${area.height}px`,
  });
  frame.style.setProperty(
    "--reverie-angle",
    `${Math.round(Math.random() * 44 - 22)}deg`,
  );
  frame.style.setProperty(
    "--reverie-drift",
    `${Math.random() < 0.5 ? -32 : 32}px`,
  );
  const figure = document.createElement("div");
  figure.className = "workspace-reverie-figure";
  const projection = robot.cloneNode(true) as HTMLElement;
  projection.setAttribute("aria-hidden", "true");
  projection.setAttribute("focusable", "false");
  figure.appendChild(projection);
  const veil = document.createElement("div");
  veil.className = "workspace-reverie-veil";
  veil.appendChild(figure);
  const verse = document.createElement("div");
  verse.className = "workspace-reverie-verse";
  const [chapter, text] = pickVerse();
  for (const line of text.split("，")) {
    const column = document.createElement("span");
    column.textContent = line;
    verse.appendChild(column);
  }
  const source = document.createElement("small");
  source.textContent = `道德经 · 第${chapter}章`;
  verse.appendChild(source);
  frame.append(veil, verse);
  let done = false;
  const finish = () => {
    if (done) return;
    cancel();
    onComplete();
  };
  const complete = (event: AnimationEvent) => {
    if (
      event.target !== figure ||
      event.animationName !== "companion-depth-reveal"
    )
      return;
    finish();
  };
  const cancel = () => {
    if (done) return;
    done = true;
    clearTimeout(fallback);
    figure.removeEventListener("animationend", complete);
    frame.remove();
  };
  figure.addEventListener("animationend", complete);
  // Restore the live assistant even if an animationend event is lost.
  const fallback = setTimeout(finish, 7200);
  workspace.appendChild(frame);
  return { frame, cancel };
}
