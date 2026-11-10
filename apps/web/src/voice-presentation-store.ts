import { create } from "zustand";
import { api } from "./api.js";
import {
  parsePresentationCall,
  presentationRecordText,
  presentationToolResult,
  type PresentationDeck,
} from "../../../packages/contracts/src/assistant-presentation.js";
import {
  initialPresentationState,
  presentationReducer,
  type PresentationAction,
  type PresentationState,
} from "./voice-presentation-state.js";

type Store = PresentationState & {
  dispatch: (action: PresentationAction) => void;
};
export const usePresentationStore = create<Store>((set) => ({
  ...initialPresentationState,
  dispatch: (action) => set((store) => presentationReducer(store, action)),
}));
export const dispatchPresentation = (action: PresentationAction) =>
  usePresentationStore.getState().dispatch(action);

// Keep a compact titles-only record in the chat history so a deck can be reviewed later.
async function saveRecord(
  sessionId: string,
  deck: PresentationDeck,
  onSaved?: () => void,
) {
  const body = {
    messages: [
      {
        id: crypto.randomUUID(),
        role: "assistant",
        text: presentationRecordText(deck),
      },
    ],
  };
  const path = `/my-workspace/assistant/realtime/sessions/${sessionId}/captions`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await api(path, "POST", body);
      onSaved?.();
      return;
    } catch {
      // The conversation may be briefly locked while a tool runs; retry later.
      await new Promise((resolve) => setTimeout(resolve, 4000));
    }
  }
}

/**
 * Execute one presentation tool call locally and return the function output
 * for the voice model. Arguments are validated again in the browser even when
 * the server relay already checked them.
 */
export function runPresentationTool(
  name: string,
  args: unknown,
  sessionId?: string,
  onSaved?: () => void,
) {
  const parsed = parsePresentationCall(name, args, {
    origin: globalThis.location?.origin,
  });
  if (!parsed.ok) return { ok: false, text: parsed.error };
  const command = parsed.command;
  dispatchPresentation({ type: "command", command });
  const state = usePresentationStore.getState();
  if (command.kind === "open" && sessionId)
    void saveRecord(sessionId, command.deck, onSaved);
  return presentationToolResult(command, {
    index: state.index,
    total: state.deck?.slides.length ?? 0,
    title: state.deck?.slides[state.index]?.title,
  });
}
