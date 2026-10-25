export type VideoRoleProfile = {mode: "first-frame" | "references"; syntax: string; nativeSubjects: boolean; label: string; detail: string};
export function videoRoleProfile(model?: {id?: string; inputMode?: string}): VideoRoleProfile;
