"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NuqFdbSweeper = void 0;
const crypto_1 = require("crypto");
const logger_1 = require("../../../lib/logger");
const client_1 = require("./client");
const keyspace_1 = require("./keyspace");
const ops_1 = require("./ops");
const SWEEP_LOCK_TTL_MS = 15_000;
const SWEEP_BATCH = 50;
const STALL_FAILED_REASON = 'SCRAPE_TIMEOUT|{"message":"NuQ job stalled after 10 lock lease expirations and was stopped to avoid endless retries."}';
function keyAfter(key) {
    return Buffer.concat([key, Buffer.from([0])]);
}
function entryFromMeta(id, meta) {
    return {
        i: id,
        o: meta.o,
        g: meta.g,
        k: meta.k,
        p: meta.p,
        f: meta.f,
        c: meta.c,
        to: meta.to,
    };
}
function emptySweepLagStats() {
    return {
        dueCount: 0,
        processedCount: 0,
        oldestOverdueAgeMs: 0,
        saturatedBucketCount: 0,
        durationMs: 0,
    };
}
function addDueKeysToLagStats(stats, ks, due, now) {
    stats.dueCount += due.length;
    if (due.length >= SWEEP_BATCH)
        stats.saturatedBucketCount++;
    for (const [key] of due) {
        const dueAt = Number(ks.unpackId(key, 1));
        if (Number.isFinite(dueAt)) {
            stats.oldestOverdueAgeMs = Math.max(stats.oldestOverdueAgeMs, now - dueAt);
        }
    }
}
function logSweepLag(logger, queue, index, stats) {
    if (stats.dueCount === 0 && stats.saturatedBucketCount === 0)
        return;
    logger[stats.saturatedBucketCount > 0 ? "warn" : "debug"]("NuQ FDB sweeper lag", {
        canonicalLog: "nuq-fdb/sweeper_lag",
        queueName: queue.queueName,
        index,
        timeBuckets: keyspace_1.TIME_BUCKETS,
        sweepBatch: SWEEP_BATCH,
        ...stats,
    });
}
// One sweeper services all queues against the same FDB cluster. Each queue
// gets its own pass; a leased singleton lock (held on the first queue's
// keyspace) keeps multiple candidate processes from sweeping concurrently.
class NuqFdbSweeper {
    queues;
    externalSlots;
    sweeperId = (0, crypto_1.randomUUID)();
    loop = null;
    running = false;
    constructor(queues, externalSlots = []) {
        this.queues = queues;
        this.externalSlots = externalSlots;
    }
    get db() {
        return (0, client_1.getNuqFdbDatabase)();
    }
    get lockKs() {
        return this.queues[0].ks;
    }
    async tryAcquireLock(now = Date.now()) {
        return await this.db.doTn(async (tn) => {
            const rec = (0, keyspace_1.decodeJson)(await tn.get(this.lockKs.sweeperLock()));
            if (rec && rec.x > now && rec.w !== this.sweeperId)
                return false;
            tn.set(this.lockKs.sweeperLock(), (0, keyspace_1.encodeJson)({ w: this.sweeperId, x: now + SWEEP_LOCK_TTL_MS }));
            return true;
        });
    }
    // Runs one full sweep over all queues. Exposed for tests; production uses
    // start(), which wraps this in the singleton lock loop.
    async sweepOnce(logger = logger_1.logger) {
        const now = Date.now();
        for (const queue of this.queues) {
            await this.sweepLeases(queue, now, logger);
            await this.sweepBacklogTimeouts(queue, now, logger);
            await this.sweepDelayed(queue, now, logger);
            await this.sweepGroupFinishTasks(queue, now, logger);
            await this.sweepGroupCancelTasks(queue, now, logger);
            await this.sweepTeamRaiseTasks(queue, now, logger);
            await this.sweepKeyRaiseTasks(queue, now, logger);
            await this.sweepJobExpiry(queue, now, logger);
            await this.sweepGroupExpiry(queue, now, logger);
        }
        for (const slots of this.externalSlots) {
            await slots.sweepExpired(now, keyspace_1.TIME_BUCKETS);
        }
    }
    start(intervalMs = 1000, logger = logger_1.logger) {
        if (this.loop)
            return;
        this.loop = setInterval(async () => {
            if (this.running)
                return;
            this.running = true;
            try {
                if (await this.tryAcquireLock()) {
                    await this.sweepOnce(logger);
                }
            }
            catch (error) {
                logger.warn("NuQ FDB sweeper tick failed", {
                    module: "nuq-fdb/sweeper",
                    error,
                });
            }
            finally {
                this.running = false;
            }
        }, intervalMs);
    }
    stop() {
        if (this.loop) {
            clearInterval(this.loop);
            this.loop = null;
        }
    }
    // === Lease expiry: requeue stalled jobs, fail them after MAX_STALLS
    async sweepLeases(queue, now, logger) {
        const startedAt = Date.now();
        const ks = queue.ks;
        const stats = emptySweepLagStats();
        for (let b = 0; b < keyspace_1.TIME_BUCKETS; b++) {
            const r = ks.leaseScanRange(b, now);
            const due = await this.db.doTn(async (tn) => tn.snapshot().getRangeAll(r.begin, r.end, { limit: SWEEP_BATCH }));
            addDueKeysToLagStats(stats, ks, due, now);
            for (const [key, value] of due) {
                const id = ks.unpackId(key);
                const lease = (0, keyspace_1.decodeJson)(value);
                await this.db.doTn(async (tn) => {
                    const txc = (0, ops_1.newTxContext)();
                    const st = (0, keyspace_1.decodeJson)(await tn.get(ks.jobStatus(id)));
                    // stale entries: job moved on (renewal, finish) or was reaped already
                    if (!st || st.s !== "active" || st.l !== lease?.l) {
                        tn.clear(key);
                        return;
                    }
                    if (st.e !== undefined && st.e > now) {
                        // renewed after our snapshot; the old index entry is what expired
                        tn.clear(key);
                        return;
                    }
                    const meta = (0, keyspace_1.decodeJson)(await tn.get(ks.jobMeta(id)));
                    tn.clear(key);
                    if (!meta)
                        return;
                    const entry = entryFromMeta(id, meta);
                    if (st.st < ops_1.MAX_STALLS) {
                        // requeue directly to ready -- the job retains its slots
                        (0, ops_1.pushReady)(tn, ks, entry, txc);
                        (0, ops_1.setStatusQueued)(tn, ks, id, st.st + 1);
                        if (meta.g && meta.f & keyspace_1.F_COUNTABLE) {
                            (0, ops_1.bumpGroupStatusCount)(tn, ks, meta.g, "active", -1);
                            (0, ops_1.bumpGroupStatusCount)(tn, ks, meta.g, "queued", 1);
                        }
                    }
                    else {
                        tn.set(ks.jobStatus(id), (0, keyspace_1.encodeJson)({
                            s: "failed",
                            st: st.st,
                            fa: now,
                        }));
                        tn.set(ks.jobFailedReason(id), Buffer.from(STALL_FAILED_REASON, "utf8"));
                        if (meta.g && meta.f & keyspace_1.F_GACC && queue.groupOps) {
                            await queue.groupOps.terminalAccounting(tn, meta.g, id, "active", "failed", !!(meta.f & keyspace_1.F_COUNTABLE), now, txc);
                        }
                        await (0, ops_1.releaseSlotsAndPromote)(tn, ks, entry, { team: true, key: true, crawl: true }, now, txc);
                        if (!meta.g) {
                            tn.set(ks.jobExpiry((0, keyspace_1.timeBucket)(id), now + ops_1.FAILED_STANDALONE_RETENTION_MS, id), ops_1.EMPTY);
                        }
                    }
                });
                stats.processedCount++;
            }
        }
        stats.durationMs = Date.now() - startedAt;
        logSweepLag(logger, queue, "lease", stats);
    }
    // === Backlog timeouts: silently drop pending jobs past their deadline
    async sweepBacklogTimeouts(queue, now, logger) {
        const startedAt = Date.now();
        const ks = queue.ks;
        const stats = emptySweepLagStats();
        for (let b = 0; b < keyspace_1.TIME_BUCKETS; b++) {
            const r = ks.backlogTimeoutScanRange(b, now);
            const due = await this.db.doTn(async (tn) => tn.snapshot().getRangeAll(r.begin, r.end, { limit: SWEEP_BATCH }));
            addDueKeysToLagStats(stats, ks, due, now);
            for (const [key] of due) {
                const id = ks.unpackId(key);
                await this.db.doTn(async (tn) => {
                    const txc = (0, ops_1.newTxContext)();
                    tn.clear(key);
                    const st = (0, keyspace_1.decodeJson)(await tn.get(ks.jobStatus(id)));
                    if (!st || st.s !== "pending" || !st.loc)
                        return;
                    const meta = (0, keyspace_1.decodeJson)(await tn.get(ks.jobMeta(id)));
                    if (!meta)
                        return;
                    (0, ops_1.clearPendingPlacement)(tn, ks, id, meta.o, meta.g, meta.k, st.loc, meta.to);
                    if (st.loc.k !== "gq") {
                        await (0, ops_1.releaseSlotsAndPromote)(tn, ks, entryFromMeta(id, meta), { team: false, key: st.loc.k === "tq", crawl: true }, now, txc);
                    }
                    if (meta.g && meta.f & keyspace_1.F_GACC && queue.groupOps) {
                        tn.clear(ks.groupJob(meta.g, id));
                        tn.add(ks.groupRemaining(meta.g), ops_1.MINUS_ONE);
                        if (meta.f & keyspace_1.F_COUNTABLE)
                            (0, ops_1.bumpGroupStatusCount)(tn, ks, meta.g, "pending", -1);
                        tn.set(ks.taskGroupFinish(meta.g), ops_1.EMPTY);
                    }
                    (0, ops_1.deleteJobRecords)(tn, ks, id);
                });
                stats.processedCount++;
            }
        }
        stats.durationMs = Date.now() - startedAt;
        logSweepLag(logger, queue, "backlog_timeout", stats);
    }
    // === Delayed (crawl delay) promotions
    async sweepDelayed(queue, now, logger) {
        const startedAt = Date.now();
        const ks = queue.ks;
        const stats = emptySweepLagStats();
        for (let b = 0; b < keyspace_1.TIME_BUCKETS; b++) {
            const r = ks.delayedScanRange(b, now);
            const due = await this.db.doTn(async (tn) => tn.snapshot().getRangeAll(r.begin, r.end, { limit: SWEEP_BATCH }));
            addDueKeysToLagStats(stats, ks, due, now);
            for (const [key, value] of due) {
                const e = (0, keyspace_1.decodeJson)(value);
                if (!e)
                    continue;
                await this.db.doTn(async (tn) => {
                    const txc = (0, ops_1.newTxContext)();
                    const st = (0, keyspace_1.decodeJson)(await tn.get(ks.jobStatus(e.i)));
                    tn.clear(key);
                    if (!st || st.s !== "pending" || st.loc?.k !== "dl")
                        return;
                    // the job already holds its crawl slot; admit through the key gate
                    // and then the team gate
                    await (0, ops_1.admitThroughGates)(tn, ks, e, txc);
                });
                stats.processedCount++;
            }
        }
        stats.durationMs = Date.now() - startedAt;
        logSweepLag(logger, queue, "delay", stats);
    }
    // === Group finish detection (backstop for the inline path)
    async sweepGroupFinishTasks(queue, now, logger) {
        if (!queue.groupOps)
            return;
        const ks = queue.ks;
        const r = ks.taskGroupFinishRange();
        const tasks = await this.db.doTn(async (tn) => tn.snapshot().getRangeAll(r.begin, r.end, { limit: 200 }));
        for (const [key] of tasks) {
            const gid = ks.unpackId(key);
            await this.db.doTn(async (tn) => {
                const txc = (0, ops_1.newTxContext)();
                // normal read so a concurrent finisher's decrement forces a retry --
                // clearing the task may not race with the group draining to zero
                const rem = (0, keyspace_1.decodeI64)(await tn.get(ks.groupRemaining(gid)));
                if (rem > 0) {
                    tn.clear(key);
                    return;
                }
                await queue.groupOps.tryCompleteGroup(tn, gid, now, txc);
            });
        }
    }
    // === Lazy group cancellation cleanup
    async sweepGroupCancelTasks(queue, now, logger) {
        if (!queue.groupOps)
            return;
        const ks = queue.ks;
        const r = ks.taskGroupCancelRange();
        const tasks = await this.db.doTn(async (tn) => tn.snapshot().getRangeAll(r.begin, r.end, { limit: 20 }));
        for (const [key] of tasks) {
            const gid = ks.unpackId(key);
            let exhausted = false;
            let begin = null;
            // clean pending members in batches until none remain
            for (let rounds = 0; rounds < 50 && !exhausted; rounds++) {
                const result = await this.db.doTn(async (tn) => {
                    const jr = ks.groupJobRange(gid);
                    const rangeBegin = begin ?? jr.begin;
                    const members = await tn
                        .snapshot()
                        .getRangeAll(rangeBegin, jr.end, { limit: 500 });
                    let cleaned = 0;
                    for (const [mKey, mValue] of members) {
                        const gj = (0, keyspace_1.decodeJson)(mValue);
                        if (!gj || gj.s !== "pending")
                            continue;
                        if (cleaned >= SWEEP_BATCH) {
                            return { exhausted: false, nextBegin: rangeBegin };
                        }
                        const id = ks.unpackId(mKey);
                        const st = (0, keyspace_1.decodeJson)(await tn.get(ks.jobStatus(id)));
                        if (!st || st.s !== "pending" || !st.loc) {
                            // moved on; fix the index lazily
                            continue;
                        }
                        const meta = (0, keyspace_1.decodeJson)(await tn.get(ks.jobMeta(id)));
                        if (!meta)
                            continue;
                        (0, ops_1.clearPendingPlacement)(tn, ks, id, meta.o, meta.g, meta.k, st.loc, meta.to);
                        // team-/key-pending/delayed members hold a crawl slot; the group
                        // is cancelled so there is nothing to promote -- just release it
                        if (st.loc.k !== "gq" && meta.f & keyspace_1.F_CRAWL_GATED) {
                            tn.add(ks.groupCrawlActive(gid), ops_1.MINUS_ONE);
                        }
                        // team-pending members also hold a key slot; release it and let
                        // the raise task hand it to key-pending jobs outside this group
                        if (st.loc.k === "tq" && meta.k && meta.f & keyspace_1.F_KEY_GATED) {
                            tn.add(ks.keyActive(meta.k), ops_1.MINUS_ONE);
                            tn.set(ks.taskKeyRaise(meta.k), ops_1.EMPTY);
                        }
                        tn.clear(mKey);
                        tn.add(ks.groupRemaining(gid), ops_1.MINUS_ONE);
                        if (meta.f & keyspace_1.F_COUNTABLE)
                            (0, ops_1.bumpGroupStatusCount)(tn, ks, gid, "pending", -1);
                        (0, ops_1.deleteJobRecords)(tn, ks, id);
                        cleaned++;
                    }
                    const lastKey = members[members.length - 1]?.[0];
                    return {
                        exhausted: members.length < 500,
                        nextBegin: lastKey ? keyAfter(lastKey) : jr.end,
                    };
                });
                exhausted = result.exhausted;
                begin = result.nextBegin;
            }
            if (exhausted) {
                await this.db.doTn(async (tn) => {
                    tn.clear(key);
                    tn.set(ks.taskGroupFinish(gid), ops_1.EMPTY);
                });
            }
        }
    }
    // === Limit raises: drain newly-available slots
    async sweepTeamRaiseTasks(queue, now, logger) {
        const ks = queue.ks;
        const r = ks.taskTeamRaiseRange();
        const tasks = await this.db.doTn(async (tn) => tn.snapshot().getRangeAll(r.begin, r.end, { limit: 50 }));
        for (const [key] of tasks) {
            const tid = ks.unpackId(key);
            const done = await this.db.doTn(async (tn) => {
                const txc = (0, ops_1.newTxContext)();
                const limitBuf = await tn.get(ks.teamLimit(tid));
                const limit = limitBuf ? (0, keyspace_1.decodeI64)(limitBuf) : Infinity;
                const active = (0, keyspace_1.decodeI64)(await tn.get(ks.teamActive(tid)));
                let free = Math.min(Math.max(0, limit - active), 32);
                let promoted = 0;
                while (free > 0) {
                    const e = await (0, ops_1.popTeamPending)(tn, ks, tid);
                    if (!e)
                        break;
                    (0, ops_1.promoteEntryToReady)(tn, ks, e, txc);
                    promoted++;
                    free--;
                }
                if (promoted > 0)
                    (0, ops_1.bumpTeamActive)(tn, ks, tid, promoted);
                // done when no free slots remain or the pending queue is drained
                return free > 0 || limit - active <= 0;
            });
            if (done) {
                await this.db.doTn(async (tn) => tn.clear(key));
            }
        }
    }
    // Key raises admit key-pending heads through the team gate: each promoted
    // job acquires a key slot here and a team slot (or a team-pending place)
    // in admitThroughTeamGate.
    async sweepKeyRaiseTasks(queue, now, logger) {
        const ks = queue.ks;
        const r = ks.taskKeyRaiseRange();
        const tasks = await this.db.doTn(async (tn) => tn.snapshot().getRangeAll(r.begin, r.end, { limit: 50 }));
        for (const [key] of tasks) {
            const kid = ks.unpackId(key);
            const done = await this.db.doTn(async (tn) => {
                const txc = (0, ops_1.newTxContext)();
                const limitBuf = await tn.get(ks.keyLimit(kid));
                const limit = limitBuf ? (0, keyspace_1.decodeI64)(limitBuf) : Infinity;
                const active = (0, keyspace_1.decodeI64)(await tn.get(ks.keyActive(kid)));
                let free = Math.min(Math.max(0, limit - active), 32);
                let promoted = 0;
                while (free > 0) {
                    const e = await (0, ops_1.popKeyPending)(tn, ks, kid);
                    if (!e)
                        break;
                    await (0, ops_1.admitThroughTeamGate)(tn, ks, e, txc);
                    promoted++;
                    free--;
                }
                if (promoted > 0)
                    tn.add(ks.keyActive(kid), (0, keyspace_1.encodeI64)(promoted));
                // done when no free slots remain or the pending queue is drained
                return free > 0 || limit - active <= 0;
            });
            if (done) {
                await this.db.doTn(async (tn) => tn.clear(key));
            }
        }
    }
    // === Record GC
    async sweepJobExpiry(queue, now, logger) {
        const ks = queue.ks;
        for (let b = 0; b < keyspace_1.TIME_BUCKETS; b++) {
            const r = ks.jobExpiryScanRange(b, now);
            const due = await this.db.doTn(async (tn) => tn.snapshot().getRangeAll(r.begin, r.end, { limit: SWEEP_BATCH * 2 }));
            if (due.length === 0)
                continue;
            await this.db.doTn(async (tn) => {
                for (const [key] of due) {
                    const id = ks.unpackId(key);
                    tn.clear(key);
                    const st = (0, keyspace_1.decodeJson)(await tn.get(ks.jobStatus(id)));
                    if (st &&
                        (st.s === "completed" || st.s === "failed" || st.s === "cancelled")) {
                        (0, ops_1.deleteJobRecords)(tn, ks, id);
                    }
                }
            });
        }
    }
    async sweepGroupExpiry(queue, now, logger) {
        if (!queue.groupOps)
            return;
        const ks = queue.ks;
        const r = ks.groupExpiryScanRange(now);
        const due = await this.db.doTn(async (tn) => tn.snapshot().getRangeAll(r.begin, r.end, { limit: 20 }));
        for (const [key] of due) {
            const gid = ks.unpackId(key);
            // delete member job records in batches, then the group's own keyspace
            let drained = false;
            for (let rounds = 0; rounds < 200 && !drained; rounds++) {
                drained = await this.db.doTn(async (tn) => {
                    const jr = ks.groupJobRange(gid);
                    const members = await tn
                        .snapshot()
                        .getRangeAll(jr.begin, jr.end, { limit: 200 });
                    for (const [mKey] of members) {
                        const id = ks.unpackId(mKey);
                        (0, ops_1.deleteJobRecords)(tn, ks, id);
                        tn.clear(mKey);
                    }
                    return members.length < 200;
                });
            }
            await this.db.doTn(async (tn) => {
                const g = (0, keyspace_1.decodeJson)(await tn.get(ks.groupMeta(gid)));
                // the crawl-finished job for this group lives in the finished queue
                const fjobBuf = await tn.get(ks.groupFinishedJob(gid));
                if (fjobBuf && queue.groupOps.finishedKs) {
                    const fid = fjobBuf.toString("utf8");
                    (0, ops_1.deleteJobRecords)(tn, queue.groupOps.finishedKs, fid);
                }
                const gr = ks.groupRange(gid);
                tn.clearRange(gr.begin, gr.end);
                if (g)
                    tn.clear(ks.ongoingGroup(g.o, gid));
                tn.clear(ks.taskGroupFinish(gid));
                tn.clear(ks.taskGroupCancel(gid));
                tn.clear(key);
            });
        }
    }
}
exports.NuqFdbSweeper = NuqFdbSweeper;
//# sourceMappingURL=sweeper.js.map