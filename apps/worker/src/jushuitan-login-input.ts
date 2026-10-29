import { randomUUID } from "node:crypto";
import type { ElementHandle, Page } from "@playwright/test";
import {
  isJushuitanOrigin,
  jushuitanViewport,
  type JushuitanLoginInput,
} from "../../../packages/contracts/src/jushuitan-inventory.js";
import { JstBrowserError } from "./jushuitan-browser-export.js";

const editable =
  'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="file"]):not([type="image"]):not([type="range"]):not([type="color"]),textarea';
export function jstLoginMasks(page: Page) {
  return page
    .frames()
    .filter((f) => !f.isDetached())
    .map((f) => f.locator(`${editable},[contenteditable="true"]`));
}

/** Exposes only geometry, a random focus token and whether a field is filled. */
export class JstLoginInputTracker {
  private active: { id: string; handle: ElementHandle } | null = null;
  async current(page: Page): Promise<JushuitanLoginInput | null> {
    for (const frame of page.frames()) {
      if (!isJushuitanOrigin(frame.url())) continue;
      const locator = frame.locator(editable).filter({ visible: true });
      const handles = await locator.elementHandles();
      let selected: ElementHandle | undefined;
      for (const handle of handles) {
        if (
          !selected &&
          (await handle.evaluate((el) => el === document.activeElement)) &&
          (await handle.isEditable())
        )
          selected = handle;
        else await handle.dispose();
      }
      if (!selected) continue;
      const same =
        this.active &&
        (await selected
          .evaluate((el, previous) => el === previous, this.active.handle)
          .catch(() => false));
      if (same) await selected.dispose();
      else {
        await this.active?.handle.dispose().catch(() => {});
        this.active = { id: randomUUID(), handle: selected };
      }
      const { id, handle } = this.active!;
      const box = await handle.boundingBox();
      if (!box || box.width <= 0 || box.height <= 0) break;
      const info = await handle.evaluate((el) => {
        const input = el as HTMLInputElement | HTMLTextAreaElement;
        const hint = [
          input.getAttribute("autocomplete"),
          input.getAttribute("placeholder"),
          input.getAttribute("aria-label"),
          input.getAttribute("name"),
        ].join(" ");
        const label: JushuitanLoginInput["label"] =
          input.getAttribute("type") === "password"
            ? "密码"
            : /one-time-code|验证码/i.test(hint)
              ? "验证码"
              : /username|账号|用户名|手机号|mobile|account/i.test(hint)
                ? "账号"
                : "当前输入框";
        return { label, filled: input.value.length > 0 };
      });
      const x = Math.max(0, box.x),
        y = Math.max(0, box.y);
      const right = Math.min(jushuitanViewport.width, box.x + box.width),
        bottom = Math.min(jushuitanViewport.height, box.y + box.height);
      if (right <= x || bottom <= y) break;
      return {
        id,
        ...info,
        rect: {
          x: x / jushuitanViewport.width,
          y: y / jushuitanViewport.height,
          width: (right - x) / jushuitanViewport.width,
          height: (bottom - y) / jushuitanViewport.height,
        },
      };
    }
    await this.active?.handle.dispose().catch(() => {});
    this.active = null;
    return null;
  }
  async fill(page: Page, targetId: string | undefined, value: string) {
    const selected = await this.current(page);
    if (!selected || (targetId && selected.id !== targetId))
      throw new JstBrowserError(
        "选中的输入框已改变，请重新点击账号、密码或验证码框后填写",
      );
    await this.active!.handle.fill(value);
  }
}
