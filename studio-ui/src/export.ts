import type { Settings } from "./types";

export type Format = "mid" | "als";
/** Every export format, in the order Save writes and shows them. */
export const FORMATS: Format[] = ["mid", "als"];
const MIME: Record<Format, string> = { mid: "audio/midi", als: "application/octet-stream" };
const KEY = "voxmpe.formats";

export const exportedUrl = (f: Format) => `/api/exported.${f}`;
export const downloadUrlData = (f: Format, fileName: string, origin: string) =>
  `${MIME[f]}:${fileName}:${origin}${exportedUrl(f)}`;
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
