import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        // Exercise compaction and archival with small thresholds and a local R2 bucket.
        r2Buckets: ["SNAPSHOT_ARCHIVE"],
        bindings: { SNAPSHOT_EVERY_OPS: "30", LOG_TAIL_OPS: "10" },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
