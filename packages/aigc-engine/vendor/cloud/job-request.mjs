import { AsyncLocalStorage } from "node:async_hooks";

const context = new AsyncLocalStorage();

export function withJobSignal(signal, work) {
  return context.run(signal, work);
}

// Keep the deadline active through response-body consumption as well as fetch.
// Cancelling one job only aborts requests made in that job's async context.
export function jobRequestSignal(timeoutMs, additionalSignal) {
  const signals = [context.getStore(), additionalSignal, AbortSignal.timeout(timeoutMs)].filter(Boolean);
  return AbortSignal.any(signals);
}
