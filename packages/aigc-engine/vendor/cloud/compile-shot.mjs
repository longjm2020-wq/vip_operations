// A concise Chinese shot can be fully specified in fewer than 40 characters.
// Validate the supplied shot fields together, not an English-sized prompt alone.
function shotText(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!/[\p{L}\p{N}]/u.test(text) || /^(?:n\/?a|none|null|undefined|todo|待补充|待生成|无|略|同上)$/i.test(text)) return "";
  return text;
}

export function compileShotPrompt(unit) {
  const prompt = shotText(unit?.grok_prompt) || shotText(unit?.prompt);
  if (!prompt) return undefined;
  // Keep compatibility with older responses containing a standalone prompt.
  if (Array.from(prompt).length >= 40) return prompt;
  const camera = shotText(unit.camera), action = shotText(unit.action), scene = shotText(unit.scene);
  if (!camera || !action || !scene) return undefined;
  // Assemble only facts in the response. Do not invent a missing action or scene.
  return [`Camera: ${camera.slice(0, 1600)}`, `Action: ${action.slice(0, 1600)}`, `Scene: ${scene.slice(0, 1600)}`, prompt].join("\n");
}
