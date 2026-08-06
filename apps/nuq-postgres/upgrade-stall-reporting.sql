-- Idempotent upgrade for existing NuQ PostgreSQL volumes. Fresh databases get
-- the same definitions from nuq.sql.

SELECT cron.schedule('nuq_queue_scrape_lock_reaper', '15 seconds', $$
  UPDATE nuq.queue_scrape SET status = 'queued'::nuq.job_status, lock = null, locked_at = null, stalls = COALESCE(stalls, 0) + 1 WHERE nuq.queue_scrape.locked_at <= now() - interval '1 minute' AND nuq.queue_scrape.status = 'active'::nuq.job_status AND COALESCE(nuq.queue_scrape.stalls, 0) < 9;
  WITH stallfail AS (UPDATE nuq.queue_scrape SET status = 'failed'::nuq.job_status, lock = null, locked_at = null, stalls = COALESCE(stalls, 0) + 1, finished_at = now(), failedreason = COALESCE(failedreason, 'SCRAPE_TIMEOUT|{"message":"NuQ job stalled after 10 lock lease expirations and was stopped to avoid endless retries."}') WHERE nuq.queue_scrape.locked_at <= now() - interval '1 minute' AND nuq.queue_scrape.status = 'active'::nuq.job_status AND COALESCE(nuq.queue_scrape.stalls, 0) >= 9 RETURNING id)
  SELECT pg_notify('nuq.queue_scrape', (id::text || '|' || 'failed'::text)) FROM stallfail;
$$);

SELECT cron.schedule('nuq_queue_crawl_finished_lock_reaper', '15 seconds', $$
  UPDATE nuq.queue_crawl_finished SET status = 'queued'::nuq.job_status, lock = null, locked_at = null, stalls = COALESCE(stalls, 0) + 1 WHERE nuq.queue_crawl_finished.locked_at <= now() - interval '1 minute' AND nuq.queue_crawl_finished.status = 'active'::nuq.job_status AND COALESCE(nuq.queue_crawl_finished.stalls, 0) < 9;
  WITH stallfail AS (UPDATE nuq.queue_crawl_finished SET status = 'failed'::nuq.job_status, lock = null, locked_at = null, stalls = COALESCE(stalls, 0) + 1, finished_at = now(), failedreason = COALESCE(failedreason, 'SCRAPE_TIMEOUT|{"message":"NuQ job stalled after 10 lock lease expirations and was stopped to avoid endless retries."}') WHERE nuq.queue_crawl_finished.locked_at <= now() - interval '1 minute' AND nuq.queue_crawl_finished.status = 'active'::nuq.job_status AND COALESCE(nuq.queue_crawl_finished.stalls, 0) >= 9 RETURNING id)
  SELECT pg_notify('nuq.queue_crawl_finished', (id::text || '|' || 'failed'::text)) FROM stallfail;
$$);

UPDATE nuq.queue_scrape
SET failedreason = 'SCRAPE_TIMEOUT|{"message":"NuQ job stalled after 10 lock lease expirations and was stopped to avoid endless retries."}'
WHERE status = 'failed'::nuq.job_status
  AND failedreason IS NULL
  AND COALESCE(stalls, 0) >= 10;

UPDATE nuq.queue_crawl_finished
SET failedreason = 'SCRAPE_TIMEOUT|{"message":"NuQ job stalled after 10 lock lease expirations and was stopped to avoid endless retries."}'
WHERE status = 'failed'::nuq.job_status
  AND failedreason IS NULL
  AND COALESCE(stalls, 0) >= 10;
