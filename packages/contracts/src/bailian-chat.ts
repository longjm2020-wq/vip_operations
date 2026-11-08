export const bailianChatModel = "deepseek-v4.1-flash-1017";
export type BailianChatStatus = {
  enabled: boolean;
  workspaceId: string;
  model: string;
  endpoint: string;
  apiKeyConfigured: boolean;
  encryptionReady: boolean;
  verifiedAt: string | null;
  errorNote: string;
  version: number;
  reuseAvailable: boolean;
  reuseWorkspaceId: string;
};
