import { defineConfig } from "vite";

export default defineConfig({
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
});
