import { defineConfig } from "vitest/config";

// Separate from vite.config.ts (whose root is web/) so tests/ is discovered.
export default defineConfig({
  test: { root: ".", include: ["tests/**/*.test.ts"], testTimeout: 20_000 },
});
