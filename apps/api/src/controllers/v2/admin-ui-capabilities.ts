import type { Response } from "express";
import type {
  AdminUiCapabilitiesParams,
  AdminUiCapabilitiesResponse,
  RequestWithAuth,
} from "./types";

export function adminUiCapabilitiesPayload(
  revision?: string,
): AdminUiCapabilitiesResponse {
  return {
    success: true,
    contractVersion: 1,
    coreRevision: revision || "unknown",
    features: {
      dynamicCrawlConcurrency: true,
      zeroConcurrencyPause: true,
      initialScrapeTimeout: true,
      failedCount: true,
      mapDiscoveryDiagnostics: true,
    },
  };
}

export async function adminUiCapabilitiesController(
  _req: RequestWithAuth<AdminUiCapabilitiesParams, undefined, undefined>,
  res: Response<AdminUiCapabilitiesResponse>,
) {
  return res
    .status(200)
    .json(adminUiCapabilitiesPayload(process.env.FIRECRAWL_BUILD_SHA));
}
