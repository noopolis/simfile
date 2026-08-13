import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: new URL(".", import.meta.url).pathname,
  build: {
    outDir: "dist",
    emptyOutDir: true
  },
  // Dev-only: `vite --config web/vite.config.ts` serves the viewer with hot
  // reload while a `simfile view <run-dir>` process supplies the real data,
  // so presentation can be iterated against a real record in seconds.
  // Unused by `build:web`; VIEWER_ORIGIN overrides the default port.
  server: {
    proxy: Object.fromEntries(
      ["/api", "/_simfile"].map((route) => [
        route,
        { target: process.env.VIEWER_ORIGIN ?? "http://127.0.0.1:4400", changeOrigin: true }
      ])
    )
  }
});
