"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mapController = mapController;
const types_1 = require("./types");
const dotenv_1 = require("dotenv");
const credit_billing_1 = require("../../services/billing/credit_billing");
const log_job_1 = require("../../services/logging/log_job");
const logger_1 = require("../../lib/logger");
const error_1 = require("../../lib/error");
const permissions_1 = require("../../lib/permissions");
const map_utils_1 = require("../../lib/map-utils");
const uuid_1 = require("uuid");
const url_utils_1 = require("../../lib/url-utils");
const zdr_helpers_1 = require("../../lib/zdr-helpers");
const avgrab_resolve_1 = require("../../lib/avgrab-resolve");
const request_1 = require("../../lib/threat-protection/request");
const scrape_billing_1 = require("../../lib/scrape-billing");
(0, dotenv_1.configDotenv)();
async function mapController(req, res) {
    const logger = logger_1.logger.child({
        jobId: (0, uuid_1.v7)(),
        teamId: req.auth.team_id,
        module: "api/v2",
        method: "mapController",
        zeroDataRetention: (0, zdr_helpers_1.getScrapeZDR)(req.acuc?.flags) === "forced",
    });
    // Get timing data from middleware (includes all middleware processing time)
    const middlewareStartTime = req.requestTiming?.startTime || new Date().getTime();
    const controllerStartTime = new Date().getTime();
    const originalRequest = req.body;
    req.body = types_1.mapRequestSchema.parse(req.body);
    const threatProtection = await (0, request_1.resolveThreatProtection)({
        teamId: req.auth.team_id,
        orgId: req.acuc?.org_id ?? null,
        flags: req.acuc?.flags ?? null,
        override: req.body.threatProtection,
    });
    if (threatProtection.error) {
        return res.status(403).json({
            success: false,
            error: threatProtection.error,
        });
    }
    const permissions = (0, permissions_1.checkPermissions)(req.body, req.acuc?.flags, {
        threatProtectionOrgConfig: threatProtection.orgConfig,
    });
    if (permissions.error) {
        return res.status(403).json({
            success: false,
            error: permissions.error,
        });
    }
    const middlewareTime = controllerStartTime - middlewareStartTime;
    const mapId = (0, uuid_1.v7)();
    logger.info("Map request", {
        request: req.body,
        originalRequest,
        teamId: req.auth.team_id,
        mapId,
    });
    await (0, log_job_1.logRequest)({
        id: mapId,
        kind: "map",
        api_version: "v2",
        team_id: req.auth.team_id,
        origin: req.body.origin ?? "api",
        integration: req.body.integration,
        target_hint: req.body.url,
        zeroDataRetention: false, // not supported for map
        api_key_id: req.acuc?.api_key_id ?? null,
    });
    // Short-circuit: if the URL matches avgrab's resolve pattern, delegate entirely
    try {
        const avgrabResults = await (0, avgrab_resolve_1.resolveViaAvgrab)(req.body.url, req.body.limit, logger);
        if (avgrabResults !== null) {
            const creditsCost = avgrabResults.length;
            (0, credit_billing_1.billTeam)(req.auth.team_id, creditsCost, req.acuc?.api_key_id ?? null, {
                endpoint: "map",
                jobId: mapId,
            }).catch(error => {
                logger.error(`Failed to bill team ${req.auth.team_id} for ${creditsCost} credits: ${error}`);
            });
            (0, log_job_1.logMap)({
                id: mapId,
                request_id: mapId,
                url: req.body.url,
                team_id: req.auth.team_id,
                options: {
                    search: req.body.search,
                    sitemap: req.body.sitemap,
                    includeSubdomains: req.body.includeSubdomains,
                    ignoreQueryParameters: req.body.ignoreQueryParameters,
                    limit: req.body.limit,
                    timeout: req.body.timeout,
                    location: req.body.location,
                },
                results: avgrabResults,
                credits_cost: creditsCost,
                zeroDataRetention: false,
            }).catch(error => {
                logger.error(`Failed to log job for team ${req.auth.team_id}: ${error}`);
            });
            return res.status(200).json({
                success: true,
                id: mapId,
                links: avgrabResults,
            });
        }
    }
    catch (error) {
        if (error instanceof error_1.MapFailedError) {
            return res.status(500).json({
                success: false,
                error: error.message,
            });
        }
        logger.warn("avgrab resolve failed, falling back to standard map", {
            error,
        });
    }
    let result;
    let timeoutHandle = null;
    const abort = new AbortController();
    try {
        result = (await Promise.race([
            (0, map_utils_1.getMapResults)({
                url: req.body.url,
                search: req.body.search,
                limit: req.body.limit,
                includeSubdomains: req.body.includeSubdomains,
                crawlerOptions: {
                    ...req.body,
                    sitemap: req.body.sitemap,
                },
                origin: req.body.origin,
                teamId: req.auth.team_id,
                orgId: req.acuc?.org_id ?? null,
                allowExternalLinks: req.body.allowExternalLinks,
                abort: abort.signal,
                mock: req.body.useMock,
                filterByPath: req.body.filterByPath !== false,
                flags: req.acuc?.flags ?? null,
                useIndex: req.body.useIndex,
                ignoreCache: req.body.ignoreCache,
                location: req.body.location,
                headers: req.body.headers,
                id: mapId,
            }),
            ...(req.body.timeout !== undefined
                ? [
                    new Promise((_resolve, reject) => (timeoutHandle = setTimeout(() => {
                        abort.abort(new error_1.MapTimeoutError());
                        reject(new error_1.MapTimeoutError());
                    }, req.body.timeout))),
                ]
                : []),
        ]));
    }
    catch (error) {
        if (error instanceof error_1.MapTimeoutError) {
            return res.status(408).json({
                success: false,
                code: error.code,
                error: error.message,
            });
        }
        else {
            throw error;
        }
    }
    finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
    // Threat protection: remove blocked links from the returned URL list
    // entirely. Checks are URL-level; scan fees bill +2 per unique scanned
    // URL (see calculateThreatScanCredits).
    //
    // "zscaler" mode evaluates map results against local rules only (org
    // lists + synced custom categories): one map can return thousands of
    // URLs, and inline classification would burn the tenant's 400/hour
    // urlLookup budget on links that may never be fetched. Every URL still
    // gets the full provider check when a scrape of it starts.
    let threatScanCredits = 0;
    if (threatProtection.policy && result.mapResults.length > 0) {
        const { decisionsByUrl } = await (0, request_1.checkUrlsAgainstThreatPolicy)(result.mapResults.map(x => x.url), threatProtection.policy, {
            teamId: req.auth.team_id,
            localRulesOnly: threatProtection.policy.mode === "zscaler",
        });
        threatScanCredits = (0, scrape_billing_1.calculateThreatScanCredits)(decisionsByUrl.values());
        result.mapResults = result.mapResults.filter(x => {
            const decision = decisionsByUrl.get(x.url);
            return decision === undefined || decision.allowed;
        });
    }
    // Bill the team
    const creditsToBill = 1 + threatScanCredits;
    (0, credit_billing_1.billTeam)(req.auth.team_id, creditsToBill, req.acuc?.api_key_id ?? null, {
        endpoint: "map",
        jobId: mapId,
    }).catch(error => {
        logger.error("Failed to bill team for map credits", {
            teamId: req.auth.team_id,
            creditsToBill,
            error,
        });
    });
    (0, log_job_1.logMap)({
        id: result.job_id,
        request_id: result.job_id,
        url: req.body.url,
        team_id: req.auth.team_id,
        options: {
            search: req.body.search,
            sitemap: req.body.sitemap,
            includeSubdomains: req.body.includeSubdomains,
            ignoreQueryParameters: req.body.ignoreQueryParameters,
            limit: req.body.limit,
            timeout: req.body.timeout,
            location: req.body.location,
        },
        results: result.mapResults,
        credits_cost: creditsToBill,
        zeroDataRetention: false, // not supported
    }).catch(error => {
        logger.error(`Failed to log job for team ${req.auth.team_id}: ${error}`);
    });
    // Log final timing information
    const totalRequestTime = new Date().getTime() - middlewareStartTime;
    const controllerTime = new Date().getTime() - controllerStartTime;
    logger.info("Request metrics", {
        version: "v2",
        jobId: result.job_id,
        mode: "map",
        middlewareStartTime,
        controllerStartTime,
        middlewareTime,
        controllerTime,
        totalRequestTime,
        linksCount: result.mapResults.length,
    });
    // Check if we should warn about base domain
    let warning;
    // Only show warning if results <= 1 AND user didn't explicitly request limit=1 AND URL is not base domain
    if (result.mapResults.length <= 1 &&
        req.body.limit !== 1 &&
        !(0, url_utils_1.isBaseDomain)(req.body.url)) {
        const baseDomain = (0, url_utils_1.extractBaseDomain)(req.body.url);
        if (baseDomain) {
            warning = `Only ${result.mapResults.length} result(s) found. For broader coverage, try mapping the base domain: ${baseDomain}`;
        }
    }
    const response = {
        success: true,
        id: result.job_id,
        links: result.mapResults,
        discovery: result.discovery,
        ...(warning && { warning }),
    };
    return res.status(200).json(response);
}
//# sourceMappingURL=map.js.map