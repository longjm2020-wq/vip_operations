import { useEffect, useRef, type RefObject } from "react";

export const ASSISTANT_CHAT_STICK_PX = 80;

export type AssistantChatScrollBox = {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
};

export function assistantChatGap(box: AssistantChatScrollBox): number {
  return box.scrollHeight - box.clientHeight - box.scrollTop;
}

export function isAssistantChatNearBottom(
  box: AssistantChatScrollBox,
  threshold = ASSISTANT_CHAT_STICK_PX,
): boolean {
  return assistantChatGap(box) <= threshold;
}

export function scrollAssistantChatToBottom(box: AssistantChatScrollBox): void {
  const top = Math.max(0, box.scrollHeight - box.clientHeight);
  if (Math.abs(box.scrollTop - top) > 1) box.scrollTop = top;
}

export type AssistantChatScrollNode = {
  parentElement: AssistantChatScrollNode | null;
  classList: { contains(name: string): boolean };
};

export function findAssistantChatScroller(
  from: AssistantChatScrollNode | null,
): AssistantChatScrollNode | null {
  let node = from;
  while (node) {
    if (node.classList.contains("ant-drawer-body")) return node;
    node = node.parentElement;
  }
  return null;
}

export function createAssistantChatStickController(
  threshold = ASSISTANT_CHAT_STICK_PX,
) {
  let force = false;
  let stick = true;
  return {
    get force() {
      return force;
    },
    get stick() {
      return stick;
    },
    open() {
      force = true;
      stick = true;
    },
    close() {
      force = false;
      stick = true;
    },
    settle() {
      force = true;
      stick = true;
    },
    onUserScroll(box: AssistantChatScrollBox) {
      if (force) return;
      stick = isAssistantChatNearBottom(box, threshold);
    },
    pin(box: AssistantChatScrollBox) {
      if (!force && !stick) return;
      scrollAssistantChatToBottom(box);
      if (force && isAssistantChatNearBottom(box, 1)) {
        force = false;
        stick = true;
      }
    },
  };
}

export function useAssistantChatScroll(
  active: boolean,
  settled: boolean,
  sentinelRef: RefObject<HTMLElement | null>,
  layoutKey: unknown,
) {
  const controllerRef = useRef<ReturnType<
    typeof createAssistantChatStickController
  > | null>(null);
  if (!controllerRef.current)
    controllerRef.current = createAssistantChatStickController();
  const wasActive = useRef(false);
  const wasSettled = useRef(false);

  useEffect(() => {
    const controller = controllerRef.current!;
    if (!active) {
      wasActive.current = false;
      wasSettled.current = false;
      controller.close();
      return;
    }
    if (!wasActive.current) {
      controller.open();
      wasActive.current = true;
    }
    if (settled && !wasSettled.current) {
      controller.settle();
      wasSettled.current = true;
    }

    const scroller = findAssistantChatScroller(
      sentinelRef.current,
    ) as HTMLElement | null;
    if (!scroller) return;

    const pin = () => controller.pin(scroller);
    pin();
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      pin();
      inner = requestAnimationFrame(pin);
    });

    const onScroll = () => controller.onUserScroll(scroller);
    scroller.addEventListener("scroll", onScroll, { passive: true });

    const ro = new ResizeObserver(pin);
    ro.observe(scroller);
    const content = sentinelRef.current?.parentElement;
    if (content && content !== scroller) ro.observe(content);

    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      scroller.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [active, settled, layoutKey, sentinelRef]);
}
