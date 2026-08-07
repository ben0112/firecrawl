import { randomUUID } from "crypto";
import { Pool } from "pg";
import { config } from "../config";
import { nuqShutdown, scrapeQueue } from "../services/worker/nuq";

const describeIf = config.NUQ_DATABASE_URL ? describe : describe.skip;

describeIf("NuQ Postgres queue", () => {
  let cleanupPool: Pool;
  const ids: string[] = [];

  beforeAll(() => {
    cleanupPool = new Pool({
      connectionString: config.NUQ_DATABASE_URL,
      application_name: "nuq-postgres-test",
    });
  });

  afterEach(async () => {
    if (ids.length === 0) return;
    await cleanupPool.query(
      "DELETE FROM nuq.queue_scrape_backlog WHERE id = ANY($1::uuid[])",
      [ids],
    );
    await cleanupPool.query(
      "DELETE FROM nuq.queue_scrape WHERE id = ANY($1::uuid[])",
      [ids],
    );
    ids.length = 0;
  });

  afterAll(async () => {
    await cleanupPool.end();
    await nuqShutdown();
  });

  function scrapeData() {
    return {
      mode: "single_urls",
      url: "https://example.com",
      team_id: randomUUID(),
    } as any;
  }

  test("single backlogged inserts report backlog status", async () => {
    const addJobId = randomUUID();
    const addJobIfNotExistsId = randomUUID();
    ids.push(addJobId, addJobIfNotExistsId);

    await expect(
      scrapeQueue.addJob(addJobId, scrapeData(), {
        backlogged: true,
        backloggedTimesOutAt: new Date(Date.now() + 60_000),
      }),
    ).resolves.toMatchObject({
      id: addJobId,
      status: "backlog",
    });

    await expect(
      scrapeQueue.addJobIfNotExists(addJobIfNotExistsId, scrapeData(), {
        backlogged: true,
        backloggedTimesOutAt: new Date(Date.now() + 60_000),
      }),
    ).resolves.toMatchObject({
      id: addJobIfNotExistsId,
      status: "backlog",
    });

    await expect(
      scrapeQueue.addJobIfNotExists(addJobIfNotExistsId, scrapeData(), {
        backlogged: true,
        backloggedTimesOutAt: new Date(Date.now() + 60_000),
      }),
    ).resolves.toBeNull();
  });

  test("job completion stores nested JSON containing null bytes", async () => {
    const id = randomUUID();
    const lock = randomUUID();
    ids.push(id);

    await scrapeQueue.addJob(id, scrapeData(), {});
    await cleanupPool.query(
      "UPDATE nuq.queue_scrape SET status = 'active'::nuq.job_status, lock = $2, locked_at = now() WHERE id = $1",
      [id, lock],
    );

    await expect(
      scrapeQueue.jobFinish(id, lock, {
        markdown: "before\u0000after",
        nested: ["\u0000first", { "nul\u0000key": "last\u0000" }],
        escaped: String.raw`literal\u0000text`,
      }),
    ).resolves.toBe(true);

    const result = await cleanupPool.query(
      "SELECT status, returnvalue FROM nuq.queue_scrape WHERE id = $1",
      [id],
    );
    expect(result.rows[0]).toEqual({
      status: "completed",
      returnvalue: {
        markdown: "beforeafter",
        nested: ["first", { nulkey: "last" }],
        escaped: String.raw`literal\u0000text`,
      },
    });
  });

  test("cancel settlement fails queued and backlog jobs without touching active work", async () => {
    const groupId = randomUUID();
    const queuedId = randomUUID();
    const activeId = randomUUID();
    const backlogIds = [randomUUID(), randomUUID()];
    ids.push(queuedId, activeId, ...backlogIds);
    const data = { ...scrapeData(), crawl_id: groupId };

    await scrapeQueue.addJob(queuedId, data, { groupId });
    await scrapeQueue.addJob(activeId, data, { groupId });
    await cleanupPool.query(
      "UPDATE nuq.queue_scrape SET status = 'active'::nuq.job_status, lock = $2, locked_at = now() WHERE id = $1",
      [activeId, randomUUID()],
    );
    for (const id of backlogIds) {
      await scrapeQueue.addJob(id, data, {
        groupId,
        backlogged: true,
        backloggedTimesOutAt: new Date(Date.now() + 60_000),
      });
    }

    await expect(scrapeQueue.failPendingGroupJobs(groupId, "cancelled by test")).resolves.toEqual({
      backlogged: 2,
      queued: 1,
    });

    const result = await cleanupPool.query(
      "SELECT id::text, status::text, failedreason FROM nuq.queue_scrape WHERE id = ANY($1::uuid[]) ORDER BY id::text",
      [ids],
    );
    expect(result.rows.filter(row => row.status === "failed")).toHaveLength(3);
    expect(result.rows.filter(row => row.status === "active")).toHaveLength(1);
    expect(result.rows.filter(row => row.status === "failed").every(row => row.failedreason === "cancelled by test")).toBe(true);
    const backlog = await cleanupPool.query(
      "SELECT COUNT(*)::integer AS count FROM nuq.queue_scrape_backlog WHERE group_id = $1",
      [groupId],
    );
    expect(backlog.rows[0].count).toBe(0);
  });
});
