import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import request from "supertest";
import { config } from "../config";

const originalNuqBackend = config.NUQ_BACKEND;
const originalFdbClusterFile = config.FDB_CLUSTER_FILE;

vi.mock("./shared", () => ({
  wrap:
    (controller: any) => (req: Request, res: Response, next: NextFunction) =>
      Promise.resolve(controller(req, res)).catch(next),
}));

const expectedPayload = {
  success: true,
  contractVersion: 1,
  coreRevision: "test-revision",
  runtime: {
    queueBackend: "pg",
  },
  features: {
    dynamicCrawlConcurrency: true,
    zeroConcurrencyPause: true,
    initialScrapeTimeout: true,
    failedCount: true,
    mapDiscoveryDiagnostics: true,
  },
};

async function registeredApp() {
  const { registerAdminUiCapabilitiesRoute } = await import(
    "./admin-ui-capabilities.js"
  );
  const app = express();
  const router = express.Router();
  const authenticate: RequestHandler = (req, res, next) => {
    if (req.headers.authorization !== "Bearer owner-key") {
      res.status(401).json({ success: false, error: "Unauthorized" });
      return;
    }
    (req as any).auth = { team_id: "test-team" };
    next();
  };
  registerAdminUiCapabilitiesRoute(router, authenticate);
  app.use("/v2", router);
  return app;
}

beforeEach(() => {
  config.NUQ_BACKEND = "pg";
  config.FDB_CLUSTER_FILE = undefined;
  vi.stubEnv("FIRECRAWL_BUILD_SHA", "test-revision");
});

afterEach(() => {
  vi.unstubAllEnvs();
  config.NUQ_BACKEND = originalNuqBackend;
  config.FDB_CLUSTER_FILE = originalFdbClusterFile;
});

describe("admin UI capabilities route", () => {
  it("rejects unauthenticated requests and serves the exact authenticated contract", async () => {
    const app = await registeredApp();

    const rejected = await request(app).get("/v2/admin-ui-capabilities");
    expect(rejected.status).toBe(401);
    expect(rejected.body).toEqual({
      success: false,
      error: "Unauthorized",
    });

    const accepted = await request(app)
      .get("/v2/admin-ui-capabilities")
      .set("Authorization", "Bearer owner-key");
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual(expectedPayload);
  });

  it("wires the production route through crawl-status authentication", () => {
    const routesSource = readFileSync(resolve(__dirname, "v2.ts"), "utf8");

    expect(routesSource).toMatch(
      /registerAdminUiCapabilitiesRoute\(\s*v2Router,\s*authMiddleware\(RateLimiterMode\.CrawlStatus\),\s*\);/,
    );
  });

  it("requires the source revision in Compose and documents the exact command", () => {
    const repositoryRoot =
      process.env.FIRECRAWL_REPOSITORY_ROOT ??
      resolve(__dirname, "../../../..");
    const composeSource = readFileSync(
      resolve(repositoryRoot, "docker-compose.yaml"),
      "utf8",
    );
    const selfHostSource = readFileSync(
      resolve(repositoryRoot, "SELF_HOST.md"),
      "utf8",
    );

    expect(composeSource).toMatch(
      /build:\s*\n\s+context: apps\/api\s*\n\s+args:\s*\n\s+GIT_SHA: \$\{GIT_SHA:\?[^}]+\}/,
    );
    expect(selfHostSource).toContain(
      'export GIT_SHA="$(git rev-parse HEAD)"\ndocker compose up --build',
    );
    expect(selfHostSource).toMatch(/re-export the\s+same `GIT_SHA`/);
    for (const command of ["ps", "logs", "down"]) {
      expect(selfHostSource).toContain(`docker compose ${command}`);
    }
    expect(selfHostSource).toContain("`GIT_SHA=<full SHA>`");
    expect(selfHostSource).toContain("ignored root `.env`");
    expect(selfHostSource).toContain("until the next rebuild");
  });
});
