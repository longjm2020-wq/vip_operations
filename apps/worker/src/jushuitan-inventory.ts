import { runJushuitanTick } from "../../api/src/modules/inventory/jushuitan.js";

export function startJushuitanInventory() {
  let pending: Promise<void> | undefined;
  const tick = () => {
    if (pending) return;
    pending = runJushuitanTick()
      .catch(() =>
        console.warn(
          "Jushuitan inventory check failed; credentials not logged",
        ),
      )
      .finally(() => {
        pending = undefined;
      });
  };
  const timer = setInterval(tick, 10000);
  timer.unref();
  tick();
  return async () => {
    clearInterval(timer);
    await pending;
  };
}
