import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // End-to-end tests spawn the real CLI as a subprocess, a few hundred milliseconds each.
    testTimeout: 30_000,
    include: ["test/**/*.test.ts"],
  },
});
