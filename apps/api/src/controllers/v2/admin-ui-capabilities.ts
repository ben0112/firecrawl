import type { Response } from "express";
import type {
  AdminUiCapabilitiesParams,
  AdminUiCapabilitiesResponse,
  RequestWithAuth,
} from "./types";
import { config } from "../../config";

export function adminUiCapabilitiesPayload(
  revision?: string,
  queueBackend: AdminUiCapabilitiesResponse["runtime"]["queueBackend"] = "pg",
): AdminUiCapabilitiesResponse {
  return {
    success: true,
    contractVersion: 1,
    coreRevision: revision || "unknown",
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
  };
}

export async function adminUiCapabilitiesController(
  req: RequestWithAuth<AdminUiCapabilitiesParams, undefined, undefined>,
  res: Response<AdminUiCapabilitiesResponse>,
) {
  const queueBackend =
    config.NUQ_BACKEND === "fdb" ||
    (Boolean(config.FDB_CLUSTER_FILE) && req.acuc?.flags?.nuqFdb === true)
      ? "fdb"
      : "pg";

  return res
    .status(200)
    .json(
      adminUiCapabilitiesPayload(process.env.FIRECRAWL_BUILD_SHA, queueBackend),
    );
}
