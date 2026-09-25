import { describe, expect, it } from "vitest";
import { missingFeatures } from "./support";

describe("missingFeatures", () => {
  it("finds nothing missing where SIMD, workers and IndexedDB exist", () => {
    // Node validates the SIMD probe for real, so this also checks the probe bytes.
    expect(missingFeatures({ WebAssembly, Worker: class {}, indexedDB: {} })).toEqual([]);
  });
  it("names what is missing, in plain words", () => {
    expect(missingFeatures({ WebAssembly: { validate: () => false }, Worker: undefined, indexedDB: undefined })).toEqual([
      "WebAssembly SIMD",
      "Web Workers",
      "IndexedDB",
    ]);
    expect(missingFeatures({})).toContain("WebAssembly SIMD");
  });
});
