import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  adminUiCapabilitiesController,
  adminUiCapabilitiesPayload,
} from "./admin-ui-capabilities";

const expectedPayload = {
  success: true,
  contractVersion: 1,
  coreRevision: "test-revision",
  features: {
    dynamicCrawlConcurrency: true,
    zeroConcurrencyPause: true,
    initialScrapeTimeout: true,
    failedCount: true,
    mapDiscoveryDiagnostics: true,
  },
};

function makeResponse() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  } as any;
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("admin UI capabilities", () => {
  it("builds the exact versioned capability payload", () => {
    expect(adminUiCapabilitiesPayload("test-revision")).toEqual(
      expectedPayload,
    );
  });

  it("returns the build revision from the authenticated controller", async () => {
    vi.stubEnv("FIRECRAWL_BUILD_SHA", "test-revision");
    const res = makeResponse();

    await adminUiCapabilitiesController(
      { auth: { team_id: "test-team" } } as any,
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expectedPayload);
  });

  it("registers the endpoint behind crawl-status authentication", () => {
    const routesSource = readFileSync(
      resolve(__dirname, "../../routes/v2.ts"),
      "utf8",
    );
    const registration = routesSource.match(
      /v2Router\.get\(\s*"\/admin-ui-capabilities",[\s\S]*?^\);/m,
    )?.[0];

    expect(registration).toBeDefined();
    expect(registration).toContain(
      "authMiddleware(RateLimiterMode.CrawlStatus)",
    );
    expect(registration).toContain("wrap(adminUiCapabilitiesController)");
    expect(registration!.indexOf("authMiddleware")).toBeLessThan(
      registration!.indexOf("wrap(adminUiCapabilitiesController)"),
    );
  });
});
