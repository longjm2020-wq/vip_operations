import { sendDailyReport } from "../../api/src/modules/analytics/mail.js";
export function startCompassMail() {
  let busy = false;
  const tick = async () => {
    const hour = Number(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Shanghai",
        hour: "2-digit",
        hourCycle: "h23",
      }).format(new Date()),
    );
    if (busy || hour < 8) return;
    busy = true;
    try {
      await sendDailyReport(true);
    } catch {
      console.warn("Compass mail check failed; no credentials logged");
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 60000);
  timer.unref();
  void tick();
  return async () => {
    clearInterval(timer);
  };
}
