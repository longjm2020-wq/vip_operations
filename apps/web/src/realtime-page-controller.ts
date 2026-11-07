import {
  pageActionSchema,
  type PageActionInput,
  type PageActionResult,
  type PageObservation,
} from "../../../packages/contracts/src/assistant-page.js";

const excluded = [
  ".personal-assistant-drawer",
  ".assistant-compose",
  ".assistant-messages",
  ".assistant-settings-preferences",
  ".assistant-settings-actions",
  ".companion-voice",
  ".companion-voice-prompt",
  ".companion-launch",
  ".sidebar-assistant",
  "[data-voice-private]",
  ".ant-input-password",
  "script",
  "style",
  "noscript",
  "iframe",
  "canvas",
].join(",");
const candidates = [
  "button",
  "a[href]",
  "input",
  "textarea",
  "select",
  "summary",
  "[role=button]",
  "[role=link]",
  "[role=tab]",
  "[role=menuitem]",
  "[role=option]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=switch]",
  "[role=combobox]",
  "[contenteditable=true]",
].join(",");
const compact = (value: string | null | undefined, max = 180) =>
  (value || "").replace(/\s+/g, " ").trim().slice(0, max);
const sensitive =
  /password|passwd|secret|api.?key|access.?token|credential|验证码|密码|密钥/i;

function privateElement(element: Element) {
  if (element.closest(excluded)) return true;
  if (element instanceof HTMLInputElement) {
    if (["hidden", "password", "file"].includes(element.type)) return true;
    if (/password|one-time-code|cc-/.test(element.autocomplete)) return true;
  }
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    if (
      Array.from(element.labels || []).some((label) =>
        sensitive.test(label.textContent || ""),
      )
    )
      return true;
  }
  return sensitive.test(
    [
      element.getAttribute("name"),
      element.id,
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder"),
    ].join(" "),
  );
}
function hitTarget(element: HTMLElement) {
  // Ant Design exposes a combobox on a tiny search input inside the actual
  // pointer target. Keep the input reference for values, use its visible shell.
  return (
    (element.getAttribute("role") === "combobox"
      ? element.closest<HTMLElement>(".ant-select-selector")
      : null) || element
  );
}
function visible(element: HTMLElement) {
  if (!element.isConnected || privateElement(element)) return false;
  if (element.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
  const target = hitTarget(element),
    rect = target.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  for (let node: HTMLElement | null = target; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      style.opacity === "0"
    )
      return false;
  }
  return true;
}
function inViewport(element: HTMLElement) {
  const r = hitTarget(element).getBoundingClientRect();
  return (
    r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
  );
}
function pointerPoint(element: HTMLElement) {
  const target = hitTarget(element),
    r = target.getBoundingClientRect();
  const left = Math.max(0, r.left),
    right = Math.min(innerWidth, r.right);
  const top = Math.max(0, r.top),
    bottom = Math.min(innerHeight, r.bottom);
  if (right <= left || bottom <= top) return null;
  for (const [x, y] of [
    [(left + right) / 2, (top + bottom) / 2],
    [
      left + Math.min(5, (right - left) / 2),
      top + Math.min(5, (bottom - top) / 2),
    ],
    [
      right - Math.min(5, (right - left) / 2),
      bottom - Math.min(5, (bottom - top) / 2),
    ],
  ]) {
    const topElement = document.elementFromPoint(x, y);
    if (topElement && (target === topElement || target.contains(topElement)))
      return { x, y };
  }
  return null;
}
function nameOf(element: HTMLElement) {
  const labelled = element
    .getAttribute("aria-labelledby")
    ?.split(/\s+/)
    .map((id) => {
      const label = document.getElementById(id);
      return label && !privateElement(label) ? visibleText(label, 180) : "";
    })
    .join(" ");
  const labels =
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
      ? Array.from(element.labels || [])
          .map((label) => visibleText(label, 180))
          .join(" ")
      : "";
  const fallback =
    element instanceof HTMLInputElement
      ? ["button", "submit", "reset"].includes(element.type)
        ? element.value
        : element.placeholder
      : element instanceof HTMLTextAreaElement
        ? element.placeholder
        : element.matches("div,section,main,aside") && scrollable(element)
          ? "可滚动区域"
          : visibleText(hitTarget(element), 180);
  return compact(
    element.getAttribute("aria-label") ||
      labelled ||
      labels ||
      element.getAttribute("title") ||
      fallback ||
      element.getAttribute("name"),
  );
}
function roleOf(element: HTMLElement) {
  if (element.getAttribute("role")) return element.getAttribute("role")!;
  if (element instanceof HTMLAnchorElement) return "link";
  if (element instanceof HTMLButtonElement || element.tagName === "SUMMARY")
    return "button";
  if (element instanceof HTMLSelectElement) return "select";
  if (element instanceof HTMLInputElement)
    return ["checkbox", "radio", "range"].includes(element.type)
      ? element.type
      : "textbox";
  if (element instanceof HTMLTextAreaElement || element.isContentEditable)
    return "textbox";
  return "region";
}
function disabled(element: HTMLElement) {
  return (
    element.matches(":disabled") ||
    !!element.closest('[aria-disabled="true"],fieldset:disabled') ||
    !!element.closest(".ant-select-disabled,.ant-picker-disabled")
  );
}
function valueOf(element: HTMLElement) {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  )
    return element instanceof HTMLInputElement &&
      ["checkbox", "radio"].includes(element.type)
      ? String(element.checked)
      : compact(element.value, 160);
  return undefined;
}
function contextOf(element: HTMLElement) {
  const row = element.closest<HTMLElement>('tr,[role="row"],.ant-list-item');
  return row ? visibleText(row, 140) : "";
}
function visibleText(root: HTMLElement, max: number) {
  if (privateElement(root)) return "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let result = "",
    count = 0;
  while (walker.nextNode() && count++ < 2000 && result.length < max) {
    const parent = walker.currentNode.parentElement;
    if (parent && visible(parent))
      result += " " + compact(walker.currentNode.textContent, max);
  }
  return compact(result, max);
}
function fingerprint(element: HTMLElement) {
  return JSON.stringify([
    element.tagName,
    roleOf(element),
    nameOf(element),
    contextOf(element),
    element.getAttribute("href"),
    element.getAttribute("type"),
    valueOf(element),
    element.getAttribute("aria-expanded"),
    disabled(element),
  ]);
}
function scrollable(element: HTMLElement) {
  return (
    element.scrollHeight > element.clientHeight + 8 &&
    /(auto|scroll)/.test(getComputedStyle(element).overflowY)
  );
}
const dialogSelector = '[role="dialog"],[role="alertdialog"]';
const elementIds = new WeakMap<HTMLElement, number>();
let nextElementId = 0;
function elementId(element: HTMLElement) {
  let id = elementIds.get(element);
  if (!id) elementIds.set(element, (id = ++nextElementId));
  return id;
}
/** Include entering/leaving panels even at opacity zero: their modal wrapper
 * may still intercept the page, so they cannot expose the layer underneath. */
