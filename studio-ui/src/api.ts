import type { Format } from "./export";
import type { ExportResp, LoadResp, Preset, Rendered, Settings } from "./types";

export const AUDIO_URL = "/api/audio";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    if (!res.ok) throw new ApiError(res.status, res.statusText || "request failed");
    throw new ApiError(res.status, "unexpected response from the studio");
  }
  if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText);
  return body as T;
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const listTakes = () => call<string[]>("/api/takes");
export const openTake = (name: string) =>
  call<LoadResp>(`/api/load?name=${encodeURIComponent(name)}`, { method: "POST" });
export const uploadTake = (name: string, wav: ArrayBuffer) =>
  call<LoadResp>(`/api/load?name=${encodeURIComponent(name)}`, { method: "POST", body: wav });
export const render = (takeId: number, settings: Settings) =>
  call<Rendered>("/api/render", post({ take_id: takeId, settings }));
export const exportFiles = (takeId: number, settings: Settings, formats: Format[]) =>
  call<ExportResp>("/api/export", post({ take_id: takeId, settings, formats }));
export const reveal = () => call<void>("/api/reveal", { method: "POST" });

/** The take the studio already has open (e.g. `voxmpe studio take.wav`), or null. */
export async function currentTake(): Promise<LoadResp | null> {
  const res = await fetch("/api/current");
  if (res.status === 204) return null;
  if (!res.ok) throw new ApiError(res.status, res.statusText || "request failed");
  return (await res.json()) as LoadResp;
}

/** The built-in tunings. */
export const listTunings = () => call<Preset[]>("/api/tunings");
