export type VideoModel = {
  id: string;
  label: string;
  model: string;
  legacy?: boolean;
  keyEnv?: string;
  durations: number[];
  durationsByResolution?: Record<string, number[]>;
  aspects: string[];
  maxImages: number;
  resolutions: string[];
  inputMode?: string;
  minImageSide?: number;
};
export type VideoProvider = {
  id: string;
  label: string;
  protocol: string;
  baseUrl: string;
  keyEnv: string;
  models: VideoModel[];
};
export type VideoRoute = Omit<VideoProvider, "models"> & {
  model: VideoModel;
  resolution: string;
};
export type VideoInput = {
  prompt: string;
  duration: number;
  aspectRatio: string;
  referenceImages: string[];
};
export function videoProviders(config: unknown): VideoProvider[];
export function videoKey(config: unknown, route: unknown): string | undefined;
export function selectVideoRoute(
  config: unknown,
  selection: { providerId: string; modelId: string; resolution?: string },
): VideoRoute;
export function validateVideoInput(route: VideoRoute, input: VideoInput): void;
export function preflightXhaiVideo(
  config: unknown,
  route: VideoRoute,
  input: VideoInput,
): Promise<unknown>;
export function submitVideo(
  config: unknown,
  route: VideoRoute,
  input: VideoInput,
  preflight?: unknown,
): Promise<string>;
export class XhaiVideoAdjustmentError extends Error {
  taskId: string;
  constructor(taskId: string, message: string);
}
export function pollVideo(
  config: unknown,
  route: VideoRoute,
  id: string,
): Promise<{ pending: boolean; url?: string; state: string }>;
export function uploadXhaiImages(
  baseUrl: string,
  apiKey: string,
  sources: string[],
): Promise<string[]>;
export function withJobSignal<T>(
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T>;
