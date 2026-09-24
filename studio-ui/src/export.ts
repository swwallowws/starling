import { EXPORTED_URL } from "./api";
import type { Settings } from "./types";

export const downloadUrlData = (fileName: string, origin: string) => `audio/midi:${fileName}:${origin}${EXPORTED_URL}`;
export const settingsKey = (s: Settings) => JSON.stringify(s);
