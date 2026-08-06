"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebCrawler = exports.SITEMAP_LIMIT = void 0;
exports.isBareExternalReference = isBareExternalReference;
const axios_1 = require("axios");
const config_1 = require("../../config");
const cheerio_1 = require("cheerio"); // rustified
const url_1 = require("url");
const sitemap_1 = require("./sitemap");
const robots_parser_1 = __importDefault(require("robots-parser"));
const maxDepthUtils_1 = require("./utils/maxDepthUtils");
const logger_1 = require("../../lib/logger");
const redis_1 = require("../../services/redis");
const firecrawl_rs_1 = require("@mendable/firecrawl-rs");
const robots_txt_1 = require("../../lib/robots-txt");
const error_1 = require("../../lib/error");
const firecrawl_rs_2 = require("@mendable/firecrawl-rs");
const url_utils_1 = require("../../lib/url-utils");
exports.SITEMAP_LIMIT = 25;
const SITEMAP_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
var DenialReason;
(function (DenialReason) {
    DenialReason["DEPTH_LIMIT"] = "This URL exceeds the maximum crawl depth you configured. The URL's depth (number of path segments) is greater than the maxDepth parameter. To crawl this URL, increase the maxDepth value in your crawl request.";
    DenialReason["EXCLUDE_PATTERN"] = "This URL's path matches one of the regex patterns you provided in the excludePaths parameter. URLs matching excludePaths are intentionally skipped during crawling. If this URL should be crawled, adjust your excludePaths patterns.";
    DenialReason["INCLUDE_PATTERN"] = "This URL's path does not match any of the regex patterns you provided in the includePaths parameter. When includePaths is specified, only URLs matching at least one pattern are crawled. If this URL should be crawled, add a matching pattern to includePaths or remove the includePaths restriction.";
    DenialReason["ROBOTS_TXT"] = "This URL is blocked by the website's robots.txt file, which instructs crawlers not to access this page. Firecrawl respects robots.txt by default. To crawl this URL anyway, set ignoreRobotsTxt: true in your crawl request (note: this may violate the website's crawling policies).";
    DenialReason["FILE_TYPE"] = "This URL points to a file type that Firecrawl does not crawl (e.g., images, videos, fonts, archives). Firecrawl automatically skips non-document file extensions like .png, .jpg, .mp4, .zip, .css, .js, etc.";
    DenialReason["URL_PARSE_ERROR"] = "This URL could not be parsed as a valid URL. The URL may be malformed, contain invalid characters, or use an unsupported format. Please verify the URL is correctly formatted.";
    DenialReason["BACKWARD_CRAWLING"] = "This URL is outside the initial URL's path hierarchy, and backward crawling is disabled. By default, Firecrawl only crawls URLs that are 'below' or 'within' the starting URL path. To crawl this URL, either set allowBackwardCrawling: true or set crawlEntireDomain: true to crawl the entire domain.";
    DenialReason["SOCIAL_MEDIA"] = "This URL points to a social media platform or is an email link. Firecrawl automatically skips social media links and mailto: links during crawling.";
    DenialReason["EXTERNAL_LINK"] = "This URL points to a different domain than the one being crawled, and external links are disabled. By default, Firecrawl only crawls URLs on the same domain as the starting URL. To crawl external links, set allowExternalLinks: true in your crawl request.";
    DenialReason["SECTION_LINK"] = "This URL contains a section anchor (#) and points to a specific section of a page rather than a separate page. Firecrawl treats these as duplicates of the base URL and skips them to avoid crawling the same content multiple times.";
    DenialReason["NON_WEB_PROTOCOL"] = "This URL uses a non-web protocol (such as mailto:, tel:, ftp:, ssh:, file:, or telnet:) that Firecrawl cannot scrape. Firecrawl only supports HTTP and HTTPS protocols.";
})(DenialReason || (DenialReason = {}));
/**
 * A bare public hostname or email address in a PDF/document annotation is not a
 * valid relative web path. Resolving it against the current page turns values
 * such as `assets.example.com` into `/path/assets.example.com`, causing bogus
 * same-origin crawl jobs. Real relative files such as `report.pdf` remain
 * allowed because their suffix is not an ICANN/private public suffix.
 */
