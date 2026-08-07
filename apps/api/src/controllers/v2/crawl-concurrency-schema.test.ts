import { describe, expect, it } from "vitest";
import {
  batchScrapeRequestSchema,
  batchScrapeRequestSchemaNoURLValidation,
  crawlRequestSchema,
} from "./types";

describe("paused crawl concurrency", () => {
  it("accepts maxConcurrency zero so a persisted task can wait in backlog", () => {
    expect(
      crawlRequestSchema.parse({
        url: "https://example.com",
        maxConcurrency: 0,
      }).maxConcurrency,
    ).toBe(0);
    expect(
      batchScrapeRequestSchema.parse({
        urls: ["https://example.com"],
        maxConcurrency: 0,
      }).maxConcurrency,
    ).toBe(0);
    expect(
      batchScrapeRequestSchemaNoURLValidation.parse({
        urls: ["not-yet-validated"],
        maxConcurrency: 0,
      }).maxConcurrency,
    ).toBe(0);
  });

  it("still rejects negative concurrency", () => {
    expect(() =>
      crawlRequestSchema.parse({
        url: "https://example.com",
        maxConcurrency: -1,
      }),
    ).toThrow();
  });
});
