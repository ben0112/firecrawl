import {
  adminUiCapabilitiesController,
  adminUiCapabilitiesPayload,
} from "./admin-ui-capabilities";
import { config } from "../../config";

type QueueBackend = "pg" | "fdb";

const expectedPayload = (queueBackend: QueueBackend) => ({
  success: true,
  contractVersion: 1,
  coreRevision: "test-revision",
  runtime: {
    queueBackend,
  },
  features: {
    dynamicCrawlConcurrency: queueBackend === "pg",
    zeroConcurrencyPause: queueBackend === "pg",
    initialScrapeTimeout: true,
    failedCount: true,
    mapDiscoveryDiagnostics: true,
  },
});

const originalNuqBackend = config.NUQ_BACKEND;
const originalFdbClusterFile = config.FDB_CLUSTER_FILE;

function makeResponse() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  } as any;
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

beforeEach(() => {
  config.NUQ_BACKEND = "pg";
  config.FDB_CLUSTER_FILE = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
  config.NUQ_BACKEND = originalNuqBackend;
  config.FDB_CLUSTER_FILE = originalFdbClusterFile;
});

describe("admin UI capabilities", () => {
  it("builds the exact PostgreSQL capability payload by default", () => {
    expect(adminUiCapabilitiesPayload("test-revision")).toEqual(
      expectedPayload("pg"),
    );
  });

  it("disables unsupported concurrency controls for FoundationDB", () => {
    expect(adminUiCapabilitiesPayload("test-revision", "fdb")).toEqual(
      expectedPayload("fdb"),
    );
  });

  it("reports PostgreSQL for the default authenticated controller", async () => {
    vi.stubEnv("FIRECRAWL_BUILD_SHA", "test-revision");
    const res = makeResponse();

    await adminUiCapabilitiesController(
      { auth: { team_id: "test-team" } } as any,
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expectedPayload("pg"));
  });

  it("reports FoundationDB when it is globally forced", async () => {
    vi.stubEnv("FIRECRAWL_BUILD_SHA", "test-revision");
    config.NUQ_BACKEND = "fdb";
    const res = makeResponse();

    await adminUiCapabilitiesController(
      { auth: { team_id: "test-team" } } as any,
      res,
    );

    expect(res.json).toHaveBeenCalledWith(expectedPayload("fdb"));
  });

  it("reports FoundationDB for a flagged team only when FDB is configured", async () => {
    vi.stubEnv("FIRECRAWL_BUILD_SHA", "test-revision");
    config.FDB_CLUSTER_FILE = "/var/fdb/fdb.cluster";
    const res = makeResponse();

    await adminUiCapabilitiesController(
      {
        auth: { team_id: "test-team" },
        acuc: { flags: { nuqFdb: true } },
      } as any,
      res,
    );

    expect(res.json).toHaveBeenCalledWith(expectedPayload("fdb"));
  });

  it("keeps a flagged team on PostgreSQL when FDB is not configured", async () => {
    vi.stubEnv("FIRECRAWL_BUILD_SHA", "test-revision");
    const res = makeResponse();

    await adminUiCapabilitiesController(
      {
        auth: { team_id: "test-team" },
        acuc: { flags: { nuqFdb: true } },
      } as any,
      res,
    );

    expect(res.json).toHaveBeenCalledWith(expectedPayload("pg"));
  });
});
