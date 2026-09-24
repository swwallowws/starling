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
}

export interface ExportResp {
  path: string;
  file_name: string;
}
