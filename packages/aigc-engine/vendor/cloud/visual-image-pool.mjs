// One pool per worker, shared by all scans. Parallelize image decoding without
// allowing each of ten jobs to launch an unbounded group of sharp operations.
export function createVisualImagePool(concurrency = 2) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) throw new Error("Invalid visual image concurrency");
  const waiting = [];
  let active = 0;
  const drain = () => {
    while (active < concurrency && waiting.length) {
      const { run, resolve, reject } = waiting.shift();
      active++;
      Promise.resolve().then(run).then(resolve, reject).finally(() => { active--; drain(); });
    }
  };
  return run => new Promise((resolve, reject) => { waiting.push({ run, resolve, reject }); drain(); });
}
