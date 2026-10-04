import { useLayoutEffect, useRef } from "react";

/** Size visible text controls in the shared table toolbar, including new ones. */
export function useSelectionToolbarWidths() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const toolbar = ref.current;
    if (!toolbar) return;
    const update = () => {
      for (const control of toolbar.querySelectorAll<HTMLElement>(
        "button.ant-btn, .selection-tool-select",
      )) {
        const text = control.matches(".selection-tool-select")
          ? control.querySelector(
              ".ant-select-content, .ant-select-selection-item",
            )?.textContent ||
            control.textContent ||
            ""
          : control.textContent || "";
        const length = text.match(/\p{Script=Han}/gu)?.length || 0;
        control.dataset.selectionControlWidth =
          length > 0 && length <= 4 ? "short" : "auto";
      }
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(toolbar, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, []);
  return ref;
}
