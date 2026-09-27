import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// `npm run build` makes the local studio (served by `voxmpe studio`);
// `npm run build:web` (mode "web") makes the static site with the engine in the page.
export default defineConfig(({ mode }) =>
  mode === "web"
    ? {
        base: "./",
        publicDir: "public-web",
        // es2022: every browser the site supports (WebAssembly SIMD) has it.
        build: {
          outDir: "web-dist",
          emptyOutDir: true,
          target: "es2022",
          // The studio, and the guided demo at try/.
          rollupOptions: {
            input: {
              main: fileURLToPath(new URL("./index.html", import.meta.url)),
              try: fileURLToPath(new URL("./try/index.html", import.meta.url)),
            },
          },
        },
        worker: { format: "es" },
        resolve: {
          // ./backend-impl from src/, ../backend-impl from src/try/.
          alias: [{ find: /^\.\.?\/backend-impl$/, replacement: fileURLToPath(new URL("./src/wasm-backend.ts", import.meta.url)) }],
        },
      }
    : {
        build: { outDir: "../crates/voxmpe/ui-dist", emptyOutDir: true },
        // `npm run dev` with `voxmpe studio --no-open` running on 7878.
        // The studio server rejects foreign Host/Origin headers, so the dev proxy
        // presents itself as the studio's own origin.
        server: {
          proxy: {
            "/api": {
              target: "http://127.0.0.1:7878",
              changeOrigin: true,
              headers: { origin: "http://127.0.0.1:7878" },
            },
          },
        },
      },
);
