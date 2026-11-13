import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // End-to-end tests spawn the real CLI as a subprocess, a few hundred milliseconds each.
    testTimeout: 30_000,
    include: ["test/**/*.test.ts"],
    // `pnpm test:coverage`. The CLI runs as a subprocess in e2e tests, so src/cli reads as uncovered.
    coverage: { provider: "v8", include: ["src/**"], reporter: ["text-summary", "html"] },
  },
});