function laidOut(element: HTMLElement, includePrivate = false) {
  if (!element.isConnected || (!includePrivate && privateElement(element)))
    return false;
  if (element.closest("[hidden]")) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  for (
    let node: HTMLElement | null = element;
    node;
    node = node.parentElement
  ) {
    const style = getComputedStyle(node);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    )
      return false;
  }
  return true;
}
function stackingPath(element: HTMLElement) {
  const path: { element: HTMLElement; z: number }[] = [];
  for (
    let node: HTMLElement | null = element;
    node;
    node = node.parentElement
  ) {
    const style = getComputedStyle(node);
    if (
      style.zIndex !== "auto" ||
      style.transform !== "none" ||
      Number(style.opacity) < 1 ||
      style.isolation === "isolate"
    )
      path.unshift({
        element: node,
        z: Number.parseInt(style.zIndex, 10) || 0,
      });
  }
  return path;
}
function documentOrder(a: HTMLElement, b: HTMLElement) {
  return a === b
    ? 0
    : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
      ? -1
      : 1;
}
function stackOrder(a: HTMLElement, b: HTMLElement) {
  const left = stackingPath(a),
    right = stackingPath(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i].element === right[i].element) continue;
    return (
      left[i].z - right[i].z || documentOrder(left[i].element, right[i].element)
    );
  }
  if (left.length !== right.length) {
    const extra =
      left.length > right.length ? left[right.length] : right[left.length];
    if (extra.z < 0) return left.length > right.length ? -1 : 1;
  }
  return documentOrder(a, b);
}
function transitioning(element: HTMLElement) {
  // Only panel/wrapper animations count; an infinite loading spinner in the
  // panel body must not make the entire dialog permanently unavailable.
  if (
    /(?:^|\s)[\w-]+-(?:enter|appear|leave)(?:-(?:active|prepare|start|end))?(?:\s|$)/.test(
      element.className,
    )
  )
    return true;
  return (
    typeof element.getAnimations === "function" &&
    element
      .getAnimations()
      .some(
        (animation) => animation.playState === "running" || animation.pending,
      )
  );
}
function popupRoot(element: HTMLElement) {
  return (
    element.closest<HTMLElement>(".ant-select-dropdown,.ant-picker-dropdown") ||
    element.closest<HTMLElement>('[role="listbox"]')
  );
}
function ownedPopups(dialog: HTMLElement | undefined) {
  if (!dialog) return [];
  const roots = new Set<HTMLElement>();
  for (const trigger of Array.from(
    dialog.querySelectorAll<HTMLElement>("[aria-controls],[aria-owns]"),
  )) {
    if (!visible(trigger) || trigger.getAttribute("aria-expanded") === "false")
      continue;
    for (const id of `${trigger.getAttribute("aria-controls") || ""} ${trigger.getAttribute("aria-owns") || ""}`
      .trim()
      .split(/\s+/)) {
      const controlled = document.getElementById(id);
      if (!(controlled instanceof HTMLElement)) continue;
      const popup = popupRoot(controlled);
      if (popup && laidOut(popup)) roots.add(popup);
    }
  }
  return [...roots];
}
type PageScope = {
  dialog?: HTMLElement;
  depth: number;
  portals: HTMLElement[];
  ready: boolean;
  marker: string;
};
function pageScope(): PageScope {
  const dialogs = Array.from(
    document.querySelectorAll<HTMLElement>(dialogSelector),
  )
    .filter((element) => laidOut(element, true))
    .sort(stackOrder);
  const dialog = dialogs.at(-1),
    portals = ownedPopups(dialog);
  const motion = new Set<HTMLElement>();
  for (const panel of dialogs) {
    let node: HTMLElement | null = panel;
    while (node && node !== document.body) {
      motion.add(node);
      if (node.matches(".ant-modal-root")) break;
      node = node.parentElement;
    }
    panel
      .querySelectorAll<HTMLElement>(".ant-modal-container,.ant-modal-content")
      .forEach((element) => motion.add(element));
  }
  // Masks can outlive the dialog during a library's exit animation.
  document
    .querySelectorAll<HTMLElement>(".ant-modal-mask,.ant-modal-wrap")
    .forEach((element) => {
      if (laidOut(element)) motion.add(element);
    });
  portals.forEach((element) => motion.add(element));
  const moving = [...motion].some(
    (element) => laidOut(element) && transitioning(element),
  );
  const orphanWrapper =
    !dialog &&
    [...motion].some(
      (element) =>
        (element.matches(".ant-modal-wrap") && laidOut(element)) ||
        (element.matches(".ant-modal-mask") && visible(element)),
    );
  const ready =
    !moving &&
    !orphanWrapper &&
    (!dialog || (visible(dialog) && !!pointerPoint(dialog)));
  return {
    dialog,
    depth: dialogs.length,
    portals,
    ready,
    marker: JSON.stringify([
      dialogs.map((element) => [
        elementId(element),
        stackingPath(element).map((part) => part.z),
        privateElement(element) ? "" : dialogTitle(element),
      ]),
      portals.map(elementId).sort((a, b) => a - b),
    ]),
  };
}
function scopeAllows(element: HTMLElement, scope: PageScope) {
  return (
    !scope.dialog ||
    scope.dialog.contains(element) ||
    scope.portals.some((popup) => popup.contains(element))
  );
}
function pageText(scope: PageScope) {
  const walker = document.createTreeWalker(
    scope.dialog || document.body,
    NodeFilter.SHOW_TEXT,
  );
  const parts: string[] = [];
  let length = 0,
    scanned = 0,
    truncated = false;
  while (walker.nextNode() && scanned++ < 12000) {
    const parent = walker.currentNode.parentElement;
    const text = compact(walker.currentNode.textContent, 300);
    if (
      !parent ||
      !text ||
      !visible(parent) ||
      !inViewport(parent) ||
      !scopeAllows(parent, scope) ||
      !pointerPoint(parent)
    )
      continue;
    if (length + text.length > 3000) {
      truncated = true;
      break;
    }
    parts.push(text);
    length += text.length;
  }
  return { parts, truncated };
}
function pageName() {
  const pageRoot = document.querySelector<HTMLElement>(
    '[data-voice-page-root="true"]',
  );
  const primaryHeadings = pageRoot
    ? Array.from(
        pageRoot.querySelectorAll<HTMLElement>(
          ".page-heading h1,.page-heading h2",
        ),
      )
    : [];
  const heading = [
    ...primaryHeadings,
    ...Array.from(
      (pageRoot || document).querySelectorAll<HTMLElement>("h1,h2"),
    ),
  ].find((element) => visible(element) && !!visibleText(element, 180));
  return heading ? visibleText(heading, 180) : "";
}
function dialogTitle(dialog: HTMLElement) {
  const label = dialog.getAttribute("aria-label");
  if (label) return compact(label);
  const labelled = dialog
    .getAttribute("aria-labelledby")
    ?.split(/\s+/)
    .map((id) => {
      const element = document.getElementById(id);
      return element instanceof HTMLElement ? visibleText(element, 180) : "";
    })
    .join(" ");
  if (labelled) return compact(labelled);
  const title = dialog.querySelector<HTMLElement>(
    ".ant-modal-title,h1,h2,[role=heading]",
  );
  return title ? visibleText(title, 180) : "对话框";
}
function publicPath() {
  const url = new URL(location.href);
  for (const key of Array.from(url.searchParams.keys()))
    if (sensitive.test(key) || /token|auth|code/i.test(key))
      url.searchParams.delete(key);
  return (
    url.pathname +
    url.search +
    (url.hash.length < 120 && !/token|auth|code|secret|password/i.test(url.hash)
      ? url.hash
      : "")
  ).slice(0, 1600);
}
function forbiddenAction(element: HTMLElement) {
  if (element instanceof HTMLAnchorElement) return false;
  const name = nameOf(element);
  // Preserve the assistant's existing boundary around permission controls and
  // irreversible operations; ordinary navigation, forms and filters need no gate.
  return (
    element.closest(".ant-btn-dangerous,[data-voice-confirm]") ||
    /删除|付款|支付|转账|发送邮件|群发|退出登录|注销账号|授权|允许访问/.test(
      name,
    ) ||
    (!!element.closest('[role="dialog"],[role="alertdialog"]') &&
      /^(确定|确认|是|继续)$/.test(name) &&
      /删除|付款|支付|转账|发送邮件|授权/.test(
        element.closest('[role="dialog"],[role="alertdialog"]')!.textContent ||
          "",
      ))
  );
}

