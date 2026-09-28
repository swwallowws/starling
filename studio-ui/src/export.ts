import type { Settings } from "./types";

/** What Save can write: MIDI for any MPE synth, MIDI + tuning for Live 12, a Live set. */
export type Format = "mid" | "live" | "als";
/** Every export format, in the order Save writes and shows them. */
export const FORMATS: Format[] = ["mid", "live", "als"];
/** The formats the engine writes itself; "live" is made in the page. */
export type EngineFormat = "mid" | "als";
/** A saved file's kind: its extension. */
export type FileKind = "mid" | "als" | "ascl";
export const MIME: Record<FileKind, string> = { mid: "audio/midi", als: "application/octet-stream", ascl: "text/plain" };
const KEY = "voxmpe.formats";

/** Chrome's DownloadURL value for dragging `url` out as `fileName`. */
export const downloadUrlData = (f: FileKind, fileName: string, url: string) => `${MIME[f]}:${fileName}:${url}`;
export const settingsKey = (s: Settings) => JSON.stringify(s);

/** The formats after ticking (`on`) or unticking `f`; the last one can't be unticked. */
export function nextFormats(current: Format[], f: Format, on: boolean): Format[] {
  const next = FORMATS.filter((x) => (x === f ? on : current.includes(x)));
  return next.length ? next : current;
}

/** The remembered choice, or just .mid when there is none or it can't be read. */
export function loadFormats(storage: Storage): Format[] {
  try {
    const v: unknown = JSON.parse(storage.getItem(KEY) ?? "null");
    if (Array.isArray(v) && v.length && v.every((x) => FORMATS.includes(x))) return FORMATS.filter((f) => v.includes(f));
  } catch {
    // unreadable storage or junk: fall through to the default
  }
  return ["mid"];
}

export function saveFormats(storage: Storage, formats: Format[]) {
  try {
    storage.setItem(KEY, JSON.stringify(formats));
  } catch {
    // private window or blocked storage: the choice just isn't remembered
  }
}
