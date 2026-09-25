import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// `npm run build` makes the local studio (served by `voxmpe studio`);
// `npm run build:web` (mode "web") makes the static site with the engine in the page.
export default defineConfig(({ mode }) =>
  mode === "web"
    ? {
        base: "./",
        publicDir: "public-web",
        // es2022: the web backend opens IndexedDB with a top-level await.
        build: { outDir: "web-dist", emptyOutDir: true, target: "es2022" },
        worker: { format: "es" },
        resolve: {
          alias: { "./backend-impl": fileURLToPath(new URL("./src/wasm-backend.ts", import.meta.url)) },
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
