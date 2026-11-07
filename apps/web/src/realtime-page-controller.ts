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
function activeDialog() {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="dialog"],[role="alertdialog"]',
    ),
  )
    .filter(visible)
    .at(-1);
}
function scopeAllows(element: HTMLElement, dialog: HTMLElement | undefined) {
  return (
    !dialog ||
    dialog.contains(element) ||
    !!element.closest(
      '[role="listbox"],.ant-select-dropdown,.ant-picker-dropdown',
    )
  );
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
type ActionContext = { signal?: AbortSignal; isCurrent: () => boolean };

/** Observe semantic controls in the current document. No model-supplied selector,
 * script, URL or coordinate is ever executed. References belong to one snapshot. */
export class RealtimePageController {
  private refs = new Map<string, Stored>();
  private snapshotId = "";
  private href = "";
  private observedAt = 0;
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

  observe(query = ""): PageObservation {
    if (this.closed) throw Error("语音已结束，未读取页面");
    this.refs.clear();
    if (!this.pageReady()) {
      this.snapshotId = "";
      this.last = {
        ...this.emptyObservation(),
        path: publicPath(),
        ready: false,
        text: "页面正在切换或加载，尚无可操作的页面快照，请稍后重新观察。",
      };
      return this.last;
    }
    this.snapshotId = crypto.randomUUID();
    this.href = location.href;
    this.observedAt = Date.now();
    const dialog = activeDialog(),
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
    let truncated = false,
      controlsBytes = 0;
    for (const element of all) {
      if (!visible(element) || !scopeAllows(element, dialog)) continue;
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
    const walker = document.createTreeWalker(
      dialog || document.body,
      NodeFilter.SHOW_TEXT,
    );
    const parts: string[] = [];
    let length = 0,
      scanned = 0;
    while (walker.nextNode() && scanned++ < 12000) {
      const parent = walker.currentNode.parentElement;
      const text = compact(walker.currentNode.textContent, 300);
      if (
        !parent ||
        !text ||
        !visible(parent) ||
        !inViewport(parent) ||
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
    const pageHeading = [
      ...primaryHeadings,
      ...Array.from(
        (pageRoot || document).querySelectorAll<HTMLElement>("h1,h2"),
      ),
    ].find((element) => visible(element) && !!visibleText(element, 180));
    this.last = {
      snapshotId: this.snapshotId,
      path: publicPath(),
      title: compact(document.title),
      ready: true,
      pageName: pageHeading ? visibleText(pageHeading, 180) : "",
      headings,
      text: parts.join("\n"),
      controls,
      truncated,
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
  private async settle(context: ActionContext) {
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    this.assertCurrent(context);
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
    if (
      args.snapshotId !== this.snapshotId ||
      this.href !== location.href ||
      Date.now() - this.observedAt > 60000
    )
      throw Error("页面或观察结果已变化，请重新观察当前页面后操作");
    const stored = args.ref ? this.refs.get(args.ref) : undefined;
    if (args.ref && !stored) throw Error("未找到本次观察中的控件，请重新观察");
    const element = stored?.element;
    const validate = () => {
      this.assertCurrent(context);
      if (
        !this.pageReady() ||
        args.snapshotId !== this.snapshotId ||
        this.href !== location.href ||
        (element &&
          (!visible(element) ||
            disabled(element) ||
            !scopeAllows(element, activeDialog()) ||
            fingerprint(element) !== stored!.fingerprint))
      )
        throw Error("控件已变化、不可见或不可用，请重新观察页面");
    };
    validate();
    let description: string;
    if (args.action === "scroll") {
      if (element && inViewport(element) && !pointerPoint(element))
        throw Error("滚动区域被遮挡，请重新观察页面");
      let target = element || activeDialog();
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
    await new Promise<void>((resolve) => setTimeout(resolve, 160));
    // A lazy React route can change the address before its DOM commits. Wait
    // for the route marker so a new path never carries the previous page's refs.
    const readyDeadline = Date.now() + 3000;
    while (
      !this.pageReady() &&
      Date.now() < readyDeadline &&
      !this.closed &&
      !context.signal?.aborted &&
      context.isCurrent()
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
    }
    if (this.closed || context.signal?.aborted || !context.isCurrent())
      return {
        text: description,
        dispatched: true,
        observation: this.emptyObservation(),
      };
    return { text: description, dispatched: true, observation: this.observe() };
  }
  close() {
    this.closed = true;
    this.refs.clear();
    this.snapshotId = "";
    this.last = undefined;
  }
}
