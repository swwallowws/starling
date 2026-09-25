import { describe, expect, it } from "vitest";
import { lazy } from "./lazy";

interface Adder {
  add(x: number): Promise<number>;
}

describe("lazy", () => {
  it("makes the object on first use, then reuses it", async () => {
    let made = 0;
    const o = lazy<Adder>(async () => {
      made++;
      return { add: async (x) => x + 1 };
    });
    expect(made).toBe(0);
    expect(await o.add(1)).toBe(2);
    expect(await o.add(2)).toBe(3);
    expect(made).toBe(1);
  });

  it("a failed make rejects that call and is tried again on the next", async () => {
    let tries = 0;
    const o = lazy<Adder>(async () => {
      if (++tries === 1) throw new Error("indexedDB is not defined");
      return { add: async (x) => x * 10 };
    });
    await expect(o.add(1)).rejects.toThrow("indexedDB is not defined");
    expect(await o.add(2)).toBe(20);
  });
});