type Stored = {
  element: HTMLElement;
  fingerprint: string;
  options?: Map<string, string>;
};
export type ActionContext = { signal?: AbortSignal; isCurrent: () => boolean };

/** Observe semantic controls in the current document. No model-supplied selector,
 * script, URL or coordinate is ever executed. References belong to one snapshot. */
export class RealtimePageController {
  private refs = new Map<string, Stored>();
  private snapshotId = "";
  private href = "";
  private observedAt = 0;
  private scopeMarker = "";
  private closed = false;
  private busy = false;
  private routeBound = !!document.querySelector(
    '[data-voice-page-root="true"]',
  );
  private last?: PageObservation;
  constructor(private options: { navigate?: (path: string) => void } = {}) {}

  private pageReady() {
    const root = document.querySelector<HTMLElement>(
      '[data-voice-page-root="true"]',
    );
    if (root) this.routeBound = true;
    return (
      !this.routeBound ||
      (!!root &&
        visible(root) &&
        root.dataset.voicePagePath ===
          location.pathname + location.search + location.hash)
    );
  }

  private unreadyObservation(): PageObservation {
    this.refs.clear();
    this.snapshotId = "";
    this.scopeMarker = "";
    this.last = {
      ...this.emptyObservation(),
      path: publicPath(),
      ready: false,
      text: "页面或弹窗正在切换、加载或被遮挡，尚无可操作的快照，请稍后重新观察。",
    };
    return this.last;
  }

