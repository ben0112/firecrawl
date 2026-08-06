"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getJob = getJob;
exports.getJobs = getJobs;
exports.crawlStatusController = crawlStatusController;
const config_1 = require("../../config");
const crawl_redis_1 = require("../../lib/crawl-redis");
const supabase_jobs_1 = require("../../lib/supabase-jobs");
const dotenv_1 = require("dotenv");
const logger_1 = require("../../lib/logger");
const rpc_1 = require("../../db/rpc");
const gcs_jobs_1 = require("../../lib/gcs-jobs");
const nuq_router_1 = require("../../services/worker/nuq-router");
const crawl_progress_1 = require("../../lib/crawl-progress");
(0, dotenv_1.configDotenv)();
async function getJob(id) {
    const [nuqJob, dbScrape, gcsJob] = await Promise.all([
        nuq_router_1.scrapeQueue.getJob(id),
        (config_1.config.USE_DB_AUTHENTICATION
            ? (0, supabase_jobs_1.supabaseGetScrapeById)(id)
            : null),
        (config_1.config.GCS_BUCKET_NAME ? (0, gcs_jobs_1.getJobFromGCS)(id) : null),
    ]);
    if (!nuqJob && !dbScrape)
        return null;
    if (nuqJob && nuqJob.data.mode !== "single_urls") {
        return null;
    }
    const data = gcsJob ?? nuqJob?.returnvalue;
    if (gcsJob === null && data) {
        logger_1.logger.warn("GCS Job not found", {
            jobId: id,
        });
    }
    const job = {
        id,
        status: dbScrape
            ? dbScrape.success
                ? "completed"
                : "failed"
            : nuqJob.status,
        returnvalue: Array.isArray(data) ? data[0] : data,
        data: {
            scrapeOptions: nuqJob ? nuqJob.data.scrapeOptions : dbScrape.options,
        },
        timestamp: nuqJob
            ? nuqJob.createdAt.valueOf()
            : new Date(dbScrape.created_at).valueOf(),
        failedReason: (nuqJob ? nuqJob.failedReason : dbScrape.error) || undefined,
    };
    return job;
}
async function getJobs(ids) {
    const [nuqJobs, dbScrapes, gcsJobs] = await Promise.all([
        nuq_router_1.scrapeQueue.getJobs(ids),
        config_1.config.USE_DB_AUTHENTICATION ? (0, supabase_jobs_1.supabaseGetScrapesById)(ids) : [],
        config_1.config.GCS_BUCKET_NAME
            ? Promise.all(ids.map(async (x) => ({ id: x, job: await (0, gcs_jobs_1.getJobFromGCS)(x) }))).then(x => x.filter(x => x.job))
            : [],
    ]);
    const nuqJobMap = new Map();
    const dbScrapeMap = new Map();
    const gcsJobMap = new Map();
    for (const job of nuqJobs) {
        nuqJobMap.set(job.id, job);
    }
    for (const scrape of dbScrapes) {
        dbScrapeMap.set(scrape.id, scrape);
    }
    for (const job of gcsJobs) {
        gcsJobMap.set(job.id, job.job);
    }
    const jobs = [];
    for (const id of ids) {
        const nuqJob = nuqJobMap.get(id);
        const dbScrape = dbScrapeMap.get(id);
        const gcsJob = gcsJobMap.get(id);
        if (!nuqJob && !dbScrape)
            continue;
        const data = gcsJob ?? nuqJob?.returnvalue;
        if (gcsJob === null && data) {
            logger_1.logger.warn("GCS Job not found", {
                jobId: id,
            });
        }
        const job = {
            id,
            status: dbScrape
                ? dbScrape.success
                    ? "completed"
                    : "failed"
                : nuqJob.status,
            returnvalue: Array.isArray(data) ? data[0] : data,
            data: {
                scrapeOptions: nuqJob ? nuqJob.data.scrapeOptions : dbScrape.options,
            },
            timestamp: nuqJob
                ? nuqJob.createdAt.valueOf()
                : new Date(dbScrape.created_at).valueOf(),
            failedReason: (nuqJob ? nuqJob.failedReason : dbScrape.error) || undefined,
        };
        jobs.push(job);
    }
    return jobs;
}
async function crawlStatusController(req, res, isBatch = false) {
    const start = typeof req.query.skip === "string" ? parseInt(req.query.skip, 10) : 0;
    const end = typeof req.query.limit === "string"
        ? start + parseInt(req.query.limit, 10) - 1
        : undefined;
    const group = await nuq_router_1.crawlGroup.getGroup(req.params.jobId);
    const groupAnyJob = await nuq_router_1.scrapeQueue.getGroupAnyJob(req.params.jobId, req.auth.team_id);
    const sc = await (0, crawl_redis_1.getCrawl)(req.params.jobId);
    if (!group || (!groupAnyJob && (!sc || sc.team_id !== req.auth.team_id))) {
        return res.status(404).json({ success: false, error: "Job not found" });
    }
    const zeroDataRetention = !!(groupAnyJob?.data?.zeroDataRetention ?? sc?.zeroDataRetention);
    const numericStats = await nuq_router_1.scrapeQueue.getGroupNumericStats(req.params.jobId, logger_1.logger.child({ zeroDataRetention }));
    const progress = (0, crawl_progress_1.getCrawlProgress)(numericStats);
    const creditsBilled = config_1.config.USE_DB_AUTHENTICATION
        ? await (0, rpc_1.creditsBilledByCrawlId)(req.params.jobId).catch(() => null)
        : null;
    // check if the crawl failed during kickoff (e.g. queue full)
    const crawlError = await (0, crawl_redis_1.getCrawlError)(req.params.jobId);
    let outputBulkA = {
        status: sc?.cancelled
            ? "cancelled"
            : group.status === "active"
                ? "scraping"
                : group.status,
        completed: progress.completed,
        failed: progress.failed,
        total: progress.total,
        creditsUsed: creditsBilled?.[0]?.credits_billed ?? -1,
    };
    // if the crawl has a stored error and no jobs were ever created, mark as failed
    if (crawlError &&
        outputBulkA.total === 0 &&
        outputBulkA.status === "completed") {
        outputBulkA.status = "failed";
    }
    // if the crawl failed during kickoff, return immediately without fetching/processing jobs (there are none)
    if (outputBulkA.status === "failed" && crawlError) {
        return res.status(200).json({
            success: false,
            error: crawlError,
            status: "failed",
            completed: 0,
            failed: 0,
            total: 0,
            creditsUsed: outputBulkA.creditsUsed ?? 0,
            expiresAt: (await (0, crawl_redis_1.getCrawlExpiry)(req.params.jobId)).toISOString(),
            data: [],
        });
    }
    let outputBulkB;
    const doneJobs = await nuq_router_1.scrapeQueue.getCrawlJobsForListing(req.params.jobId, end !== undefined ? end - start + 1 : 100, start, logger_1.logger.child({ zeroDataRetention }));
    let scrapes = [];
    let iteratedOver = 0;
    let bytes = 0;
    const bytesLimit = 10485760; // 10 MiB in bytes
    const scrapeBlobs = await Promise.all(doneJobs.map(async (x) => [x.id, x.returnvalue ?? (await (0, gcs_jobs_1.getJobFromGCS)(x.id))?.[0]]));
    for (const [id, scrape] of scrapeBlobs) {
        if (scrape) {
            scrapes.push(scrape);
            bytes += JSON.stringify(scrape).length;
        }
        else {
            logger_1.logger.warn("Job was considered done, but returnvalue is undefined!", {
                jobId: id,
                returnvalue: scrape,
                zeroDataRetention,
            });
        }
        iteratedOver++;
        if (bytes > bytesLimit) {
            break;
        }
    }
    if (bytes > bytesLimit && scrapes.length !== 1) {
        scrapes.splice(scrapes.length - 1, 1);
        iteratedOver--;
    }
    outputBulkB = {
        data: scrapes,
        next: (0, crawl_progress_1.hasMoreCrawlResultPages)({
            completed: outputBulkA.completed ?? 0,
            start,
            iteratedOver,
            status: outputBulkA.status ?? "scraping",
        })
            ? `${req.protocol}://${req.host}/v1/${isBatch ? "batch/scrape" : "crawl"}/${req.params.jobId}?skip=${start + iteratedOver}${req.query.limit ? `&limit=${req.query.limit}` : ""}`
            : undefined,
    };
    return res.status(200).json({
        success: true,
        status: outputBulkA.status ?? "scraping",
        completed: outputBulkA.completed ?? 0,
        failed: outputBulkA.failed ?? 0,
        total: outputBulkA.total ?? 0,
        creditsUsed: outputBulkA.creditsUsed ?? 0,
        expiresAt: (await (0, crawl_redis_1.getCrawlExpiry)(req.params.jobId)).toISOString(),
        next: outputBulkB.next,
        data: outputBulkB.data,
    });
}
//# sourceMappingURL=crawl-status.js.map