import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Property and fuzz tests are CPU-bound; do not let a busy machine turn them into timeouts.
    testTimeout: 120_000,
  },
});
