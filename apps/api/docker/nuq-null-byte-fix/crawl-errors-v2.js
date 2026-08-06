"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.crawlErrorsController = crawlErrorsController;
const config_1 = require("../../config");
const crawl_redis_1 = require("../../lib/crawl-redis");
const redis_1 = require("../../../src/services/redis");
const dotenv_1 = require("dotenv");
const drizzle_orm_1 = require("drizzle-orm");
const connection_1 = require("../../db/connection");
const schema = __importStar(require("../../db/schema"));
const logger_1 = require("../../lib/logger");
const error_serde_1 = require("../../lib/error-serde");
const nuq_router_1 = require("../../services/worker/nuq-router");
(0, dotenv_1.configDotenv)();
const UNRECORDED_FAILURE = 'SCRAPE_TIMEOUT|{"message":"The scrape job failed without recording a reason. The worker may have stalled or been interrupted."}';
async function crawlErrorsController(req, res) {
    const sc = await (0, crawl_redis_1.getCrawl)(req.params.jobId);
    if (sc) {
        if (sc.team_id !== req.auth.team_id) {
            return res.status(403).json({ success: false, error: "Forbidden" });
        }
        const logger = logger_1.logger.child({
            crawlId: req.params.jobId,
            zeroDataRetention: sc.zeroDataRetention ?? false,
        });
        const failedJobs = await nuq_router_1.scrapeQueue.getJobsWithStatus(await (0, crawl_redis_1.getCrawlJobs)(req.params.jobId), "failed", logger);
        res.status(200).json({
            errors: failedJobs
                .map(x => {
                if (x.data.mode !== "single_urls") {
                    return null;
                }
                const failedReason = x.failedReason ?? UNRECORDED_FAILURE;
                const error = (0, error_serde_1.deserializeTransportableError)(failedReason);
                if (error?.code === "SCRAPE_RACED_REDIRECT_ERROR") {
                    return null;
                }
                return {
                    id: x.id,
                    timestamp: x.finishedAt !== undefined
                        ? new Date(x.finishedAt).toISOString()
                        : undefined,
                    url: x.data.url,
                    ...(error
                        ? {
                            code: error.code,
                            error: error.message,
                        }
                        : {
                            error: failedReason,
                        }),
                };
            })
                .filter(x => x !== null),
            robotsBlocked: await redis_1.redisEvictConnection.smembers("crawl:" + req.params.jobId + ":robots_blocked"),
        });
    }
    else if (config_1.config.USE_DB_AUTHENTICATION) {
        // Check the requests table for the crawl/batch scrape request
        let request;
        try {
            request = await connection_1.dbRr
                .select()
                .from(schema.requests)
                .where((0, drizzle_orm_1.eq)(schema.requests.id, req.params.jobId))
                .limit(1);
        }
        catch (requestError) {
            logger_1.logger.error("Error getting request", { error: requestError });
            throw requestError;
        }
        const requestData = request?.[0];
        if (requestData && requestData.team_id !== req.auth.team_id) {
            return res.status(403).json({ success: false, error: "Forbidden" });
        }
        const crawlTtlHours = req.acuc?.flags?.crawlTtlHours ?? 24;
        const crawlTtlMs = crawlTtlHours * 60 * 60 * 1000;
        if (requestData &&
            new Date().valueOf() - new Date(requestData.created_at).valueOf() >
                crawlTtlMs) {
            return res.status(404).json({ success: false, error: "Job expired" });
        }
        if (!request || request.length === 0) {
            return res.status(404).json({ success: false, error: "Job not found" });
        }
        // Get failed scrapes from the scrapes table
        let failedScrapes;
        try {
            failedScrapes = await connection_1.dbRr
                .select()
                .from(schema.scrapes)
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema.scrapes.request_id, req.params.jobId), (0, drizzle_orm_1.eq)(schema.scrapes.team_id, req.auth.team_id), (0, drizzle_orm_1.eq)(schema.scrapes.is_successful, false)));
        }
        catch (failedScrapesError) {
            logger_1.logger.error("Error getting failed scrapes", {
                error: failedScrapesError,
            });
            throw failedScrapesError;
        }
        res.status(200).json({
            errors: (failedScrapes || []).map(scrape => {
                const error = scrape.error
                    ? (0, error_serde_1.deserializeTransportableError)(scrape.error)
                    : null;
                return {
                    id: scrape.id,
                    timestamp: scrape.created_at
                        ? new Date(scrape.created_at).toISOString()
                        : undefined,
                    url: scrape.url,
                    ...(error
                        ? {
                            code: error.code,
                            error: error.message,
                        }
                        : {
                            error: scrape.error ?? "An unknown error occurred",
                        }),
                };
            }),
            robotsBlocked: await redis_1.redisEvictConnection.smembers("crawl:" + req.params.jobId + ":robots_blocked"),
        });
    }
    else {
        return res.status(404).json({ success: false, error: "Job not found" });
    }
}
//# sourceMappingURL=crawl-errors.js.map