import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  base: "/admin/",
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../../dist/admin", import.meta.url)),
    emptyOutDir: true,
    // No inline polyfill script, so the strict CSP (script-src 'self') holds.
    modulePreload: { polyfill: false },
    sourcemap: false,
  },
  server: {
    port: 5173,
    // Local development: the Node server runs on PORT 3000 with ADMIN_ENABLED=true.
    // The server rejects writes whose Origin is not its own, so the dev proxy presents the server's origin.
    proxy: {
      "/admin/api": {
        target: "http://localhost:3000",
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            if (proxyReq.getHeader("origin")) proxyReq.setHeader("origin", "http://localhost:3000");
          });
        },
      },
    },
  },
});
