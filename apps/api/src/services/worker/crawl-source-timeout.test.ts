import {
  crawlerOptions,
  toV0CrawlerOptions,
  toV2CrawlerOptions,
} from "../../controllers/v2/types";
import { crawlSourceScrapeOptions } from "./crawl-source-timeout";

describe("crawl source scrape timeout", () => {
  it("uses a separate source timeout without mutating normal options", () => {
    const regular = {
      formats: [{ type: "markdown" as const }],
      timeout: 20_000,
    };
    const source = crawlSourceScrapeOptions(regular, {
      initialScrapeTimeout: 45_000,
    });

    expect(source.timeout).toBe(45_000);
    expect(regular.timeout).toBe(20_000);
  });

  it("preserves the regular timeout for legacy crawl options", () => {
    expect(
      crawlSourceScrapeOptions(
        { formats: [{ type: "markdown" }], timeout: 20_000 },
        {},
      ).timeout,
    ).toBe(20_000);
  });

  it("round-trips the option through stored crawler options", () => {
    const parsed = crawlerOptions.parse({ initialScrapeTimeout: 45_000 });
    const stored = toV0CrawlerOptions(parsed);
    expect(stored.initialScrapeTimeout).toBe(45_000);
    expect(toV2CrawlerOptions(stored).initialScrapeTimeout).toBe(45_000);
  });
});
