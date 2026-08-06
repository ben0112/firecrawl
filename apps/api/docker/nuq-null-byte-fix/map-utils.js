"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shouldUseMapFallback = shouldUseMapFallback;
exports.getMapResults = getMapResults;
exports.buildPromptWithWebsiteStructure = buildPromptWithWebsiteStructure;
const uuid_1 = require("uuid");
const types_1 = require("../controllers/v2/types");
const crawl_redis_1 = require("./crawl-redis");
const zdr_helpers_1 = require("./zdr-helpers");
const validateUrl_1 = require("./validateUrl");
const fireEngine_1 = require("../search/fireEngine");
const redis_1 = require("../services/redis");
const index_1 = require("../services/index");
const map_cosine_1 = require("./map-cosine");
const config_1 = require("../config");
const searxng_1 = require("../search/searxng");
const scrapeURL_1 = require("../scraper/scrapeURL");
const cost_tracking_1 = require("./cost-tracking");
const logger_1 = require("./logger");
// Max Links that "Smart /map" can return
const MAX_FIRE_ENGINE_RESULTS = 100;
const MIN_STANDARD_RESULTS_BEFORE_FALLBACK = 10;
const MAX_SEARXNG_FALLBACK_RESULTS = 20;
function shouldUseMapFallback(standardResultCount, limit) {
    return (standardResultCount < limit &&
        standardResultCount < Math.min(limit, MIN_STANDARD_RESULTS_BEFORE_FALLBACK));
}
async function discoverHomepageLinks({ id, url, teamId, orgId, flags, zeroDataRetention, crawlerOptions, location, headers, ignoreCache, abort, }) {
    const timeout = Math.max(1000, Math.min(crawlerOptions.timeout ?? 15000, 30000));
    const response = await (0, scrapeURL_1.scrapeURL)(`map-homepage;${id}`, url, types_1.scrapeOptions.parse({
        formats: ["links"],
        onlyMainContent: false,
        timeout,
        useMock: crawlerOptions.useMock,
        ...(ignoreCache ? { maxAge: 0 } : {}),
        ...(location ? { location } : {}),
        ...(headers ? { headers } : {}),
    }), {
        teamId,
        orgId: orgId ?? null,
        teamFlags: flags ?? undefined,
        zeroDataRetention,
        externalAbort: {
            signal: abort,
            tier: "external",
            throwable() {
                return new Error("Map homepage fallback aborted");
            },
        },
    }, new cost_tracking_1.CostTracking());
    if (!response.success) {
        throw response.error;
    }
    const links = response.document.links ?? [];
    const resolvedHomepage = response.document.metadata.url || url;
    return [resolvedHomepage, ...links].map(link => ({ url: link }));
}
async function discoverSearxngLinks({ url, search, limit, abort, }) {
    if (!config_1.config.SEARXNG_ENDPOINT || limit <= 0) {
        return [];
    }
    const urlObj = new URL(url);
    const query = `${search ? `${search} ` : ""}site:${urlObj.hostname}`;
    const results = await (0, searxng_1.searxng_search)(query, {
        num_results: Math.min(limit, MAX_SEARXNG_FALLBACK_RESULTS),
        timeout: 10000,
        signal: abort,
    });
    return results.map(result => ({
        url: result.url,
        title: result.title,
        description: result.description,
    }));
}
function dedupeMapDocumentArray(documents) {
    const urlMap = new Map();
    for (const doc of documents) {
        const existing = urlMap.get(doc.url);
        if (!existing) {
            urlMap.set(doc.url, doc);
        }
        else if (doc.title !== undefined && existing.title === undefined) {
            urlMap.set(doc.url, doc);
        }
    }
    return Array.from(urlMap.values());
}
async function queryIndex(url, limit, useIndex, includeSubdomains) {
    if (!useIndex) {
        return [];
    }
    const urlSplits = (0, index_1.generateURLSplits)(url);
    if (urlSplits.length === 1) {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname;
        // TEMP: this should be altered on June 15th 2025 7AM PT - mogery
        const [domainLinks, splitLinks] = await Promise.all([
            includeSubdomains
                ? (0, index_1.queryIndexAtDomainSplitLevelWithMeta)(hostname, limit)
                : [],
            (0, index_1.queryIndexAtSplitLevelWithMeta)(url, limit),
        ]);
        return dedupeMapDocumentArray([...domainLinks, ...splitLinks]);
    }
    else {
        return await (0, index_1.queryIndexAtSplitLevelWithMeta)(url, limit);
    }
}
async function getMapResults({ url, search, limit = types_1.MAX_MAP_LIMIT, includeSubdomains = true, crawlerOptions = {}, teamId, orgId, allowExternalLinks, abort = new AbortController().signal, filterByPath = true, flags, useIndex = true, ignoreCache = false, location, headers, maxFireEngineResults = MAX_FIRE_ENGINE_RESULTS, id: providedId, }) {
    const functionStartTime = Date.now();
    const resolvedUrl = await (0, validateUrl_1.resolveRedirects)(url, abort);
    // If the resolved URL is on a different domain, replace the hostname
    if (!(0, validateUrl_1.isSameDomain)(url, resolvedUrl)) {
        const urlObj = new URL(url);
        urlObj.hostname = new URL(resolvedUrl).hostname;
        url = urlObj.toString();
    }
    const id = providedId ?? (0, uuid_1.v7)();
    let mapResults = [];
    const zeroDataRetention = (0, zdr_helpers_1.getScrapeZDR)(flags) === "forced" || false;
    const mapLogger = logger_1.logger.child({
        module: "map-utils",
        method: "getMapResults",
        jobId: id,
        teamId,
        zeroDataRetention,
    });
    const discovery = {
        fallbackAttempted: false,
        fallbackUsed: false,
        sources: {
            index: 0,
            fireEngine: 0,
            sitemap: 0,
            homepage: 0,
            searxng: 0,
        },
    };
    const sc = {
        originUrl: url,
        crawlerOptions: {
            ...crawlerOptions,
            limit: crawlerOptions.sitemapOnly ? 10000000 : limit,
            scrapeOptions: undefined,
        },
        scrapeOptions: types_1.scrapeOptions.parse({
            ...(location ? { location } : {}),
            ...(headers ? { headers } : {}),
        }),
        internalOptions: { teamId, orgId: orgId ?? null },
        team_id: teamId,
        createdAt: Date.now(),
        zeroDataRetention,
    };
    const crawler = (0, crawl_redis_1.crawlToCrawler)(id, sc, flags);
    try {
        sc.robots = await crawler.getRobotsTxt(false, abort);
        crawler.importRobotsTxt(sc.robots);
    }
    catch (_) {
        // Robots.txt fetch failed, continue without it
    }
    // If sitemapOnly is true, only get links from sitemap
    if (crawlerOptions.sitemap === "only") {
        const sitemap = await crawler.tryGetSitemap(urls => {
            urls.forEach(x => {
                mapResults.push({
                    url: x,
                });
            });
            discovery.sources.sitemap += urls.length;
        }, true, true, crawlerOptions.timeout ?? 30000, abort, crawlerOptions.useMock, ignoreCache ? 0 : undefined);
        if (sitemap > 0) {
            mapResults = mapResults
                .slice(1)
                .map(x => {
                try {
                    return {
                        ...x,
                        url: (0, validateUrl_1.checkAndUpdateURLForMap)(x.url).url.trim(),
                    };
                }
                catch (_) {
                    return null;
                }
            })
                .filter(x => x !== null);
        }
    }
    else {
        let urlWithoutWww = url.replace("www.", "");
        let mapUrl = search && allowExternalLinks
            ? `${search} ${urlWithoutWww}`
            : search
                ? `${search} site:${urlWithoutWww}`
                : `site:${url}`;
        const resultsPerPage = 100;
        const maxPages = Math.ceil(Math.min(maxFireEngineResults, limit) / resultsPerPage);
        const cacheKey = `fireEngineMap:${mapUrl}`;
        const cachedResult = ignoreCache
            ? null
            : await redis_1.redisEvictConnection.get(cacheKey);
        const fetchPage = async (page) => {
            return await (0, fireEngine_1.fireEngineMap)(mapUrl, {
                numResults: resultsPerPage,
                page,
            }, abort);
        };
        const fetchAllPages = async () => {
            if (cachedResult) {
                return JSON.parse(cachedResult);
            }
            // if page 1 has no results, don't fetch remaining pages
            const page1Result = await fetchPage(1);
            if (!page1Result || page1Result.length === 0 || maxPages === 1) {
                return [page1Result];
            }
            const remainingPages = await Promise.all(Array.from({ length: maxPages - 1 }, (_, i) => fetchPage(i + 2)));
            return [page1Result, ...remainingPages];
        };
        const [indexResults, searchResults] = await Promise.all([
            queryIndex(url, limit, useIndex, includeSubdomains),
            fetchAllPages(),
        ]);
        const fireEngineResults = searchResults.flat();
        discovery.sources.index = indexResults.length;
        discovery.sources.fireEngine = fireEngineResults.length;
        if (!zeroDataRetention) {
            await redis_1.redisEvictConnection.set(cacheKey, JSON.stringify(searchResults), "EX", 48 * 60 * 60); // Cache for 48 hours
        }
        if (indexResults.length > 0) {
            mapResults.push(...indexResults);
        }
        if (crawlerOptions.sitemap === "include") {
            try {
                await crawler.tryGetSitemap(urls => {
                    discovery.sources.sitemap += urls.length;
                    mapResults.push(...urls.map(x => ({
                        url: x,
                    })));
                }, true, false, crawlerOptions.timeout ?? 30000, abort, undefined, ignoreCache ? 0 : undefined);
            }
            catch (e) {
                // Silently handle sitemap errors
            }
        }
        const standardDomainResults = dedupeMapDocumentArray(mapResults
            .concat(fireEngineResults.map(x => ({
            url: x.url,
            title: x.title,
            description: x.description,
        })))
            .filter(x => {
            try {
                return (0, validateUrl_1.isSameDomain)(x.url, url);
            }
            catch (_) {
                return false;
            }
        }));
        let homepageResults = [];
        let searxngResults = [];
        if (shouldUseMapFallback(standardDomainResults.length, limit)) {
            discovery.fallbackAttempted = true;
            const remaining = Math.max(0, limit - standardDomainResults.length);
            const [homepageOutcome, searxngOutcome] = await Promise.allSettled([
                discoverHomepageLinks({
                    id,
                    url,
                    teamId,
                    orgId,
                    flags,
                    zeroDataRetention,
                    crawlerOptions,
                    location,
                    headers,
                    ignoreCache,
                    abort,
                }),
                discoverSearxngLinks({
                    url,
                    search,
                    limit: remaining,
                    abort,
                }),
            ]);
            if (homepageOutcome.status === "fulfilled") {
                homepageResults = homepageOutcome.value;
                discovery.sources.homepage = homepageResults.length;
            }
            else {
                mapLogger.warn("Homepage link fallback failed", {
                    error: homepageOutcome.reason,
                });
            }
            if (searxngOutcome.status === "fulfilled") {
                searxngResults = searxngOutcome.value;
                discovery.sources.searxng = searxngResults.length;
            }
            else {
                mapLogger.warn("SearXNG map fallback failed", {
                    error: searxngOutcome.reason,
                });
            }
            discovery.fallbackUsed =
                homepageResults.length > 0 || searxngResults.length > 0;
            mapLogger.info("Map fallback completed", {
                standardResults: standardDomainResults.length,
                homepageResults: homepageResults.length,
                searxngResults: searxngResults.length,
            });
        }
        if (search) {
            mapResults = fireEngineResults
                .concat(searxngResults)
                .map(x => ({
                url: x.url,
                title: x.title,
                description: x.description,
            }))
                .concat(homepageResults, mapResults);
        }
        else {
            mapResults = mapResults.concat(fireEngineResults.concat(searxngResults).map(x => ({
                url: x.url,
                title: x.title,
                description: x.description,
            })), homepageResults);
        }
        if (search) {
            const searchQuery = search.toLowerCase();
            mapResults = (0, map_cosine_1.performCosineSimilarityV2)(mapResults, searchQuery);
        }
    }
    mapResults = mapResults
        .map(x => {
        try {
            return {
                ...x,
                url: (0, validateUrl_1.checkAndUpdateURLForMap)(x.url, crawlerOptions.ignoreQueryParameters ?? true).url.trim(),
            };
        }
        catch (_) {
            return null;
        }
    })
        .filter(x => x !== null);
    mapResults = mapResults.filter(x => (0, validateUrl_1.isSameDomain)(x.url, url));
    if (!includeSubdomains) {
        mapResults = mapResults.filter(x => (0, validateUrl_1.isSameSubdomain)(x.url, url));
    }
    if (filterByPath && !allowExternalLinks) {
        try {
            const urlObj = new URL(url);
            const urlPath = urlObj.pathname;
            // Only apply path filtering if the URL has a significant path (not just '/' or empty)
            // This means we only filter by path if the user has not selected a root domain
            if (urlPath && urlPath !== "/" && urlPath.length > 1) {
                mapResults = mapResults.filter(x => {
                    try {
                        const linkObj = new URL(x.url);
                        return linkObj.pathname.startsWith(urlPath);
                    }
                    catch (e) {
                        return false;
                    }
                });
            }
        }
        catch (e) {
            // If URL parsing fails, continue without path filtering
        }
    }
    mapResults = dedupeMapDocumentArray(mapResults);
    mapResults = mapResults.slice(0, limit);
    const totalTimeMs = Date.now() - functionStartTime;
    return {
        success: true,
        mapResults,
        discovery,
        job_id: id,
        time_taken: totalTimeMs,
    };
}
async function buildPromptWithWebsiteStructure({ basePrompt, url, teamId, orgId, flags, logger, limit = 50, includeSubdomains = true, allowExternalLinks = false, useIndex = true, maxFireEngineResults = 500, }) {
    try {
        logger.debug("Getting website structure for prompt enhancement");
        const mapResult = await getMapResults({
            url,
            limit,
            includeSubdomains,
            crawlerOptions: { sitemap: "include" },
            teamId,
            orgId: orgId ?? null,
            flags,
            allowExternalLinks,
            filterByPath: false,
            useIndex,
            maxFireEngineResults,
        });
        const websiteUrls = mapResult.mapResults.map(doc => doc.url);
        logger.debug("Found website URLs for prompt enhancement", {
            urlCount: websiteUrls.length,
            sampleUrls: websiteUrls.slice(0, 5),
        });
        const prompt = `${basePrompt}\n\n--- WEBSITE STRUCTURE ---\nThe website has the following URL structure (${websiteUrls.length} URLs found, here is a sample of the first ${Math.min(120, websiteUrls.length)} URLs):\n${websiteUrls.slice(0, 120).join("\n")}\n\nBased on this structure and the user's request, generate appropriate crawler options.`;
        return { prompt, websiteUrls };
    }
    catch (e) {
        logger.warn("Failed to get website structure for prompt enhancement", {
            error: e?.message ?? e,
        });
        return { prompt: basePrompt, websiteUrls: [] };
    }
}
//# sourceMappingURL=map-utils.js.map