"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.searxng_search = searxng_search;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
const logger_1 = require("../lib/logger");
async function searxng_search(q, options) {
    const resultsPerPage = 20;
    const requestedResults = Math.max(options.num_results, 0);
    const startPage = options.page ?? 1;
    const url = config_1.config.SEARXNG_ENDPOINT;
    const cleanedUrl = url.endsWith("/") ? url.slice(0, -1) : url;
    const finalUrl = cleanedUrl + "/search";
    const fetchPage = async (page) => {
        const params = {
            q: q,
            language: options.lang,
            // gl: options.country, //not possible with SearXNG
            // location: options.location, //not possible with SearXNG
            // num: options.num_results, //not possible with SearXNG
            engines: config_1.config.SEARXNG_ENGINES ?? "",
            categories: config_1.config.SEARXNG_CATEGORIES ?? "",
            pageno: page,
            format: "json",
        };
        const response = await axios_1.default.get(finalUrl, {
            headers: {
                "Content-Type": "application/json",
            },
            params: params,
            timeout: options.timeout,
            signal: options.signal,
        });
        const data = response.data;
        if (data && Array.isArray(data.results)) {
            return data.results.map((a) => ({
                url: a.url,
                title: a.title,
                description: a.content,
            }));
        }
        return [];
    };
    try {
        if (requestedResults === 0) {
            return [];
        }
        const pagesToFetch = Math.max(1, Math.ceil(requestedResults / resultsPerPage));
        let results = [];
        for (let pageOffset = 0; pageOffset < pagesToFetch; pageOffset += 1) {
            const pageResults = await fetchPage(startPage + pageOffset);
            if (pageResults.length === 0) {
                break;
            }
            results = results.concat(pageResults);
            if (results.length >= requestedResults) {
                break;
            }
        }
        return results.slice(0, requestedResults);
    }
    catch (error) {
        logger_1.logger.error(`There was an error searching for content`, { error });
        return [];
    }
}
//# sourceMappingURL=searxng.js.map