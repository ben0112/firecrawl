import { describe, expect, it, vi } from "vitest";
import { ConcurrencyReconciliationScheduler } from "./concurrency-reconciliation-scheduler";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const result = {
  teamsScanned: 1,
  teamsWithDrift: 0,
  jobsRequeued: 0,
  jobsStarted: 0,
};

describe("ConcurrencyReconciliationScheduler", () => {
  it("returns immediately and coalesces requests received while a team run is active", async () => {
    const first = deferred<typeof result>();
    const second = deferred<typeof result>();
    const reconcile = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const logger = {
      child: vi.fn().mockReturnThis(),
      error: vi.fn(),
      info: vi.fn(),
    } as any;
    const scheduler = new ConcurrencyReconciliationScheduler(reconcile);

    expect(scheduler.schedule("team-1", logger)).toBeUndefined();
    scheduler.schedule("team-1", logger);
    scheduler.schedule("team-1", logger);

    expect(reconcile).toHaveBeenCalledTimes(1);
    first.resolve(result);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));

    second.resolve(result);
    await scheduler.waitForIdle("team-1");
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it("isolates failures and allows a later request to run", async () => {
    const reconcile = vi
      .fn()
      .mockRejectedValueOnce(new Error("redis unavailable"))
      .mockResolvedValueOnce(result);
    const logger = {
      child: vi.fn().mockReturnThis(),
      error: vi.fn(),
      info: vi.fn(),
    } as any;
    const scheduler = new ConcurrencyReconciliationScheduler(reconcile);

    scheduler.schedule("team-1", logger);
    await scheduler.waitForIdle("team-1");
    expect(logger.error).toHaveBeenCalledWith(
      "Deferred concurrency reconciliation failed",
      expect.objectContaining({ error: expect.any(Error) }),
    );

    scheduler.schedule("team-1", logger);
    await scheduler.waitForIdle("team-1");
    expect(reconcile).toHaveBeenCalledTimes(2);
  });
});
