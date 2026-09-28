import { ApiError, type Backend } from "./backend";
import { MIME, type EngineFormat } from "./export";
import { liveFiles } from "./live-export";
import type { ExportResp, LoadResp, Preset, Rendered, SavedFile } from "./types";

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
    const engine = formats.filter((f): f is EngineFormat => f !== "live");
    const files: SavedFile[] = [];
    if (engine.length) {
      const r = await call<ExportResp>("/api/export", post({ take_id: takeId, settings, formats: engine }));
      files.push(...r.files.map((f) => ({ ...f, url: `${location.origin}/api/exported.${f.format}` })));
    }
    // The Live pair is made in the page from the rendered notes, and downloaded.
    if (!formats.includes("live") || (!settings.tuning_scl && engine.includes("mid"))) return { files };
    const rendered = await call<Rendered>("/api/render", post({ take_id: takeId, settings }));
    const current = await serverBackend.currentTake();
    const stem = (current?.info.name ?? "take").replace(/\.wav$/, "");
    const live = liveFiles(rendered.notes, settings, stem);
    for (const f of live.files) {
      const url = URL.createObjectURL(new Blob([f.bytes], { type: MIME[f.kind] }));
      Object.assign(document.createElement("a"), { href: url, download: f.file_name }).click();
      files.push({ format: f.kind, path: null, file_name: f.file_name, url });
    }
    return { files, note: live.note };
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
