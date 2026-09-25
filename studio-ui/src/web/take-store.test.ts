import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { MODEL_ID, openTakeStore, sanitizeStem } from "./take-store";

const bytes = (n: number) => new Uint8Array([n, n, n]).buffer;

describe("sanitizeStem (same rules as the server)", () => {
  it("keeps letters, digits, - and _, and trims to 60", () => {
    expect(sanitizeStem("my take!")).toBe("my-take");
    expect(sanitizeStem("../../evil.wav")).toBe("evil");
    expect(sanitizeStem("a  b..c")).toBe("a-b-c");
    expect(sanitizeStem("!!!")).toBe("take");
    expect(sanitizeStem("x".repeat(80))).toHaveLength(60);
  });
});

describe("take store", () => {
  it("names are sanitized and never overwrite", async () => {
    const s = await openTakeStore(new IDBFactory());
    expect(await s.add("my take!", bytes(1))).toBe("my-take.wav");
    expect(await s.add("my take!", bytes(2))).toBe("my-take-2.wav");
    expect(await s.list()).toEqual(["my-take-2.wav", "my-take.wav"]);
    expect(new Uint8Array((await s.get("my-take.wav"))!.wav)[0]).toBe(1);
  });

  it("caches the analysis and forgets it with the take", async () => {
    const s = await openTakeStore(new IDBFactory());
    const name = await s.add("a", bytes(1));
    expect((await s.get(name))!.frames).toBeNull();
    await s.setFrames(name, new Float32Array([0.01, 1, 2]));
    expect(Array.from((await s.get(name))!.frames!)).toEqual([0.01, 1, 2].map(Math.fround));
    await s.remove(name);
    expect(await s.get(name)).toBeNull();
    expect(await s.list()).toEqual([]);
  });

  it("frames from another model are ignored", async () => {
    const factory = new IDBFactory();
    const s = await openTakeStore(factory);
    const name = await s.add("a", bytes(1));
    // Write a record as an older build with another model would have.
    await new Promise<void>((done) => {
      const open = factory.open("voxmpe");
      open.onsuccess = () => {
        const tx = open.result.transaction("takes", "readwrite");
        const store = tx.objectStore("takes");
        const get = store.get(name);
        get.onsuccess = () => store.put({ ...get.result, frames: new Float32Array([1]), model: "crepe-full" });
        tx.oncomplete = () => done();
      };
    });
    expect(MODEL_ID).toBe("crepe-tiny");
    expect((await s.get(name))!.frames).toBeNull();
  });

  it("persists across opens", async () => {
    const factory = new IDBFactory();
    await (await openTakeStore(factory)).add("kept", bytes(3));
    expect(await (await openTakeStore(factory)).list()).toEqual(["kept.wav"]);
  });
});
