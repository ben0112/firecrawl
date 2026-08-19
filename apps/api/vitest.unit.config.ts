import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // These suites intentionally require a running API, third-party sites,
      // or the snips harness. Keep `test:full` deterministic and run them via
      // `test:integration` / `test:snips` in their provisioned environments.
      exclude: [
        "**/__tests__/e2e*/**",
        "**/__tests__/snips/v0/**",
        "**/__tests__/snips/v1/**",
        "**/__tests__/snips/v2/**",
        "src/scraper/scrapeURL/scrapeURL.test.ts",
      ],
    },
  }),
);
