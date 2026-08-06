"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCrawlProgress = getCrawlProgress;
exports.hasMoreCrawlResultPages = hasMoreCrawlResultPages;
function getCrawlProgress(stats) {
    const completed = stats.completed ?? 0;
    const failed = stats.failed ?? 0;
    return {
        completed,
        failed,
        total: completed +
            failed +
            (stats.active ?? 0) +
            (stats.queued ?? 0) +
            (stats.backlog ?? 0),
    };
}
function hasMoreCrawlResultPages({ completed, start, iteratedOver, status, }) {
    // Failed jobs contribute to total progress but never produce result documents.
    // Pagination must therefore be based on completed jobs, or a terminal crawl
    // with failures would keep returning the same empty `next` page forever.
    return completed > start + iteratedOver || status === "scraping";
}
//# sourceMappingURL=crawl-progress.js.map