import { directorRoles, type DirectorAsset } from "./director.js";

type Role = DirectorAsset["role"];

export const directorRoleNames = {
  product: "商品素材",
  portrait: "授权肖像",
  voiceSample: "授权音色",
  narration: "正式配音",
  reference: "参考片",
  document: "文字资料",
} satisfies Record<Role, string>;

const folders = new Map<string, Role>(
  directorRoles.map((role) => [directorRoleNames[role], role]),
);

export function directorFolderRole(relativeFilePath: string): Role | undefined {
  const names = relativeFilePath.split(/[\\/]/);
  for (let i = names.length - 2; i >= 0; i--) {
    const role = folders.get(names[i]);
    if (role) return role;
  }
}

export function acceptsDirectorFolderRole(role: Role, mime: string) {
  const kind = mime.split("/")[0];
  switch (role) {
    case "product":
      return kind === "image" || kind === "video";
    case "portrait":
      return kind === "image";
    case "voiceSample":
    case "narration":
      return kind === "audio" || kind === "video";
    case "reference":
      return kind === "video";
    case "document":
      return !["image", "video", "audio"].includes(kind);
  }
}
