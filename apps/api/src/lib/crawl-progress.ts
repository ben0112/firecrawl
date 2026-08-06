export type CrawlNumericStats = {
  completed?: number;
  failed?: number;
  active?: number;
  queued?: number;
  backlog?: number;
};

export function getCrawlProgress(stats: CrawlNumericStats) {
  const completed = stats.completed ?? 0;
  const failed = stats.failed ?? 0;
  return {
    completed,
    failed,
    total:
      completed +
      failed +
      (stats.active ?? 0) +
      (stats.queued ?? 0) +
      (stats.backlog ?? 0),
  };
}

export function hasMoreCrawlResultPages({
  completed,
  start,
  iteratedOver,
  status,
}: {
  completed: number;
  start: number;
  iteratedOver: number;
  status: "completed" | "scraping" | "cancelled" | "failed";
}) {
  // Failed jobs contribute to total progress but never produce result documents.
  // Pagination must therefore be based on completed jobs, or a terminal crawl
  // with failures would keep returning the same empty `next` page forever.
  return completed > start + iteratedOver || status === "scraping";
}
