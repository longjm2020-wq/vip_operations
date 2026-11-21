type SpokenTurn = { id: string; text: string };
const validTurnId = /^[\w-]{1,128}$/;

/** Tool calls and final provider transcripts can arrive in either order. */
export class RealtimeSpokenTurns {
  private completed = new Map<string, SpokenTurn | undefined>();
  private waiting = new Map<string, Set<(turn?: SpokenTurn) => void>>();

  finish(id: unknown, text?: unknown) {
    if (typeof id !== "string" || !validTurnId.test(id)) return;
    if (this.completed.has(id)) return;
    const value = typeof text === "string" ? text.trim() : "";
    const turn =
      value && value.length <= 4000 ? { id, text: value } : undefined;
    this.completed.set(id, turn);
    if (this.completed.size > 40) {
      const oldest = this.completed.keys().next().value;
      if (oldest) this.completed.delete(oldest);
    }
    for (const notify of this.waiting.get(id) ?? []) notify(turn);
  }

  async read(
    id: unknown,
    signal?: AbortSignal,
  ): Promise<SpokenTurn | undefined> {
    if (typeof id !== "string" || !validTurnId.test(id) || signal?.aborted)
      return;
    if (this.completed.has(id)) return this.completed.get(id);
    return new Promise((resolve) => {
      const listeners = this.waiting.get(id) ?? new Set();
      const cancel = () => done();
      const timeout = setTimeout(cancel, 2500);
      const done = (turn?: SpokenTurn) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", cancel);
        listeners.delete(done);
        if (!listeners.size) this.waiting.delete(id);
        resolve(turn);
      };
      listeners.add(done);
      this.waiting.set(id, listeners);
      signal?.addEventListener("abort", cancel, { once: true });
    });
  }
}
