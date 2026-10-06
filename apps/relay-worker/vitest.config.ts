import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        // Exercise compaction and archival with small thresholds and a local R2 bucket.
        r2Buckets: ["SNAPSHOT_ARCHIVE"],
        bindings: {
          SNAPSHOT_EVERY_OPS: "30",
          LOG_TAIL_OPS: "10",
          // Small limits so the guards can be exercised quickly.
          MAX_DOC_ELEMENTS: "1000",
          RATE_BURST: "400",
          RATE_PER_SECOND: "400",
          DOC_TTL_SECONDS: "3600",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    // Some tests wait in real time for the rate limiter to refill.
    testTimeout: 30_000,
  },
});
