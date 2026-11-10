import { describe, expect, test } from "vitest";
import {
  ASSISTANT_CHAT_STICK_PX,
  assistantChatGap,
  createAssistantChatStickController,
  findAssistantChatScroller,
  isAssistantChatNearBottom,
  scrollAssistantChatToBottom,
} from "../../apps/web/src/assistant-chat-scroll.js";

const box = (
  scrollTop: number,
  scrollHeight = 1000,
  clientHeight = 400,
) => ({ scrollTop, scrollHeight, clientHeight });

describe("assistant chat scroll sticks to the latest messages", () => {
  test("measures the remaining distance to the bottom", () => {
    expect(assistantChatGap(box(0))).toBe(600);
    expect(assistantChatGap(box(520))).toBe(80);
    expect(assistantChatGap(box(600))).toBe(0);
  });

  test("treats a position within 80px as near the bottom", () => {
    expect(ASSISTANT_CHAT_STICK_PX).toBe(80);
    expect(isAssistantChatNearBottom(box(519))).toBe(false);
    expect(isAssistantChatNearBottom(box(520))).toBe(true);
    expect(isAssistantChatNearBottom(box(600))).toBe(true);
  });

  test("jumps scrollTop to the last visible edge", () => {
    const current = box(100);
    scrollAssistantChatToBottom(current);
    expect(current.scrollTop).toBe(600);
  });

  test("finds the Ant Design drawer body as the scroller", () => {
    type Node = {
      parentElement: Node | null;
      classList: { contains(name: string): boolean };
    };
    const node = (className: string, parentElement: Node | null = null): Node => ({
      parentElement,
      classList: { contains: (name: string) => name === className },
    });
    const body = node("ant-drawer-body");
    const messages = node("assistant-messages", body);
    const sentinel = node("assistant-chat-end", messages);
    expect(findAssistantChatScroller(sentinel)).toBe(body);
    expect(findAssistantChatScroller(null)).toBe(null);
  });

  test("opening always pins to the bottom even when the list was mid-scroll", () => {
    const controller = createAssistantChatStickController();
    const current = box(100);
    controller.open();
    controller.pin(current);
    expect(current.scrollTop).toBe(600);
    expect(controller.force).toBe(false);
    expect(controller.stick).toBe(true);
  });

  test("keeps sticking after history, captions, or a live-call strip grow the list", () => {
    const controller = createAssistantChatStickController();
    const current = box(600);
    controller.open();
    controller.pin(current);
    current.scrollHeight = 1300;
    controller.pin(current);
    expect(current.scrollTop).toBe(900);
    current.scrollTop = 860;
    controller.onUserScroll(current);
    expect(controller.stick).toBe(true);
    current.scrollHeight = 1400;
    controller.pin(current);
    expect(current.scrollTop).toBe(1000);
  });

  test("does not yank the reader after they scroll up to older messages", () => {
    const controller = createAssistantChatStickController();
    const current = box(600);
    controller.open();
    controller.pin(current);
    current.scrollTop = 200;
    controller.onUserScroll(current);
    expect(controller.stick).toBe(false);
    current.scrollHeight = 1600;
    controller.pin(current);
    expect(current.scrollTop).toBe(200);
  });

  test("resumes sticking after the reader returns to the bottom", () => {
    const controller = createAssistantChatStickController();
    const current = box(600);
    controller.open();
    controller.pin(current);
    current.scrollTop = 100;
    controller.onUserScroll(current);
    current.scrollTop = 590;
    controller.onUserScroll(current);
    expect(controller.stick).toBe(true);
    current.scrollHeight = 1200;
    controller.pin(current);
    expect(current.scrollTop).toBe(800);
  });

  test("reopening forces the latest messages even after reading history", () => {
    const controller = createAssistantChatStickController();
    const current = box(600);
    controller.open();
    controller.pin(current);
    current.scrollTop = 40;
    controller.onUserScroll(current);
    controller.close();
    controller.open();
    controller.pin(current);
    expect(current.scrollTop).toBe(600);
  });

  test("drawer settle after open animation still jumps to the bottom", () => {
    const controller = createAssistantChatStickController();
    const current = box(80, 800, 400);
    controller.open();
    current.clientHeight = 0;
    current.scrollHeight = 0;
    controller.pin(current);
    controller.settle();
    current.clientHeight = 400;
    current.scrollHeight = 1200;
    current.scrollTop = 200;
    controller.pin(current);
    expect(current.scrollTop).toBe(800);
  });
});
