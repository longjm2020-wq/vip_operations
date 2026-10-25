export function supportedVideoDurations(config, model) {
  const cap = config.maxClipSeconds ?? 120;
  const values = model?.durations ?? Array.from({ length: Math.min(cap, 15) }, (_, i) => i + 1);
  const allowed = [...new Set(values)].filter(d => Number.isInteger(d) && d > 0 && d <= cap).sort((a, b) => b - a);
  if (!allowed.length) throw new Error("当前模型与平台单段时长上限不兼容，请调整设置。");
  return allowed;
}

function targetSeconds(sourceDuration, config) {
  if (!Number.isFinite(sourceDuration) || sourceDuration < 1) throw new Error("参考视频时长无效或不足 1 秒，未提交生成。");
  // Whole-second APIs must never round up and bill beyond the reference.
  const target = Math.floor(sourceDuration + 1e-6);
  const maximum = config.maxVideoSecondsPerProject ?? 180;
  if (target > maximum) throw new Error(`参考视频为 ${target} 秒，超过项目 ${maximum} 秒预算上限。`);
  return target;
}

function durationTable(target, allowed) {
  const counts = Array(target + 1).fill(Infinity);
  counts[0] = 0;
  for (let seconds = 1; seconds <= target; seconds++) {
    for (const duration of allowed) if (duration <= seconds) counts[seconds] = Math.min(counts[seconds], counts[seconds - duration] + 1);
  }
  return counts;
}

function exactParts(target, allowed, counts) {
  if (!Number.isFinite(counts[target])) throw new Error(`当前模型支持 ${[...allowed].reverse().join("、")} 秒，无法恰好覆盖 ${target} 秒原片；请切换模型，不会自动补秒或截短。`);
  const parts = [];
  for (let left = target; left > 0;) {
    // Prefer the longest clip that still leaves an exact, minimum-request tail.
    const duration = allowed.find(d => d <= left && counts[left - d] === counts[left] - 1);
    parts.push(duration);
    left -= duration;
  }
  return parts;
}

function checkSegments(count, config) {
  const maximum = config.maxGenerationSegments ?? 24;
  if (count > maximum) throw new Error(`按所选模型需要 ${count} 段，超过项目 ${maximum} 段上限；未提交生成，请调整项目上限或模型。`);
}

export function planVideoDurations(sourceDuration, config, model) {
  const target = targetSeconds(sourceDuration, config);
  const allowed = supportedVideoDurations(config, model);
  const parts = exactParts(target, allowed, durationTable(target, allowed));
  checkSegments(parts.length, config);
  return parts;
}

// Keep outfit changes separate, then split each shot into supported lengths.
function separatedShotLengths(units, target, counts, config) {
  const total = units.reduce((sum, u) => sum + u.duration_s, 0);
  let states = new Map([[0, { segments: 0, error: 0, lengths: [] }]]);
  for (const unit of units) {
    const next = new Map();
    for (const [used, state] of states) for (let duration = 1; duration <= target - used; duration++) {
      if (!Number.isFinite(counts[duration])) continue;
      const segments = state.segments + counts[duration];
      if (segments > (config.maxGenerationSegments ?? 24)) continue;
      const error = state.error + (duration - unit.duration_s / total * target) ** 2;
      const old = next.get(used + duration);
      if (!old || segments < old.segments || (segments === old.segments && error < old.error)) next.set(used + duration, { segments, error, lengths: [...state.lengths, duration] });
    }
    states = next;
  }
  const result = states.get(target);
  if (!result) throw new Error("当前模型无法在原片总时长与分段上限内分别展示这些商品；请调整分镜或切换模型，不会合并换装或补秒。");
  return result.lengths;
}

