type Result = { active: boolean; expiresAtMs: number | null };

/** One backup at a time; a blocked platform storage read must not block UI actions. */
export function compassLoginCheckpoint(read: (signal: AbortSignal) => Promise<Result>, timeoutMs = 5000) {
  let pending: Promise<Result | null> | null = null, controller: AbortController | null = null;
  return {
    cancel() { controller?.abort(); controller = null; pending = null; },
    async run(): Promise<Result | null> {
      if (pending) return null;
      const abort = new AbortController(); controller = abort;
      const task = read(abort.signal).catch(error => { if (abort.signal.aborted) return null; throw error; });
      const tracked = task.finally(() => { if (pending === tracked) { pending = null; controller = null; } });
      pending = tracked;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([tracked, new Promise<null>(resolve => {
          timer = setTimeout(() => { abort.abort(); console.warn(JSON.stringify({ event: "compass_login_checkpoint_timeout" })); resolve(null); }, timeoutMs);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    },
  };
}
