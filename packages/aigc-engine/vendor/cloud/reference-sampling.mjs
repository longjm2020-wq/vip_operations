// About one sample per second for short clips; bounded for longer references.
// Scene suggestions keep their inexpensive five-frame overview.
export function referenceSampleTimes(duration, overview = false) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("无效参考时长");
  const count = overview ? 5 : Math.min(60, Math.max(6, Math.ceil(duration) + 1));
  const margin = Math.min(.05, duration / 10);
  if (overview) return [.06, .25, .47, .69, .91].map(ratio => Math.max(margin, Math.min(duration - margin, duration * ratio)));
  return Array.from({ length: count }, (_, index) => margin + (duration - 2 * margin) * index / (count - 1));
}
