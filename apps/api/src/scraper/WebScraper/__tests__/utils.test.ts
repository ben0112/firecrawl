import { WebCrawler } from "../crawler";

describe("WebCrawler - section link filtering", () => {
  let crawler: WebCrawler;

  beforeEach(() => {
    crawler = new WebCrawler({
      jobId: "test-job",
      initialUrl: "https://example.com",
      baseUrl: "https://example.com",
      includes: [],
      excludes: [],
    });
  });

  async function expectAllowed(url: string, allowed: boolean) {
    const result = await crawler.filterURL(url, "https://example.com/page");
    expect(result.allowed).toBe(allowed);
  }

  it("allows URLs without hash fragments", async () => {
    await expectAllowed("https://example.com/page", true);
    await expectAllowed("https://example.com/blog/post", true);
    await expectAllowed("https://example.com", true);
  });

  it("rejects simple anchor links", async () => {
    await expectAllowed("https://example.com/page#section", false);
    await expectAllowed("https://example.com/page#top", false);
    await expectAllowed("https://example.com/page#", false);
    await expectAllowed("https://example.com/page#a", false);
  });

  it("allows hash fragments that look like routes", async () => {
    await expectAllowed("https://example.com/app#/dashboard", true);
    await expectAllowed("https://example.com/spa#/user/profile", true);
    await expectAllowed("https://example.com/page#/settings/account", true);
  });

  it("rejects short hash fragments even with slashes", async () => {
    await expectAllowed("https://example.com/page#/", false);
  });

  it("handles edge cases", async () => {
    await expectAllowed("https://example.com/page#ab", false);
    await expectAllowed("https://example.com/page#abc/def", true);
  });
});
