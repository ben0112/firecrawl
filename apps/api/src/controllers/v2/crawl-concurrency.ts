import { Response } from "express";
import { getCrawl, saveCrawl } from "../../lib/crawl-redis";
import { getEffectiveConcurrencyLimit } from "../../lib/concurrency-limit";
import { reconcileConcurrencyQueue } from "../../lib/concurrency-queue-reconciler";
import { logger as _logger } from "../../lib/logger";
import { crawlGroup } from "../../services/worker/nuq-router";
import { RequestWithAuth } from "./types";

/**
 * Adjusts a running crawl/batch concurrency gate. A value of zero pauses new
 * page jobs while preserving the crawl and its backlog. Existing page jobs are
 * allowed to finish; raising the value immediately drains eligible backlog.
 */
export async function crawlConcurrencyController(
  req: RequestWithAuth<
    { jobId: string },
    undefined,
    { maxConcurrency?: number }
  >,
  res: Response,
) {
  const requested = Number(req.body?.maxConcurrency);
  if (!Number.isSafeInteger(requested) || requested < 0) {
    return res.status(400).json({
      success: false,
      error: "maxConcurrency must be a non-negative integer",
    });
  }

  const crawl = await getCrawl(req.params.jobId);
  if (!crawl || crawl.team_id !== req.auth.team_id) {
    return res.status(404).json({ success: false, error: "Job not found" });
  }
  const group = await crawlGroup.getGroup(req.params.jobId);
  if (!group || group.status !== "active") {
    return res.status(409).json({
      success: false,
      error:
        group?.status === "completed"
          ? "Job is already completed"
          : "Job is not active",
    });
  }
  if (crawl.queueBackend === "fdb") {
    return res.status(409).json({
      success: false,
      error:
        "Dynamic crawl concurrency is not available for the FDB queue backend",
    });
  }

  const maximum = await getEffectiveConcurrencyLimit(
    req.auth.team_id,
    req.acuc?.org_id ?? null,
  );
  if (requested > maximum) {
    return res.status(400).json({
      success: false,
      error: `maxConcurrency cannot exceed ${maximum}`,
      maxConcurrency: maximum,
    });
  }

  const previous = crawl.maxConcurrency;
  crawl.maxConcurrency = requested;
  await saveCrawl(req.params.jobId, crawl);
  const reconciliation = await reconcileConcurrencyQueue({
    teamId: req.auth.team_id,
    logger: _logger.child({
      module: "api/v2/crawl-concurrency",
      crawlId: req.params.jobId,
    }),
  });

  return res.status(200).json({
    success: true,
    id: req.params.jobId,
    previousMaxConcurrency: previous ?? null,
    maxConcurrency: requested,
    deploymentMaxConcurrency: maximum,
    reconciliation,
  });
}
