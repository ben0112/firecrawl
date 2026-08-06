import { getCrawlProgress, hasMoreCrawlResultPages } from "./crawl-progress";

describe("crawl progress", () => {
  it("includes failed jobs in total progress", () => {
    expect(
      getCrawlProgress({
        completed: 8267,
        failed: 427,
        active: 0,
        queued: 0,
        backlog: 0,
      }),
    ).toEqual({ completed: 8267, failed: 427, total: 8694 });
  });

  it("does not paginate into failed jobs after a crawl finishes", () => {
    expect(
      hasMoreCrawlResultPages({
        completed: 8267,
        start: 8200,
        iteratedOver: 67,
        status: "completed",
      }),
    ).toBe(false);
  });

  it("keeps a polling next link while a crawl is still scraping", () => {
    expect(
      hasMoreCrawlResultPages({
        completed: 10,
        start: 10,
        iteratedOver: 0,
        status: "scraping",
      }),
    ).toBe(true);
  });
});
