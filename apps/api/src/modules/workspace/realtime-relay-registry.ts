const relays = new Map<string, () => void>();
export function registerRealtimeRelay(id: string, close: () => void) {
  relays.set(id, close);
  return () => {
    if (relays.get(id) === close) relays.delete(id);
  };
}
export function closeRealtimeRelay(id: string) {
  relays.get(id)?.();
}
export function closeAllRealtimeRelays() {
  for (const close of [...relays.values()]) close();
}
