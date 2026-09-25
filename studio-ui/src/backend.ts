import type { Format } from "./export";
import type { ExportResp, LoadResp, Preset, Rendered, Settings } from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Analysis progress, 0 to 1. */
export type Progress = (fraction: number) => void;

/** Everything the studio page needs from an engine: the local server, or WebAssembly in the page. */
export interface Backend {
  readonly kind: "server" | "web";
  readonly canReveal: boolean;
  readonly canDelete: boolean;
  readonly canDragOut: boolean;
  listTakes(): Promise<string[]>;
  openTake(name: string, onProgress?: Progress): Promise<LoadResp>;
  uploadTake(name: string, wav: ArrayBuffer, onProgress?: Progress): Promise<LoadResp>;
  deleteTake(name: string): Promise<void>;
  render(takeId: number, settings: Settings): Promise<Rendered>;
  exportFiles(takeId: number, settings: Settings, formats: Format[]): Promise<ExportResp>;
  reveal(): Promise<void>;
  currentTake(): Promise<LoadResp | null>;
  listTunings(): Promise<Preset[]>;
  /** URL of the open take's WAV, for playback. */
  audioUrl(): string;
}
