import type { IncomingMessage, ServerResponse } from "node:http";
export interface StudioUser {
  id: string;
  username: string;
  displayName: string;
  role: string;
}
export interface StudioPersistence {
  readState(): Promise<any>;
  writeState(data: any, assetsDir: string): Promise<void>;
  hydrate(metadata: any, filePath: string): Promise<void>;
}
export interface Studio {
  store: any;
  config: any;
  worker: any;
  digitalHuman: any;
  start(): void;
  stop(): void;
  syncUsers(users: StudioUser[]): Promise<void>;
  handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    user?: StudioUser,
  ): Promise<void>;
}
export function createStudio(options: {
  config: any;
  persistence: StudioPersistence;
  users?: StudioUser[];
}): Promise<Studio>;
