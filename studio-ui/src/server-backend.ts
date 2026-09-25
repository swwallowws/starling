import { ApiError, type Backend } from "./backend";
import type { ExportResp, LoadResp, Preset, Rendered } from "./types";

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

/** The local studio: `voxmpe studio` serves this page and runs the engine natively. */
export const serverBackend: Backend = {
  kind: "server",
  canReveal: true,
  canDelete: false,
  canDragOut: true,
  listTakes: () => call<string[]>("/api/takes"),
  openTake: (name) => call<LoadResp>(`/api/load?name=${encodeURIComponent(name)}`, { method: "POST" }),
  uploadTake: (name, wav) =>
    call<LoadResp>(`/api/load?name=${encodeURIComponent(name)}`, { method: "POST", body: wav }),
  deleteTake: async () => {
    throw new ApiError(405, "takes are files in takes/; delete them in Finder");
  },
  render: (takeId, settings) => call<Rendered>("/api/render", post({ take_id: takeId, settings })),
  async exportFiles(takeId, settings, formats) {
    const r = await call<ExportResp>("/api/export", post({ take_id: takeId, settings, formats }));
    return { files: r.files.map((f) => ({ ...f, url: `${location.origin}/api/exported.${f.format}` })) };
  },
  reveal: () => call<void>("/api/reveal", { method: "POST" }),
  /** The take the studio already has open (e.g. `voxmpe studio take.wav`), or null. */
  async currentTake() {
    const res = await fetch("/api/current");
    if (res.status === 204) return null;
    if (!res.ok) throw new ApiError(res.status, res.statusText || "request failed");
    return (await res.json()) as LoadResp;
  },
  listTunings: () => call<Preset[]>("/api/tunings"),
  audioUrl: () => "/api/audio",
};
