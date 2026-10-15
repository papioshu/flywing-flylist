import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  envDir: "..",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    strictPort: true,
    // Phone testing over an HTTPS tunnel (npm run dev:tunnel): accept the tunnel's host and send the
    // API through the same origin, since the phone cannot reach this machine's localhost:8787.
    allowedHosts: [".trycloudflare.com"],
    proxy: { "/allowlist": "http://localhost:8787" },
  },
});
