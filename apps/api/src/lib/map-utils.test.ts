const mocks = vi.hoisted(() => ({
  getRobotsTxt: vi.fn(),
  importRobotsTxt: vi.fn(),
  tryGetSitemap: vi.fn(),
  queryIndexAtDomainSplitLevelWithMeta: vi.fn(),
  queryIndexAtSplitLevelWithMeta: vi.fn(),
  fireEngineMap: vi.fn(),
  searxngSearch: vi.fn(),
  scrapeURL: vi.fn(),
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("../controllers/v2/types", () => ({
  MAX_MAP_LIMIT: 100000,
  scrapeOptions: { parse: (value: unknown) => value },
}));
vi.mock("./crawl-redis", () => ({
  crawlToCrawler: () => ({
    getRobotsTxt: mocks.getRobotsTxt,
    importRobotsTxt: mocks.importRobotsTxt,
    tryGetSitemap: mocks.tryGetSitemap,
  }),
}));
vi.mock("./zdr-helpers", () => ({ getScrapeZDR: () => false }));
vi.mock("./validateUrl", () => ({
  checkAndUpdateURLForMap: (url: string) => ({ url }),
  isSameDomain: (left: string, right: string) =>
    new URL(left).hostname === new URL(right).hostname,
  isSameSubdomain: (left: string, right: string) =>
    new URL(left).hostname === new URL(right).hostname,
  resolveRedirects: (url: string) => Promise.resolve(url),
}));
vi.mock("../search/fireEngine", () => ({
  fireEngineMap: mocks.fireEngineMap,
}));
vi.mock("../services/redis", () => ({
  redisEvictConnection: {
    get: mocks.redisGet,
    set: mocks.redisSet,
  },
}));
vi.mock("../services/index", () => ({
  generateURLSplits: () => ["domain"],
  queryIndexAtDomainSplitLevelWithMeta:
    mocks.queryIndexAtDomainSplitLevelWithMeta,
  queryIndexAtSplitLevelWithMeta: mocks.queryIndexAtSplitLevelWithMeta,
}));
vi.mock("./map-cosine", () => ({
  performCosineSimilarityV2: (documents: unknown[]) => documents,
}));
vi.mock("../config", () => ({
  config: { SEARXNG_ENDPOINT: "https://search.example.com" },
}));
vi.mock("../search/searxng", () => ({
  searxng_search: mocks.searxngSearch,
}));
vi.mock("../scraper/scrapeURL", () => ({ scrapeURL: mocks.scrapeURL }));
vi.mock("./logger", () => ({
  logger: {
    child: () => ({ info: mocks.loggerInfo, warn: mocks.loggerWarn }),
  },
}));

import { getMapResults, shouldUseMapFallback } from "./map-utils";

describe("self-hosted map fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRobotsTxt.mockResolvedValue("");
    mocks.tryGetSitemap.mockResolvedValue(0);
    mocks.queryIndexAtDomainSplitLevelWithMeta.mockResolvedValue([]);
    mocks.queryIndexAtSplitLevelWithMeta.mockResolvedValue([]);
    mocks.fireEngineMap.mockResolvedValue([]);
    mocks.redisGet.mockResolvedValue(null);
    mocks.redisSet.mockResolvedValue("OK");
    mocks.searxngSearch.mockResolvedValue([]);
    mocks.scrapeURL.mockResolvedValue({
      success: true,
      document: {
        metadata: { url: "https://example.com/" },
        links: [],
      },
    });
  });

  it("uses homepage and SearXNG when regular discovery is empty", async () => {
    mocks.scrapeURL.mockResolvedValue({
      success: true,
      document: {
        metadata: { url: "https://example.com/" },
        links: [
          "https://example.com/about",
          "https://example.com/about",
          "https://outside.example.net/page",
        ],
      },
    });
    mocks.searxngSearch.mockResolvedValue([
      {
        url: "https://example.com/about",
        title: "About",
        description: "About page",
      },
      {
        url: "https://example.com/news",
        title: "News",
        description: "News page",
      },
    ]);

    const result = await getMapResults({
      url: "https://example.com",
      limit: 500,
      includeSubdomains: true,
      crawlerOptions: { sitemap: "include" },
      teamId: "test-team",
      orgId: null,
      flags: null,
    });

    expect(result.mapResults.map(item => item.url)).toEqual([
      "https://example.com/about",
      "https://example.com/news",
      "https://example.com/",
    ]);
    expect(result.discovery).toEqual({
      fallbackAttempted: true,
      fallbackUsed: true,
      sources: {
        index: 0,
        fireEngine: 0,
        sitemap: 0,
        homepage: 4,
        searxng: 2,
      },
    });
    expect(mocks.searxngSearch).toHaveBeenCalledWith(
      "site:example.com",
      expect.objectContaining({ num_results: 20 }),
    );
  });

  it("does not run fallback after regular discovery reaches the threshold", async () => {
    mocks.queryIndexAtDomainSplitLevelWithMeta.mockResolvedValue(
      Array.from({ length: 10 }, (_, index) => ({
        url: `https://example.com/page-${index}`,
      })),
    );

    const result = await getMapResults({
      url: "https://example.com",
      limit: 500,
      includeSubdomains: true,
      crawlerOptions: { sitemap: "include" },
      teamId: "test-team",
      orgId: null,
      flags: null,
    });

    expect(result.mapResults).toHaveLength(10);
    expect(result.discovery.fallbackAttempted).toBe(false);
    expect(mocks.scrapeURL).not.toHaveBeenCalled();
    expect(mocks.searxngSearch).not.toHaveBeenCalled();
  });

  it("applies the limit after invalid and duplicate fallback URLs are removed", async () => {
    mocks.scrapeURL.mockResolvedValue({
      success: true,
      document: {
        metadata: { url: "https://example.com/" },
        links: [
          "https://outside.example.net/page",
          "https://example.com/about",
          "https://example.com/about",
          "https://example.com/news",
        ],
      },
    });

    const result = await getMapResults({
      url: "https://example.com",
      limit: 2,
      includeSubdomains: true,
      crawlerOptions: { sitemap: "skip" },
      teamId: "test-team",
      orgId: null,
      flags: null,
    });

    expect(result.mapResults.map(item => item.url)).toEqual([
      "https://example.com/",
      "https://example.com/about",
    ]);
  });

  it("uses a small-result threshold without exceeding the requested limit", () => {
    expect(shouldUseMapFallback(0, 500)).toBe(true);
    expect(shouldUseMapFallback(9, 500)).toBe(true);
    expect(shouldUseMapFallback(10, 500)).toBe(false);
    expect(shouldUseMapFallback(1, 1)).toBe(false);
  });
});
