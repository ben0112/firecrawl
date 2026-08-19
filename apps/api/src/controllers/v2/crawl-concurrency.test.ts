import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCrawl: vi.fn(),
  saveCrawl: vi.fn(),
  getEffectiveConcurrencyLimit: vi.fn(),
  getGroup: vi.fn(),
  schedule: vi.fn(),
}));

vi.mock("../../lib/crawl-redis", () => ({
  getCrawl: mocks.getCrawl,
  saveCrawl: mocks.saveCrawl,
}));
vi.mock("../../lib/concurrency-limit", () => ({
  getEffectiveConcurrencyLimit: mocks.getEffectiveConcurrencyLimit,
}));
vi.mock("../../lib/concurrency-queue-reconciler", () => ({
  reconcileConcurrencyQueue: vi.fn(),
}));
vi.mock("../../lib/concurrency-reconciliation-scheduler", () => ({
  ConcurrencyReconciliationScheduler: class {
    schedule = mocks.schedule;
  },
}));
vi.mock("../../lib/logger", () => ({
  logger: { child: vi.fn().mockReturnThis() },
}));
vi.mock("../../services/worker/nuq-router", () => ({
  crawlGroup: { getGroup: mocks.getGroup },
}));

import { crawlConcurrencyController } from "./crawl-concurrency";

function response() {
  const res = { status: vi.fn(), json: vi.fn() } as any;
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

describe("crawlConcurrencyController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCrawl.mockResolvedValue({
      team_id: "team-1",
      queueBackend: "pg",
      maxConcurrency: 0,
    });
    mocks.getGroup.mockResolvedValue({ status: "active" });
    mocks.getEffectiveConcurrencyLimit.mockResolvedValue(10);
    mocks.saveCrawl.mockResolvedValue(undefined);
  });

  it("acknowledges the persisted limit without waiting for queue reconciliation", async () => {
    const res = response();

    await crawlConcurrencyController(
      {
        params: { jobId: "crawl-1" },
        body: { maxConcurrency: 2 },
        auth: { team_id: "team-1" },
      } as any,
      res,
    );

    expect(mocks.saveCrawl).toHaveBeenCalledWith(
      "crawl-1",
      expect.objectContaining({ maxConcurrency: 2 }),
    );
    expect(mocks.schedule).toHaveBeenCalledWith("team-1", expect.anything());
    expect(mocks.saveCrawl.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.schedule.mock.invocationCallOrder[0],
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      id: "crawl-1",
      previousMaxConcurrency: 0,
      maxConcurrency: 2,
      deploymentMaxConcurrency: 10,
      reconciliation: { status: "scheduled" },
    });
  });
});
