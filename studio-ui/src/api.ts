import type { ExportResp, LoadResp, Rendered, Settings } from "./types";

export const AUDIO_URL = "/api/audio";
export const EXPORTED_URL = "/api/exported.mid";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
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
export const exportMid = (takeId: number, settings: Settings) =>
  call<ExportResp>("/api/export", post({ take_id: takeId, settings }));
export const reveal = () => call<void>("/api/reveal", { method: "POST" });
