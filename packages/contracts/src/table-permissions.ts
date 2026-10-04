// Reused selection controls operate with project permissions inside a table only.
export function tableSelectionPermissions(permissions: string[]): string[] {
  return [
    ...permissions.filter((permission) => !["selection.read", "selection.manage"].includes(permission)),
    ...(permissions.includes("project.read") ? ["selection.read"] : []),
    ...(permissions.includes("project.create") ? ["selection.manage"] : []),
  ];
}