function isBareExternalReference(href) {
    const value = String(href ?? "").trim();
    if (!value || /^(?:[a-z][a-z0-9+.-]*:|\/\/|[./?#])/i.test(value)) {
        return false;
    }
    const firstSegment = value.split(/[/?#]/, 1)[0];
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(firstSegment))
        return true;
    const hostname = firstSegment.replace(/:\d+$/, "").toLowerCase();
    if (!hostname.includes("."))
        return false;
    const parsed = (0, url_utils_1.parseHostname)(hostname);
    return Boolean(parsed.hostname === hostname &&
        parsed.domain &&
        (parsed.isIcann || parsed.isPrivate));
}
class WebCrawler {
    jobId;
    initialUrl;
    baseUrl;
    includes;
    excludes;
    maxCrawledLinks;
    maxCrawledDepth;
    visited = new Set();
    crawledUrls = new Map();
    limit;
    robotsTxt;
    robotsTxtUrl;
    robots;
    robotsCrawlDelay = null;
    generateImgAltText;
    allowBackwardCrawling;
    allowExternalContentLinks;
    allowSubdomains;
    ignoreRobotsTxt;
    regexOnFullURL;
    logger;
    sitemapsHit = new Set();
    maxDiscoveryDepth;
    currentDiscoveryDepth;
    zeroDataRetention;
    location;
    headers;
    robotsUserAgent;
    constructor({ jobId, initialUrl, baseUrl, includes, excludes, maxCrawledLinks = 10000, limit = 10000, generateImgAltText = false, maxCrawledDepth = 10, allowBackwardCrawling = false, allowExternalContentLinks = false, allowSubdomains = false, ignoreRobotsTxt = false, regexOnFullURL = false, maxDiscoveryDepth, currentDiscoveryDepth, zeroDataRetention, location, headers, robotsUserAgent, }) {
        this.jobId = jobId;
        this.initialUrl = initialUrl;
        this.baseUrl = baseUrl ?? new url_1.URL(initialUrl).origin;
        this.includes = Array.isArray(includes) ? includes : [];
        this.excludes = Array.isArray(excludes) ? excludes : [];
        this.limit = limit;
        this.robotsTxt = "";
        this.robotsTxtUrl = `${this.baseUrl}${this.baseUrl.endsWith("/") ? "" : "/"}robots.txt`;
        this.robots = (0, robots_parser_1.default)(this.robotsTxtUrl, this.robotsTxt);
        // Deprecated, use limit instead
        this.maxCrawledLinks = maxCrawledLinks ?? limit;
        this.maxCrawledDepth = maxCrawledDepth ?? 10;
        this.generateImgAltText = generateImgAltText ?? false;
        this.allowBackwardCrawling = allowBackwardCrawling ?? false;
        this.allowExternalContentLinks = allowExternalContentLinks ?? false;
        this.allowSubdomains = allowSubdomains ?? false;
        this.ignoreRobotsTxt = ignoreRobotsTxt ?? false;
        this.regexOnFullURL = regexOnFullURL ?? false;
        this.zeroDataRetention = zeroDataRetention ?? false;
        this.logger = logger_1.logger.child({
            crawlId: this.jobId,
            module: "WebCrawler",
            zeroDataRetention: this.zeroDataRetention,
        });
        this.maxDiscoveryDepth = maxDiscoveryDepth;
        this.currentDiscoveryDepth = currentDiscoveryDepth ?? 0;
        this.location = location;
        this.headers = headers;
        this.robotsUserAgent = robotsUserAgent;
    }
    setBaseUrl(newBase) {
        this.baseUrl = newBase;
        this.robotsTxtUrl = `${this.baseUrl}${this.baseUrl.endsWith("/") ? "" : "/"}robots.txt`;
    }
    async filterLinks(sitemapLinks, limit, maxDepth, fromMap = false, skipRobots = false, ignoreDiscoveryDepth = false) {
        const denialReasons = new Map();
        if (!ignoreDiscoveryDepth &&
            this.currentDiscoveryDepth === this.maxDiscoveryDepth) {
            this.logger.debug("Max discovery depth hit, filtering off all links", {
                currentDiscoveryDepth: this.currentDiscoveryDepth,
                maxDiscoveryDepth: this.maxDiscoveryDepth,
            });
            sitemapLinks.forEach(link => {
                denialReasons.set(link, `This URL was not crawled because the maximum discovery depth (${this.maxDiscoveryDepth}) has been reached. Discovery depth counts how many 'hops' from the starting URL a page is. To crawl more pages, increase the maxDiscoveryDepth value in your crawl request.`);
            });
            return { links: [], denialReasons };
        }
        // If the initial URL is a sitemap.xml, skip filtering
        if (this.initialUrl.endsWith("sitemap.xml") && fromMap) {
            return { links: sitemapLinks.slice(0, limit), denialReasons };
        }
        try {
            const res = await (0, firecrawl_rs_2.filterLinks)({
                links: sitemapLinks,
                limit: isFinite(limit) ? limit : undefined,
                maxDepth: maxDepth,
                baseUrl: this.baseUrl,
                initialUrl: this.initialUrl,
                regexOnFullUrl: this.regexOnFullURL,
                excludes: this.excludes,
                includes: this.includes,
                allowBackwardCrawling: this.allowBackwardCrawling,
                ignoreRobotsTxt: this.ignoreRobotsTxt || skipRobots,
                robotsTxt: this.robotsTxt,
                robotsUserAgent: this.robotsUserAgent,
                allowExternalContentLinks: this.allowExternalContentLinks,
                allowSubdomains: this.allowSubdomains,
            });
            const fancyDenialReasons = new Map();
            Object.entries(res.denialReasons).forEach(([key, value]) => {
                // Generate dynamic context for specific denial reasons
                let urlPath;
                try {
                    urlPath = new url_1.URL(key).pathname;
                }
                catch {
                    urlPath = key;
                }
                const excincPath = this.regexOnFullURL ? key : urlPath;
                switch (value) {
                    case "DEPTH_LIMIT":
                        const depth = (0, maxDepthUtils_1.getURLDepth)(key);
                        fancyDenialReasons.set(key, `This URL exceeds the maximum crawl depth you configured. The URL's depth is ${depth}, but maxDepth is set to ${maxDepth}. To crawl this URL, increase the maxDepth value in your crawl request.`);
                        break;
                    case "EXCLUDE_PATTERN":
                        const matchingExclude = this.excludes.find(p => {
                            try {
                                return new RegExp(p).test(excincPath);
                            }
                            catch {
                                return false;
                            }
                        });
                        fancyDenialReasons.set(key, `This URL's path ("${excincPath}") matches the exclude pattern "${matchingExclude ?? "(unknown)"}" you provided in the excludePaths parameter. URLs matching excludePaths are intentionally skipped during crawling. If this URL should be crawled, adjust your excludePaths patterns.`);
                        break;
                    case "INCLUDE_PATTERN":
                        fancyDenialReasons.set(key, `This URL's path ("${excincPath}") does not match any of the regex patterns you provided in the includePaths parameter: [${this.includes.map(p => `"${p}"`).join(", ")}]. When includePaths is specified, only URLs matching at least one pattern are crawled. If this URL should be crawled, add a matching pattern to includePaths or remove the includePaths restriction.`);
                        break;
                    case "BACKWARD_CRAWLING":
                        const initialPath = new url_1.URL(this.initialUrl).pathname;
                        fancyDenialReasons.set(key, `This URL's path ("${urlPath}") is outside the initial URL's path hierarchy ("${initialPath}"), and backward crawling is disabled. By default, Firecrawl only crawls URLs that are 'below' or 'within' the starting URL path. To crawl this URL, either set allowBackwardCrawling: true or set crawlEntireDomain: true to crawl the entire domain.`);
                        break;
                    case "FILE_TYPE":
                        const extension = key.split("?")[0].split(".").pop()?.toLowerCase();
                        fancyDenialReasons.set(key, `This URL points to a file with extension ".${extension}" that Firecrawl does not crawl. Firecrawl automatically skips non-document file extensions like .png, .jpg, .mp4, .zip, .css, .js, etc. to focus on web pages with textual content.`);
                        break;
                    default:
                        // Use the static enum message for other cases
                        fancyDenialReasons.set(key, DenialReason[value] ?? value);
                }
            });
            if (config_1.config.FIRECRAWL_DEBUG_FILTER_LINKS) {
                for (const link of res.links) {
                    this.logger.debug(`${link} OK`);
                }
                for (const [link, reason] of fancyDenialReasons) {
                    this.logger.debug(`${link} ${reason}`);
                }
            }
            return {
                links: res.links,
                denialReasons: fancyDenialReasons,
            };
        }
        catch (error) {
            this.logger.error("Error filtering links in Rust, falling back to JS", {
                error,
                method: "filterLinks",
            });
        }
        const filteredLinks = sitemapLinks
            .filter(link => {
            let url;
            try {
                url = new url_1.URL(link.trim(), this.baseUrl);
            }
            catch (error) {
                this.logger.debug(`Error processing link: ${link}`, {
                    link,
                    error,
                    method: "filterLinks",
                });
                return false;
            }
            const path = url.pathname;
            const urlStr = url.toString();
            const nonWebProtocols = [
                "mailto:",
                "tel:",
                "telnet:",
                "ftp:",
                "ftps:",
                "ssh:",
                "file:",
            ];
            if (nonWebProtocols.some(protocol => urlStr.startsWith(protocol))) {
                if (config_1.config.FIRECRAWL_DEBUG_FILTER_LINKS) {
                    this.logger.debug(`${link} NON-WEB PROTOCOL FAIL`);
                }
                denialReasons.set(link, DenialReason.NON_WEB_PROTOCOL);
                return false;
            }
            const depth = (0, maxDepthUtils_1.getURLDepth)(url.toString());
            // Check if the link exceeds the maximum depth allowed
            if (depth > maxDepth) {
                if (config_1.config.FIRECRAWL_DEBUG_FILTER_LINKS) {
                    this.logger.debug(`${link} DEPTH FAIL`);
                }
                denialReasons.set(link, `This URL exceeds the maximum crawl depth you configured. The URL's depth is ${depth}, but maxDepth is set to ${maxDepth}. To crawl this URL, increase the maxDepth value in your crawl request.`);
                return false;
            }
            const excincPath = this.regexOnFullURL ? link : path;
            // Check if the link should be excluded
            if (this.excludes.length > 0 && this.excludes[0] !== "") {
                const matchingPattern = this.excludes.find(excludePattern => new RegExp(excludePattern).test(excincPath));
                if (matchingPattern) {
                    if (config_1.config.FIRECRAWL_DEBUG_FILTER_LINKS) {
                        this.logger.debug(`${link} EXCLUDE FAIL`);
                    }
                    denialReasons.set(link, `This URL's path ("${excincPath}") matches the exclude pattern "${matchingPattern}" you provided in the excludePaths parameter. URLs matching excludePaths are intentionally skipped during crawling. If this URL should be crawled, adjust your excludePaths patterns.`);
                    return false;
                }
            }
            // Check if the link matches the include patterns, if any are specified
            if (this.includes.length > 0 && this.includes[0] !== "") {
                if (!this.includes.some(includePattern => new RegExp(includePattern).test(excincPath))) {
                    if (config_1.config.FIRECRAWL_DEBUG_FILTER_LINKS) {
                        this.logger.debug(`${link} INCLUDE FAIL`);
                    }
                    denialReasons.set(link, `This URL's path ("${excincPath}") does not match any of the regex patterns you provided in the includePaths parameter: [${this.includes.map(p => `"${p}"`).join(", ")}]. When includePaths is specified, only URLs matching at least one pattern are crawled. If this URL should be crawled, add a matching pattern to includePaths or remove the includePaths restriction.`);
                    return false;
                }
            }
            // Normalize the initial URL and the link to account for www and non-www versions
            const normalizedInitialUrl = new url_1.URL(this.initialUrl);
            let normalizedLink;
            try {
                normalizedLink = new url_1.URL(link);
            }
            catch (_) {
                if (config_1.config.FIRECRAWL_DEBUG_FILTER_LINKS) {
                    this.logger.debug(`${link} URL PARSE FAIL`);
                }
                return false;
            }
            const initialHostname = normalizedInitialUrl.hostname.replace(/^www\./, "");
            const linkHostname = normalizedLink.hostname.replace(/^www\./, "");
            // Ensure the protocol and hostname match, and the path starts with the initial URL's path
            // commented to able to handling external link on allowExternalContentLinks
            // if (linkHostname !== initialHostname) {
            //   return false;
            // }
            if (!this.allowBackwardCrawling) {
                if (!normalizedLink.pathname.startsWith(normalizedInitialUrl.pathname)) {
                    if (config_1.config.FIRECRAWL_DEBUG_FILTER_LINKS) {
                        this.logger.debug(`${link} BACKWARDS FAIL ${normalizedLink.pathname} ${normalizedInitialUrl.pathname}`);
                    }
                    denialReasons.set(link, `This URL's path ("${normalizedLink.pathname}") is outside the initial URL's path hierarchy ("${normalizedInitialUrl.pathname}"), and backward crawling is disabled. By default, Firecrawl only crawls URLs that are 'below' or 'within' the starting URL path. To crawl this URL, either set allowBackwardCrawling: true or set crawlEntireDomain: true to crawl the entire domain.`);
                    return false;
                }
            }
            const isAllowed = this.isRobotsAllowed(link, this.ignoreRobotsTxt || skipRobots);
            // Check if the link is disallowed by robots.txt
            if (!isAllowed) {
                this.logger.debug(`Link disallowed by robots.txt: ${link}`, {
                    method: "filterLinks",
                    link,
                });
                if (config_1.config.FIRECRAWL_DEBUG_FILTER_LINKS) {
                    this.logger.debug(`${link} ROBOTS FAIL`);
                }
                denialReasons.set(link, `This URL is blocked by the website's robots.txt file, which instructs crawlers not to access this page. Firecrawl respects robots.txt by default. To crawl this URL anyway, set ignoreRobotsTxt: true in your crawl request (note: this may violate the website's crawling policies).`);
                return false;
            }
            if (this.isFile(link)) {
                if (config_1.config.FIRECRAWL_DEBUG_FILTER_LINKS) {
                    this.logger.debug(`${link} FILE FAIL`);
                }
                const extension = link.split("?")[0].split(".").pop()?.toLowerCase();
                denialReasons.set(link, `This URL points to a file with extension ".${extension}" that Firecrawl does not crawl. Firecrawl automatically skips non-document file extensions like .png, .jpg, .mp4, .zip, .css, .js, etc. to focus on web pages with textual content.`);
                return false;
            }
            if (config_1.config.FIRECRAWL_DEBUG_FILTER_LINKS) {
                this.logger.debug(`${link} OK`);
            }
            return true;
        })
            .slice(0, limit);
        return { links: filteredLinks, denialReasons };
    }
    async getRobotsTxt(skipTlsVerification = false, abort) {
        try {
            this.logger.debug("Attempting to fetch robots.txt", {
                method: "getRobotsTxt",
                initialUrl: this.initialUrl,
                skipTlsVerification,
            });
            const { content: robotsTxt, url } = await (0, robots_txt_1.fetchRobotsTxt)({
                url: this.robotsTxtUrl,
                zeroDataRetention: this.zeroDataRetention,
                location: this.location,
                ...(this.robotsUserAgent
                    ? {
                        headers: {
                            ...this.headers,
                            "User-Agent": this.robotsUserAgent,
                        },
                        skipCache: true,
                    }
                    : {}),
            }, this.jobId, this.logger, abort);
            this.logger.debug("Successfully fetched robots.txt", {
                method: "getRobotsTxt",
                initialUrl: this.initialUrl,
                robotsTxtLength: robotsTxt.length,
                hasContent: robotsTxt.length > 0,
                finalUrl: url,
            });
            return robotsTxt;
        }
        catch (error) {
            this.logger.debug("Failed to fetch robots.txt", {
                method: "getRobotsTxt",
                initialUrl: this.initialUrl,
                error: error.message,
            });
            throw error;
        }
    }
    importRobotsTxt(txt) {
        this.robotsTxt = txt;
        const checker = (0, robots_txt_1.createRobotsChecker)(this.initialUrl, txt);
        this.robots = checker.robots;
        this.robotsTxtUrl = checker.robotsTxtUrl;
        const delay = this.robotsUserAgent
            ? this.robots.getCrawlDelay(this.robotsUserAgent)
            : this.robots.getCrawlDelay("FireCrawlAgent") ||
                this.robots.getCrawlDelay("FirecrawlAgent");
        this.robotsCrawlDelay = delay !== undefined ? delay : null;
        const sitemaps = this.robots.getSitemaps();
        this.logger.debug("Imported robots.txt", {
            method: "importRobotsTxt",
            robotsTxtUrl: this.robotsTxtUrl,
            robotsTxtLength: txt.length,
            sitemapsFound: sitemaps.length,
            sitemaps: sitemaps,
            crawlDelay: this.robotsCrawlDelay,
        });
    }
    getRobotsCrawlDelay() {
        return this.robotsCrawlDelay;
    }
    async tryGetSitemap(urlsHandler, fromMap = false, onlySitemap = false, timeout = 120000, abort, mock, maxAge = SITEMAP_MAX_AGE) {
        this.logger.debug(`Fetching sitemap links from ${this.initialUrl}`, {
            method: "tryGetSitemap",
        });
        let leftOfLimit = this.limit;
        const normalizeUrl = (url) => {
            url = url.replace(/^https?:\/\//, "").replace(/^www\./, "");
            if (url.endsWith("/")) {
                url = url.slice(0, -1);
            }
            return url;
        };
        const _urlsHandler = async (urls) => {
            this.logger.debug("urlsHandler invoked");
            if (fromMap && onlySitemap) {
                return await urlsHandler(urls);
            }
            else {
                let filteredLinksResult = await this.filterLinks([...new Set(urls)], leftOfLimit, this.maxCrawledDepth, fromMap, fromMap);
                let filteredLinks = filteredLinksResult.links;
                leftOfLimit -= filteredLinks.length;
                const pipeline = redis_1.redisEvictConnection.pipeline();
                const normalizedUrls = filteredLinks.map(url => normalizeUrl(url));
                normalizedUrls.forEach(normalizedUrl => {
                    pipeline.sadd("sitemap:" + this.jobId + ":links", normalizedUrl);
                });
                const results = await pipeline.exec();
                const uniqueURLs = filteredLinks.filter((_, index) => results &&
                    results[index] &&
                    !results[index][0] &&
                    results[index][1] === 1);
                await redis_1.redisEvictConnection.expire("sitemap:" + this.jobId + ":links", 3600, "NX");
                if (uniqueURLs.length > 0) {
                    return await urlsHandler(uniqueURLs);
                }
            }
        };
        let timeoutHandle;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error("Sitemap fetch timeout")), timeout);
        });
        try {
            const robotsSitemaps = this.robots.getSitemaps();
            this.logger.debug("Attempting to fetch sitemap links", {
                method: "tryGetSitemap",
                initialUrl: this.initialUrl,
                robotsSitemapsCount: robotsSitemaps.length,
                robotsSitemaps: robotsSitemaps,
                hasRobotsTxt: this.robotsTxt.length > 0,
            });
            let count = (await Promise.race([
                Promise.all([
                    this.tryFetchSitemapLinks(this.initialUrl, _urlsHandler, abort, mock, maxAge),
                    ...robotsSitemaps.map(x => this.tryFetchSitemapLinks(x, _urlsHandler, abort, mock, maxAge)),
                ]).then(results => results.reduce((a, x) => a + x, 0)),
                timeoutPromise,
            ]).finally(() => {
                clearTimeout(timeoutHandle);
            }));
            if (count > 0) {
                if (await redis_1.redisEvictConnection.sadd("sitemap:" + this.jobId + ":links", normalizeUrl(this.initialUrl))) {
                    urlsHandler([this.initialUrl]);
                }
                count++;
            }
            await redis_1.redisEvictConnection.expire("sitemap:" + this.jobId + ":links", 3600, "NX");
            return count;
        }
        catch (error) {
            if (error.message === "Sitemap fetch timeout") {
                this.logger.warn("Sitemap fetch timed out", {
                    method: "tryGetSitemap",
                    timeout,
                });
                return 0;
            }
            this.logger.error("Error fetching sitemap", {
                method: "tryGetSitemap",
                error,
            });
            return 0;
        }
    }
    async filterURL(href, url) {
        if (isBareExternalReference(href)) {
            return {
                allowed: false,
                denialReason: DenialReason.URL_PARSE_ERROR,
            };
        }
        return await (0, firecrawl_rs_2.filterUrl)({
            href: href,
            url: url,
            baseUrl: this.baseUrl,
            excludes: this.excludes,
            ignoreRobotsTxt: this.ignoreRobotsTxt,
            robotsTxt: this.robotsTxt,
            robotsUserAgent: this.robotsUserAgent,
            allowExternalContentLinks: this.allowExternalContentLinks,
            allowSubdomains: this.allowSubdomains,
        });
    }
    async extractLinksFromHTMLRust(html, url) {
        const links = await (0, firecrawl_rs_1.extractLinks)(html);
        const filteredLinks = [];
        for (const link of links) {
            const filterResult = await this.filterURL(link, url);
            if (filterResult.allowed && filterResult.url) {
                filteredLinks.push(filterResult.url);
            }
        }
        return filteredLinks;
    }
    async extractLinksFromHTMLCheerio(html, url) {
        let links = [];
        const $ = (0, cheerio_1.load)(html);
        for (let i = 0; i < $("a").length; i++) {
            const element = $("a")[i];
            let href = $(element).attr("href");
            if (href) {
                if (href.match(/^https?:\/[^\/]/)) {
                    href = href.replace(/^https?:\//, "$&/");
                }
                const filterResult = await this.filterURL(href, url);
                if (filterResult.allowed && filterResult.url) {
                    links.push(filterResult.url);
                }
            }
        }
        // Extract links from iframes with inline src
        for (let i = 0; i < $("iframe").length; i++) {
            const element = $("iframe")[i];
            const src = $(element).attr("src");
            if (src && src.startsWith("data:text/html")) {
                const iframeHtml = decodeURIComponent(src.split(",")[1]);
                const iframeLinks = await this.extractLinksFromHTMLCheerio(iframeHtml, url);
                links = links.concat(iframeLinks);
            }
        }
        return links;
    }
    async extractLinksFromHTML(html, url) {
        try {
            return [
                ...new Set((await this.extractLinksFromHTMLRust(html, url))
                    .map(x => {
                    try {
                        return new url_1.URL(x, url).href;
                    }
                    catch (e) {
                        return null;
                    }
                })
                    .filter(x => x !== null)),
            ];
        }
        catch (error) {
            this.logger.warn("Failed to call html-transformer! Falling back to cheerio...", {
                error,
                module: "scrapeURL",
                method: "extractMetadata",
            });
        }
        return await this.extractLinksFromHTMLCheerio(html, url);
    }
    isRobotsAllowed(url, ignoreRobotsTxt = false) {
        return ignoreRobotsTxt
            ? true
            : (0, robots_txt_1.isUrlAllowedByRobots)(url, this.robots, this.robotsUserAgent ? [this.robotsUserAgent] : undefined);
    }
    isFile(url) {
        const fileExtensions = [
            ".png",
            ".jpg",
            ".jpeg",
            ".gif",
            ".css",
            ".js",
            ".ico",
            ".svg",
            ".tiff",
            // ".pdf",
            ".zip",
            ".exe",
            ".dmg",
            ".mp4",
            ".mp3",
            ".wav",
            ".pptx",
            // ".docx",
            ".xlsx",
            // ".xml",
            ".avi",
            ".flv",
            ".woff",
            ".ttf",
            ".woff2",
            ".webp",
            ".inc",
        ];
        try {
            const urlWithoutQuery = url.split("?")[0].toLowerCase();
            return fileExtensions.some(ext => urlWithoutQuery.endsWith(ext));
        }
        catch (error) {
            this.logger.error(`Error processing URL in isFile`, {
                method: "isFile",
                error,
            });
            return false;
        }
    }
    async tryFetchSitemapLinks(url, urlsHandler, abort, mock, maxAge) {
        const sitemapUrl = url.toLowerCase().endsWith(".xml") ||
            url.toLowerCase().endsWith(".xml.gz")
            ? url
            : `${url}${url.endsWith("/") ? "" : "/"}sitemap.xml`;
        this.logger.debug("Trying to fetch sitemap links", {
            method: "tryFetchSitemapLinks",
            originalUrl: url,
            sitemapUrl,
            maxAge,
            isXmlUrl: url.endsWith(".xml"),
            isGzUrl: url.endsWith(".xml.gz"),
        });
        let sitemapCount = 0;
        // Try to get sitemap from the provided URL first
        try {
            sitemapCount = await (0, sitemap_1.getLinksFromSitemap)({
                sitemapUrl,
                urlsHandler,
                mode: "fire-engine",
                maxAge,
                zeroDataRetention: this.zeroDataRetention,
                location: this.location,
                headers: this.headers,
            }, this.logger, this.jobId, this.sitemapsHit, abort, mock);
        }
        catch (error) {
            if (error instanceof error_1.ScrapeJobTimeoutError) {
                throw error;
            }
            else {
                this.logger.debug(`Failed to fetch sitemap from ${sitemapUrl}`, {
                    method: "tryFetchSitemapLinks",
                    sitemapUrl,
                    error,
                });
            }
        }
        // If this is a subdomain, also try to get sitemap from the main domain
        try {
            const urlObj = new url_1.URL(url);
            const hostname = urlObj.hostname;
            // Skip subdomain logic for IP addresses (IPv4 or IPv6)
            const isIPv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname);
            const isIPv6 = hostname.includes(":");
            if (isIPv4 || isIPv6) {
                // IP addresses don't have subdomains, skip this logic
            }
            else {
                // Resolve the registrable domain via the public suffix list rather than
                // taking the last two labels: multi-part suffixes (co.uk, co.il, co.jp,
                // com.au) have three labels, so slicing produced the bare suffix and we
                // ended up requesting https://co.il/sitemap.xml, which cannot resolve.
                // Returns null for hosts with no registrable domain (e.g. localhost).
                const mainDomain = (0, url_utils_1.extractBaseDomain)(url);
                // Only worth a second fetch when the host actually *is* a subdomain of
                // that domain; skip www, which serves the same sitemap.
                if (mainDomain &&
                    mainDomain !== hostname &&
                    hostname !== `www.${mainDomain}`) {
                    const mainDomainUrl = `${urlObj.protocol}//${mainDomain}`;
                    const mainDomainSitemapUrl = `${mainDomainUrl}/sitemap.xml`;
                    try {
                        // Get all links from the main domain's sitemap
                        sitemapCount += await (0, sitemap_1.getLinksFromSitemap)({
                            sitemapUrl: mainDomainSitemapUrl,
                            urlsHandler(urls) {
                                return urlsHandler(urls.filter(link => {
                                    try {
                                        const linkUrl = new url_1.URL(link);
                                        // Match on a DNS-label boundary. A bare endsWith also
                                        // accepts sibling hosts that merely share a suffix of the
                                        // final label — evilcrm.danetcomm.co.il "ends with"
                                        // crm.danetcomm.co.il — which would pull an unrelated
                                        // host into this crawl. Real child subdomains still pass.
                                        return (linkUrl.hostname === hostname ||
                                            linkUrl.hostname.endsWith(`.${hostname}`));
                                    }
                                    catch { }
                                }));
                            },
                            mode: "fire-engine",
                            maxAge,
                            zeroDataRetention: this.zeroDataRetention,
                            location: this.location,
                            headers: this.headers,
                        }, this.logger, this.jobId, this.sitemapsHit, abort, mock);
                    }
                    catch (error) {
                        if (error instanceof error_1.ScrapeJobTimeoutError) {
                            throw error;
                        }
                        else {
                            this.logger.debug(`Failed to fetch main domain sitemap from ${mainDomainSitemapUrl}`, { method: "tryFetchSitemapLinks", mainDomainSitemapUrl, error });
                        }
                    }
                }
            }
        }
        catch (error) {
            if (error instanceof error_1.ScrapeJobTimeoutError) {
                throw error;
            }
            else {
                this.logger.debug(`Error processing main domain sitemap`, {
                    method: "tryFetchSitemapLinks",
                    url,
                    error,
                });
            }
        }
        // If no sitemap found yet, try the baseUrl as a last resort
        if (sitemapCount === 0) {
            const baseUrlSitemap = `${this.baseUrl}/sitemap.xml`;
            try {
                sitemapCount += await (0, sitemap_1.getLinksFromSitemap)({
                    sitemapUrl: baseUrlSitemap,
                    urlsHandler,
                    mode: "fire-engine",
                    maxAge,
                    zeroDataRetention: this.zeroDataRetention,
                    location: this.location,
                    headers: this.headers,
                }, this.logger, this.jobId, this.sitemapsHit, abort, mock);
            }
            catch (error) {
                if (error instanceof error_1.ScrapeJobTimeoutError) {
                    throw error;
                }
                else {
                    this.logger.debug(`Failed to fetch sitemap from ${baseUrlSitemap}`, {
                        method: "tryFetchSitemapLinks",
                        sitemapUrl: baseUrlSitemap,
                        error,
                    });
                    if (error instanceof axios_1.AxiosError && error.response?.status === 404) {
                        // ignore 404
                    }
                    else {
                        sitemapCount += await (0, sitemap_1.getLinksFromSitemap)({
                            sitemapUrl: baseUrlSitemap,
                            urlsHandler,
                            mode: "fire-engine",
                            maxAge,
                            zeroDataRetention: this.zeroDataRetention,
                            location: this.location,
                            headers: this.headers,
                        }, this.logger, this.jobId, this.sitemapsHit, abort, mock);
                    }
                }
            }
        }
        if (this.sitemapsHit.size >= exports.SITEMAP_LIMIT) {
            this.logger.warn("Sitemap limit hit!", {
                crawlId: this.jobId,
                url: this.baseUrl,
            });
        }
        this.logger.debug("Finished trying to fetch sitemap links", {
            method: "tryFetchSitemapLinks",
            originalUrl: url,
            sitemapUrl,
            linksFound: sitemapCount,
            totalSitemapsHit: this.sitemapsHit.size,
        });
        return sitemapCount;
    }
}
exports.WebCrawler = WebCrawler;
//# sourceMappingURL=crawler.js.map