// What the browser studio needs, checked before anything loads.

/** A tiny module using a SIMD instruction (from wasm-feature-detect). */
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

export function missingFeatures(
  env: { WebAssembly?: any; Worker?: unknown; indexedDB?: unknown } = globalThis as any,
): string[] {
  const missing: string[] = [];
  let simd = false;
  try {
    simd = !!env.WebAssembly?.validate(SIMD_PROBE);
  } catch {
    simd = false;
  }
  if (!simd) missing.push("WebAssembly SIMD");
  if (typeof env.Worker !== "function") missing.push("Web Workers");
  if (!env.indexedDB) missing.push("IndexedDB");
  return missing;
}
