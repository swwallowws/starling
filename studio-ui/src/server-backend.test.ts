// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./backend";
import { serverBackend as api } from "./server-backend";
import { DEFAULT_SETTINGS } from "./types";

afterEach(() => vi.unstubAllGlobals());

describe("server backend", () => {
  it("surfaces the server's error message and status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "tuning: bad note count" }), { status: 400 })));
    const e = await api.render(1, DEFAULT_SETTINGS).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(400);
    expect(e.message).toBe("tuning: bad note count");
  });

  it("surfaces a non-JSON error body as an ApiError with the response status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 502 })));
    const e = await api.render(1, DEFAULT_SETTINGS).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(502);
  });

  it("sends take_id and settings", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ notes: [], flags: "" })));
    vi.stubGlobal("fetch", f);
    await api.render(7, DEFAULT_SETTINGS);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/render");
    expect(JSON.parse(init.body as string)).toEqual({ take_id: 7, settings: DEFAULT_SETTINGS });
  });
  it("reports no current take on 204", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    expect(await api.currentTake()).toBeNull();
  });

  it("returns the current take when one is open", async () => {
    const body = { take_id: 3, info: { name: "a.wav" } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
    expect(await api.currentTake()).toEqual(body);
  });
  it("lists the built-in tunings", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify([{ id: "53-edo", name: "Turkish makam", scl: "x" }])));
    vi.stubGlobal("fetch", f);
    expect((await api.listTunings())[0].id).toBe("53-edo");
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("/api/tunings");
  });

  it("gives each exported file a URL the drag handle can use", async () => {
    const body = { files: [{ format: "als", path: "/t/a_studio.als", file_name: "a_studio.als" }] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
    const r = await api.exportFiles(1, DEFAULT_SETTINGS, ["als"]);
    expect(r.files[0].url).toBe(`${location.origin}/api/exported.als`);
    expect(r.files[0].path).toBe("/t/a_studio.als");
  });
  it("declares what only the local studio can do", () => {
    expect(api.kind).toBe("server");
    expect([api.canReveal, api.canDelete, api.canDragOut]).toEqual([true, false, true]);
  });
});
