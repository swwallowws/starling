export interface Settings {
  hold_ms: number;
  jump_hold_ms: number;
  jump_cents: number;
  gap_ms: number;
  split_cents: number;
  /** null = never split on loudness */
  onset_delta: number | null;
  tuning_name: string | null;
  tuning_scl: string | null;
  anchor_hz: number;
  /** null = MPE */
  single_channel: number | null;
  /** 0..1: smooth the pitch curve inside each note */
  smoothing: number;
  /** 0..1: pull scoops and drift onto the scale note */
  correction: number;
  /** 0..1.5: vibrato depth, 1 = as sung */
  vibrato: number;
}

export const DEFAULT_SETTINGS: Settings = {
  hold_ms: 90,
  jump_hold_ms: 90,
  jump_cents: 300,
  gap_ms: 80,
  split_cents: 70,
  onset_delta: 0.6,
  tuning_name: null,
  tuning_scl: null,
  anchor_hz: 261.625565,
  single_channel: null,
  smoothing: 0,
  correction: 0,
  vibrato: 1,
};

export const LEGATO: Partial<Settings> = { hold_ms: 180, gap_ms: 150, onset_delta: null };

export interface TakeInfo {
  name: string;
  duration_s: number;
  hop_s: number;
  contour: (number | null)[];
  loudness: number[];
  warning: string | null;
}

export type Cause = "gap" | "pitch" | "reattack";

export interface RNote {
  pitch: number;
  center: number;
  start: number;
  end: number;
  velocity: number;
  cause: Cause;
  bend: [number, number][];
  amp: [number, number][];
}

export interface Rendered {
  notes: RNote[];
  flags: string;
}

export interface LoadResp {
  take_id: number;
  info: TakeInfo;
  /** True when the analysis came from the browser's cache. */
  cached?: boolean;
}

export interface SavedFile {
  /** The file's kind (its extension): a .mid from either MIDI choice, an .als, or a Live tuning .ascl. */
  format: "mid" | "als" | "ascl";
  /** Where the local studio saved it; null in the browser (it was downloaded). */
  path: string | null;
  file_name: string;
  /** URL the drag handle hands to Chrome's DownloadURL. */
  url: string;
}

export interface ExportResp {
  files: SavedFile[];
  /** What to do with the files, when there is something to say (the Live tuning pair). */
  note?: string;
}

/** A built-in tuning from GET /api/tunings. */
export interface Preset {
  id: string;
  name: string;
  scl: string;
}
