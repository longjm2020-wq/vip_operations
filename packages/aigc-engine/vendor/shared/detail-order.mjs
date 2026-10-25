// Move by stable IDs so hidden modules keep their content and relative order.
export function moveDetailModule(modules, sourceId, targetId, placement = "before") {
  if (sourceId === targetId || !["before", "after"].includes(placement)) return modules;
  const source = modules.findIndex(module => module.id === sourceId);
  const target = modules.findIndex(module => module.id === targetId);
  if (source < 0 || target < 0) return modules;
  const next = [...modules];
  const [item] = next.splice(source, 1);
  const position = next.findIndex(module => module.id === targetId) + (placement === "after" ? 1 : 0);
  next.splice(position, 0, item);
  return next.every((module, index) => module === modules[index]) ? modules : next;
}
