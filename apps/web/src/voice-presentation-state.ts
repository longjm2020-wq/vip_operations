import type {
  PresentationCommand,
  PresentationDeck,
} from "../../../packages/contracts/src/assistant-presentation.js";

/** Pure panel state. The React store and unit tests share this reducer. */
export type PresentationState = {
  deck?: PresentationDeck;
  index: number;
  /** Spoken milliseconds accumulated on the current slide. */
  elapsed: number;
  paused: boolean;
  minimized: boolean;
  /** The voice call ended; keep the last slide for review until closed. */
  ended: boolean;
  /** Assistant caption being followed and how much of it was already read. */
  captionId: string;
  cursor: number;
};
export type PresentationAction =
  | { type: "command"; command: PresentationCommand }
  | { type: "next" }
  | { type: "prev" }
  | { type: "goto"; index: number }
  | { type: "close" }
  | { type: "pause"; paused?: boolean }
  | { type: "minimize"; minimized?: boolean }
  | { type: "tick"; ms: number; speaking: boolean }
  | { type: "transcript"; id: string; text: string }
  | { type: "call-ended" };

export const initialPresentationState: PresentationState = {
  index: 0,
  elapsed: 0,
  paused: false,
  minimized: false,
  ended: false,
  captionId: "",
  cursor: 0,
};
/** Minimum spoken time on a slide before a cue may advance past it. */
export const cueDwellMs = 2000;

const normalize = (value: string) =>
  value
    .replace(/[\s，。、；：！？,.;:!?“”"'‘’《》（）()【】\-—·]/g, "")
    .toLowerCase();

function move(state: PresentationState, index: number): PresentationState {
  if (!state.deck) return state;
  const clamped = Math.max(0, Math.min(state.deck.slides.length - 1, index));
  if (clamped === state.index) return { ...state, minimized: false };
  return { ...state, index: clamped, elapsed: 0, minimized: false };
}

export function presentationReducer(
  state: PresentationState,
  action: PresentationAction,
): PresentationState {
  switch (action.type) {
    case "command": {
      const c = action.command;
      // Speech said before the deck opened (e.g. an overview) never advances it.
      if (c.kind === "open")
        return {
          ...initialPresentationState,
          deck: c.deck,
          captionId: state.captionId,
          cursor: state.cursor,
        };
      if (c.kind === "close")
        return {
          ...initialPresentationState,
          captionId: state.captionId,
          cursor: state.cursor,
        };
      if (!state.deck) return state;
      // A model-driven move resumes auto-advance from the new slide.
      const next = move(state, c.kind === "next" ? state.index + 1 : c.index);
      return { ...next, paused: false };
    }
    case "next":
      return move(state, state.index + 1);
    case "prev":
      return move(state, state.index - 1);
    case "goto":
      return move(state, action.index);
    case "close":
      return {
        ...initialPresentationState,
        captionId: state.captionId,
        cursor: state.cursor,
      };
    case "pause":
      return state.deck
        ? { ...state, paused: action.paused ?? !state.paused }
        : state;
    case "minimize":
      return state.deck
        ? { ...state, minimized: action.minimized ?? !state.minimized }
        : state;
    case "call-ended":
      return state.deck ? { ...state, ended: true, paused: true } : state;
    case "tick": {
      const deck = state.deck;
      if (!deck || state.paused || state.ended || !action.speaking)
        return state;
      const last = state.index >= deck.slides.length - 1;
      const elapsed = state.elapsed + Math.max(0, action.ms);
      if (!last && elapsed >= deck.slides[state.index].seconds * 1000)
        return { ...state, index: state.index + 1, elapsed: 0 };
      return { ...state, elapsed };
    }
    case "transcript": {
      const text = normalize(action.text);
      let cursor = action.id === state.captionId ? state.cursor : 0;
      if (cursor > text.length) cursor = 0;
      const deck = state.deck;
      if (!deck || state.ended || state.paused)
        return { ...state, captionId: action.id, cursor: text.length };
      // Follow the narration one slide per spoken cue, in spoken order, and
      // only after the current slide has been on screen briefly.
      if (state.index < deck.slides.length - 1 && state.elapsed >= cueDwellMs) {
        const cue = normalize(deck.slides[state.index + 1].cue);
        const at = cue.length >= 2 ? text.indexOf(cue, cursor) : -1;
        if (at >= 0)
          return {
            ...state,
            index: state.index + 1,
            elapsed: 0,
            captionId: action.id,
            cursor: at + cue.length,
          };
      }
      return { ...state, captionId: action.id, cursor };
    }
  }
}
