import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, render } from "./api";
import { DEFAULT_SETTINGS } from "./types";

afterEach(() => vi.unstubAllGlobals());

describe("api", () => {
  it("surfaces the server's error message and status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "tuning: bad note count" }), { status: 400 })));
    const e = await render(1, DEFAULT_SETTINGS).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(400);
    expect(e.message).toBe("tuning: bad note count");
  });

  it("surfaces a non-JSON error body as an ApiError with the response status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 502 })));
    const e = await render(1, DEFAULT_SETTINGS).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(502);
  });

  it("sends take_id and settings", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ notes: [], flags: "" })));
    vi.stubGlobal("fetch", f);
    await render(7, DEFAULT_SETTINGS);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/render");
    expect(JSON.parse(init.body as string)).toEqual({ take_id: 7, settings: DEFAULT_SETTINGS });
  });
});