export function alignVideoDuration(contract, sourceDuration, config, { allowSingleClip = true, model } = {}) {
  if (sourceDuration == null && !model) return contract;
  const units = contract.units;
  if (!units?.length || units.some(u => !Number.isFinite(u.duration_s) || u.duration_s <= 0)) throw new Error("没有有效的视频时间线。");
  const total = units.reduce((sum, unit) => sum + unit.duration_s, 0);
  const target = targetSeconds(sourceDuration ?? total, config);
  const allowed = supportedVideoDurations(config, model);
  const counts = durationTable(target, allowed);
  const lengths = allowSingleClip ? units.map(u => u.duration_s / total * target) : separatedShotLengths(units, target, counts, config);
  const parts = allowSingleClip ? exactParts(target, allowed, counts) : lengths.flatMap(d => exactParts(d, allowed, counts));
  checkSegments(parts.length, config);
  let elapsed = 0;
  const shots = units.map((unit, i) => {
    const start = elapsed;
    elapsed = i === units.length - 1 ? target : elapsed + lengths[i];
    return { unit, start, end: elapsed };
  });
  elapsed = 0;
  const result = parts.map((duration, index) => {
    const start = elapsed, end = start + duration;
    elapsed = end;
    const included = shots.filter(shot => shot.end > start + 1e-6 && shot.start < end - 1e-6);
    const first = included[0].unit;
    const shotPlan = included.map(shot => ({
      id: shot.unit.id,
      start_s: Number(Math.max(0, shot.start - start).toFixed(3)),
      end_s: Number(Math.min(duration, shot.end - start).toFixed(3)),
      continuation: shot.start < start - 1e-6,
      camera: shot.unit.camera, action: shot.unit.action, scene: shot.unit.scene,
      ...(shot.unit.required_product_views ? { required_product_views: shot.unit.required_product_views } : {}),
      ...(shot.unit.character_ids ? { character_ids: shot.unit.character_ids, product_ids: shot.unit.product_ids } : {}),
    }));
    const schedule = included.map((shot, i) => `[${shotPlan[i].start_s.toFixed(2)}s–${shotPlan[i].end_s.toFixed(2)}s] ${shot.start < start - 1e-6 ? `Continue this action from ${(start - shot.start).toFixed(2)}s into the source shot; do not restart it. ` : i ? "Cut to this shot; do not morph between people or products. " : "Opening shot. "}Camera: ${shot.unit.camera || "as observed"}. Action: ${shot.unit.action || "as observed"}. ${shot.unit.grok_prompt}`);
    const collect = key => [...new Set(included.flatMap(shot => shot.unit[key] || []))];
    return { ...first, id: `S${String(index + 1).padStart(2, "0")}`, duration_s: duration, shot_plan: shotPlan,
      ...(units.some(u => u.character_ids) ? { character_ids: collect("character_ids"), product_ids: collect("product_ids") } : {}),
      camera: included.map(s => s.unit.camera).filter(Boolean).join("\n"),
      action: included.map(s => s.unit.action).filter(Boolean).join("\n"),
      scene: [...new Set(included.map(s => s.unit.scene).filter(Boolean))].join("\n"),
      keyframe_prompt: `Opening frame at ${start}s of the full ${target}s timeline. Preserve the same identity, product, lighting and scene continuity. ${first.keyframe_prompt || first.camera || ""}${included[0].start < start - 1e-6 ? ` Show the action already in progress: ${first.action || ""}` : ""}`,
      grok_prompt: `Generate one ${duration}-second video (segment ${index + 1}/${parts.length}, full timeline ${start}s–${end}s). Follow every shot in this local schedule, including cuts, shot size, camera direction, pose changes and prop actions; one request does not mean one continuous shot. It overrides any durations in the shot descriptions. Do not replace the sequence with generic posing or walking, extend total duration or restart preceding actions. Preserve each separate character identity and product design through cuts.\n${schedule.join("\n")}`,
      negative_constraints: collect("negative_constraints"),
    };
  });
  let start = 0;
  const timeline = result.map(unit => {
    const entry = { id: unit.id, start_s: start, end_s: start + unit.duration_s, duration_s: unit.duration_s, camera: unit.camera, action: unit.action, scene: unit.scene };
    start = entry.end_s;
    return entry;
  });
  return { ...contract, units: result, timeline, source_duration_s: sourceDuration, target_duration_s: target };
}
