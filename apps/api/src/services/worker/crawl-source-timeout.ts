/**
 * Apply the crawl-source deadline without mutating the stored options shared
 * by subsequently discovered pages.
 */
export function crawlSourceScrapeOptions<T extends { timeout?: number }>(
  options: T,
  crawlerOptions: unknown,
): T {
  const initialScrapeTimeout = Number(
    (crawlerOptions as { initialScrapeTimeout?: unknown } | null)
      ?.initialScrapeTimeout,
  );
  if (
    !Number.isSafeInteger(initialScrapeTimeout) ||
    initialScrapeTimeout < 1000
  ) {
    return { ...options } as T;
  }
  return { ...options, timeout: initialScrapeTimeout } as T;
}