  observe(query = ""): PageObservation {
    if (this.closed) throw Error("语音已结束，未读取页面");
    this.refs.clear();
    const scope = pageScope();
    if (!this.pageReady() || !scope.ready) return this.unreadyObservation();
    this.snapshotId = crypto.randomUUID();
    this.href = location.href;
    this.observedAt = Date.now();
    this.scopeMarker = scope.marker;
    const dialog = scope.dialog,
      needle = compact(query, 100).toLowerCase().replace(/\s+/g, "");
    const all = new Set(
      Array.from(document.querySelectorAll<HTMLElement>(candidates)),
    );
    for (const element of Array.from(
      document.querySelectorAll<HTMLElement>(
        'main,section,aside,[role="dialog"],[role="listbox"],div',
      ),
    ).slice(0, 2500)) {
      if (visible(element) && scrollable(element)) all.add(element);
    }
    const controls: PageObservation["controls"] = [];
    const blockedControls: NonNullable<PageObservation["blockedControls"]> = [];
    let truncated = false,
      controlsBytes = 0;
    for (const element of all) {
      if (!visible(element) || !scopeAllows(element, scope)) continue;
      const viewport = inViewport(element);
      if (viewport && !pointerPoint(element)) continue;
      // Avoid a nested span and its enclosing native button becoming two targets.
      if (
        !element.matches("button,a,input,textarea,select,summary") &&
        element.parentElement?.closest("button,a[href]")
      )
        continue;
      const role = roleOf(element),
        context = contextOf(element);
      const name = nameOf(element) || (scrollable(element) ? "可滚动区域" : "");
      if (
        !name ||
        (needle &&
          !`${name} ${context}`
            .toLowerCase()
            .replace(/\s+/g, "")
            .includes(needle))
      )
        continue;
      if (forbiddenAction(element) && blockedControls.length < 20)
        blockedControls.push({ name, reason: "需要用户在原页面确认" });
      if (controls.length >= 100) {
        truncated = true;
        break;
      }
      const ref = `ref-${controls.length + 1}`;
      let options: PageObservation["controls"][number]["options"];
      if (element instanceof HTMLSelectElement) {
        options = [];
        let optionBytes = 0;
        for (const option of Array.from(element.options)) {
          if (option.value.length > 2000) {
            truncated = true;
            continue;
          }
          const item = {
            value: option.value,
            label: compact(option.label),
            disabled:
              option.disabled ||
              (option.parentElement instanceof HTMLOptGroupElement &&
                option.parentElement.disabled),
          };
          const bytes = new TextEncoder().encode(JSON.stringify(item)).length;
          if (options.length >= 80 || optionBytes + bytes > 6000) {
            truncated = true;
            break;
          }
          options.push(item);
          optionBytes += bytes;
        }
      }
      const control: PageObservation["controls"][number] = {
        ref,
        role,
        name,
        ...(context ? { context } : {}),
        disabled: disabled(element),
        inViewport: viewport,
        ...(valueOf(element) !== undefined ? { value: valueOf(element) } : {}),
        ...(options ? { options } : {}),
      };
      const controlBytes = new TextEncoder().encode(
        JSON.stringify(control),
      ).length;
      if (controlsBytes + controlBytes > 30000) {
        truncated = true;
        continue;
      }
      controlsBytes += controlBytes;
      controls.push(control);
      this.refs.set(ref, {
        element,
        fingerprint: fingerprint(element),
        options: control.options
          ? new Map(
              control.options.map((option) => [option.value, option.label]),
            )
          : undefined,
      });
    }
    const headings = Array.from(
      (dialog || document).querySelectorAll<HTMLElement>(
        'h1,h2,h3,[role="heading"]',
      ),
    )
      .filter((el) => visible(el) && inViewport(el) && !!pointerPoint(el))
      .map((el) => visibleText(el, 180))
      .filter(Boolean)
      .slice(0, 12);
    const content = pageText(scope);
    this.last = {
      snapshotId: this.snapshotId,
      path: publicPath(),
      title: compact(document.title),
      ready: true,
      pageName: pageName(),
      ...(dialog
        ? { dialog: { title: dialogTitle(dialog), depth: scope.depth } }
        : {}),
      ...(blockedControls.length ? { blockedControls } : {}),
      headings,
      text: content.parts.join("\n"),
      controls,
      truncated: truncated || content.truncated,
    };
    // Budget the complete UTF-8 tool result, including native select options.
    // Removed controls also lose their references; the model cannot use unseen IDs.
    while (
      new TextEncoder().encode(JSON.stringify(this.last)).length > 44000 &&
      controls.length
    ) {
      const removed = controls.pop()!;
      this.refs.delete(removed.ref);
      this.last.truncated = true;
    }
    return this.last;
  }
  private assertCurrent(context: ActionContext) {
    if (this.closed || context.signal?.aborted || !context.isCurrent())
      throw Error("语音已打断或结束，未执行页面操作");
  }
  currentSnapshot(): string;
  currentSnapshot(snapshotId: string): boolean;
  currentSnapshot(snapshotId?: string): string | boolean {
    const scope = pageScope();
    const current =
      !this.closed &&
      !!this.snapshotId &&
      this.href === location.href &&
      Date.now() - this.observedAt <= 60000 &&
      this.pageReady() &&
      scope.ready &&
      scope.marker === this.scopeMarker
        ? this.snapshotId
        : "";
    return snapshotId === undefined
      ? current
      : !!current && snapshotId === current;
  }
  /** Check the caller's evidence against the live safe scope, without issuing
   * another snapshot. A changed status cannot inherit an earlier success. */
  currentEvidence(snapshotId: string, evidence: string): boolean {
    if (!this.currentSnapshot(snapshotId) || !this.last) return false;
    const normalize = (value: string) =>
      value.replace(/\s+/g, "").toLowerCase();
    const needle = normalize(evidence);
    if (needle.length < 2 || evidence.length > 180) return false;
    const unchanged = (previous: string, current: string) =>
      normalize(previous).includes(needle) &&
      normalize(previous) === normalize(current);
    if (
      unchanged(this.last.path, publicPath()) ||
      unchanged(this.last.pageName || "", pageName())
    )
      return true;
    const scope = pageScope(),
      content = pageText(scope),
      currentParts = new Set(content.parts.map(normalize));
    // Match the whole observed text fragment as well as the quoted evidence:
    // "更新完成" must not still match a newly rendered "未更新完成".
    if (
      this.last.text.split("\n").some((part) => {
        const text = normalize(part);
        return text.includes(needle) && currentParts.has(text);
      }) ||
      unchanged(this.last.text, content.parts.join("\n"))
    )
      return true;
    return this.last.controls.some((control) => {
      const element = this.refs.get(control.ref)?.element;
      return (
        !!element &&
        visible(element) &&
        inViewport(element) &&
        scopeAllows(element, scope) &&
        !!pointerPoint(element) &&
        unchanged(control.name, nameOf(element))
      );
    });
  }
  private pause(context: ActionContext, milliseconds: number) {
    this.assertCurrent(context);
    return new Promise<void>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        context.signal?.removeEventListener("abort", finish);
        try {
          this.assertCurrent(context);
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      const timer = setTimeout(finish, milliseconds);
      context.signal?.addEventListener("abort", finish, { once: true });
      if (context.signal?.aborted) finish();
    });
  }
  /** Wait for both React route commit and a stable, interactive modal scope.
   * Does not issue a new snapshot or invalidate the caller's references. */
  async waitForReady(
    context: ActionContext,
    timeoutMs = 3000,
  ): Promise<boolean> {
    const timeout = Number.isFinite(timeoutMs)
      ? Math.max(0, Math.min(10000, timeoutMs))
      : 3000;
    const deadline = performance.now() + timeout;
    let marker = "",
      since = performance.now();
    do {
      this.assertCurrent(context);
      const scope = pageScope();
      const next =
        this.pageReady() && scope.ready ? location.href + scope.marker : "";
      if (!next || next !== marker) {
        marker = next;
        since = performance.now();
      } else if (performance.now() - since >= 80) return true;
      if (performance.now() >= deadline) return false;
      await this.pause(
        context,
        Math.min(40, Math.max(1, deadline - performance.now())),
      );
    } while (true);
  }
  private async settle(context: ActionContext) {
    await this.pause(context, 120);
  }
  async action(
    input: PageActionInput,
    context: ActionContext,
  ): Promise<PageActionResult> {
    if (this.busy) throw Error("已有页面操作正在处理，请等待结果");
    this.busy = true;
    let dispatched = false;
    try {
      return await this.performAction(input, context, () => {
        dispatched = true;
        this.refs.clear();
        this.snapshotId = "";
      });
    } catch (error) {
      if (dispatched) throw error;
      return {
        text:
          error instanceof Error ? error.message : "页面操作未执行，请重新观察",
        dispatched: false,
        observation:
          !this.closed && !context.signal?.aborted && context.isCurrent()
            ? this.observe()
            : this.emptyObservation(),
      };
    } finally {
      this.busy = false;
    }
  }
  private emptyObservation(): PageObservation {
    return {
      snapshotId: "",
      path: "",
      title: "",
      headings: [],
      text: "",
      controls: [],
      truncated: false,
    };
  }
  private async performAction(
    input: PageActionInput,
    context: ActionContext,
    dispatch: () => void,
  ): Promise<PageActionResult> {
    this.assertCurrent(context);
    const args = pageActionSchema.parse(input);
    if (!this.currentSnapshot(args.snapshotId))
      throw Error("页面或观察结果已变化，请重新观察当前页面后操作");
    const stored = args.ref ? this.refs.get(args.ref) : undefined;
    if (args.ref && !stored) throw Error("未找到本次观察中的控件，请重新观察");
    const element = stored?.element;
    const validate = () => {
      this.assertCurrent(context);
      if (
        !this.currentSnapshot(args.snapshotId) ||
        (element &&
          (!visible(element) ||
            disabled(element) ||
            !scopeAllows(element, pageScope()) ||
            fingerprint(element) !== stored!.fingerprint))
      )
        throw Error("控件已变化、不可见或不可用，请重新观察页面");
    };
    validate();
    let description: string;
    if (args.action === "scroll") {
      if (element && inViewport(element) && !pointerPoint(element))
        throw Error("滚动区域被遮挡，请重新观察页面");
      const scope = pageScope();
      let target = element || scope.dialog;
      if (target && !scrollable(target))
        target = Array.from(
          target.querySelectorAll<HTMLElement>("div,section,main"),
        ).find((node) => visible(node) && scrollable(node));
      if (!target && document.documentElement.scrollHeight <= innerHeight + 8)
        target = Array.from(
          document.querySelectorAll<HTMLElement>("main,section,div"),
        )
          .filter(
            (node) =>
              visible(node) &&
              inViewport(node) &&
              pointerPoint(node) &&
              scopeAllows(node, scope) &&
              scrollable(node),
          )
          .sort(
            (a, b) =>
              b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight,
          )[0];
      const distance =
        Math.max(180, (target?.clientHeight || innerHeight) * 0.7) *
        (args.direction === "down" ? 1 : -1);
      validate();
      const before = target?.scrollTop ?? scrollY;
      dispatch();
      if (target) target.scrollBy({ top: distance, behavior: "instant" });
      else window.scrollBy({ top: distance, behavior: "instant" });
      description =
        (target?.scrollTop ?? scrollY) === before
          ? "已到当前滚动区域边界，位置未改变"
          : `已向${args.direction === "down" ? "下" : "上"}滚动`;
    } else {
      if (!element) throw Error("请先观察并指定目标控件");
      if (forbiddenAction(element))
        throw Error("此控件涉及授权或需人工核对的操作，请使用页面原有操作入口");
      if (!inViewport(element)) {
        hitTarget(element).scrollIntoView({
          block: "center",
          inline: "nearest",
          behavior: "instant",
        });
        await this.settle(context);
        validate();
      }
      const point = pointerPoint(element);
      if (!point) throw Error("目标被弹窗或其他内容遮挡，请重新观察后处理遮挡");
      const name = nameOf(element);
      if (args.action === "click") {
        if (
          (element instanceof HTMLButtonElement && element.type === "submit") ||
          (element instanceof HTMLInputElement &&
            ["submit", "image"].includes(element.type))
        ) {
          const form = element.form;
          const action =
            element.getAttribute("formaction") || form?.getAttribute("action");
          const target = element.getAttribute("formtarget") || form?.target;
          if (
            (action &&
              new URL(action, location.href).origin !== location.origin) ||
            (target && target !== "_self")
          )
            throw Error("该控件会向外部页面或新窗口提交，请使用原页面操作");
        }
        if (element instanceof HTMLAnchorElement) {
          const href = element.getAttribute("href") || "";
          const url = new URL(href, location.href);
          if (
            !href ||
            url.origin !== location.origin ||
            !["http:", "https:"].includes(url.protocol) ||
            element.hasAttribute("download")
          )
            throw Error(
              "此链接不属于当前网站页面，请手动打开或使用已授权电脑操作",
            );
          if (this.options.navigate && href !== "#") {
            validate();
            dispatch();
            this.options.navigate(url.pathname + url.search + url.hash);
          } else if (
            href !== "#" &&
            url.pathname + url.search !== location.pathname + location.search
          ) {
            throw Error("当前页面未连接站内导航，请重新开始通话");
          } else {
            validate();
            dispatch();
            element.click();
          }
        } else {
          const target = hitTarget(element),
            init = {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: point.x,
              clientY: point.y,
              button: 0,
            };
          validate();
          dispatch();
          target.dispatchEvent(
            new PointerEvent("pointerdown", {
              ...init,
              pointerId: 1,
              pointerType: "mouse",
              buttons: 1,
            }),
          );
          target.dispatchEvent(
            new MouseEvent("mousedown", { ...init, buttons: 1 }),
          );
          if (!target.isConnected) throw Error("控件已变化，请重新观察");
          this.assertCurrent(context);
          target.focus({ preventScroll: true });
          target.dispatchEvent(
            new PointerEvent("pointerup", {
              ...init,
              pointerId: 1,
              pointerType: "mouse",
            }),
          );
          target.dispatchEvent(new MouseEvent("mouseup", init));
          this.assertCurrent(context);
          target.click();
        }
        description = `已点击“${name}”；这只表示页面操作已派发，业务是否完成请依据页面反馈`;
      } else if (args.action === "fill") {
        if (
          !(
            element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement
          ) ||
          element.readOnly ||
          (element instanceof HTMLInputElement &&
            ![
              "text",
              "search",
              "email",
              "tel",
              "url",
              "number",
              "date",
              "datetime-local",
              "month",
              "time",
              "week",
            ].includes(element.type))
        )
          throw Error("该控件不是可编辑输入框；请重新观察并选择输入控件");
        validate();
        element.focus({ preventScroll: true });
        validate();
        dispatch();
        const prototype =
          element instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
          element,
          args.value,
        );
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        description = `已派发填写“${name}”的操作，请依据页面反馈确认结果`;
      } else {
        if (!(element instanceof HTMLSelectElement))
          throw Error("该选择器需先点击展开，再观察并点击具体选项");
        const option = Array.from(element.options).find(
          (item) => item.value === args.value,
        );
        if (
          !option ||
          stored?.options?.get(args.value) !== compact(option.label) ||
          option.disabled ||
          (option.parentElement instanceof HTMLOptGroupElement &&
            option.parentElement.disabled)
        )
          throw Error("选项不存在或已禁用，请重新观察");
        validate();
        element.focus({ preventScroll: true });
        validate();
        dispatch();
        Object.getOwnPropertyDescriptor(
          HTMLSelectElement.prototype,
          "value",
        )!.set!.call(element, args.value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        description = `已派发选择“${option.label}”的操作，请依据页面反馈确认结果`;
      }
    }
    // Invalidate references immediately: a repeated model event cannot click twice.
    this.refs.clear();
    this.snapshotId = "";
    let stable = false;
    try {
      // Allow the click handler/React update to start, then wait through any
      // enter/leave animation instead of observing its stale portal layer.
      await this.pause(context, 40);
      stable = await this.waitForReady(context);
    } catch (error) {
      if (!this.closed && !context.signal?.aborted && context.isCurrent())
        throw error;
    }
    if (this.closed || context.signal?.aborted || !context.isCurrent())
      return {
        text: description,
        dispatched: true,
        observation: this.emptyObservation(),
      };
    return {
      text: description,
      dispatched: true,
      observation: stable ? this.observe() : this.unreadyObservation(),
    };
  }
  close() {
    this.closed = true;
    this.refs.clear();
    this.snapshotId = "";
    this.scopeMarker = "";
    this.last = undefined;
  }
}
