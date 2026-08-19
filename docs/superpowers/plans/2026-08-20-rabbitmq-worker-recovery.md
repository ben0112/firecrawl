# RabbitMQ Worker Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a transient RabbitMQ completion-notification failure from killing a NuQ Worker, and guarantee that a Core child-service failure makes the harness exit within 30 seconds so Docker can restart it.

**Architecture:** PostgreSQL remains the authoritative NuQ state. A small RabbitMQ notification helper retries one derived completion notification and then degrades to a warning without changing the committed job result. A separate bounded child-process terminator owns SIGTERM/SIGKILL timing and is used by the harness for both normal and failure shutdown.

**Tech Stack:** TypeScript, Node.js child processes, amqplib, Vitest, Docker.

---

### Task 1: Make RabbitMQ completion notification best-effort

**Files:**
- Create: `apps/api/src/services/worker/nuq-rabbitmq-notification.ts`
- Create: `apps/api/src/services/worker/nuq-rabbitmq-notification.test.ts`
- Modify: `apps/api/src/services/worker/nuq.ts`

- [ ] **Step 1: Write the failing notification tests**

Create tests for a public helper with injected sender access:

```ts
it("reconnects once after ECONNRESET and resolves", async () => {
  const attempts: string[] = [];
  const result = await sendRabbitMqJobEndBestEffort({
    queueName: "nuq.queue_scrape",
    listenChannelId: "listener",
    jobId: "job-1",
    status: "completed",
    startSender: async () => attempts.push("start"),
    send: () => {
      attempts.push("send");
      if (attempts.filter(value => value === "send").length === 1) {
        throw Object.assign(new Error("write ECONNRESET"), { code: "ECONNRESET" });
      }
    },
    resetSender: () => attempts.push("reset"),
    warn: () => attempts.push("warn"),
  });
  expect(result).toBe(true);
  expect(attempts).toEqual(["start", "send", "reset", "start", "send"]);
});

it("keeps the durable result when both sends fail", async () => {
  let warnings = 0;
  const result = await sendRabbitMqJobEndBestEffort({
    queueName: "nuq.queue_scrape",
    listenChannelId: "listener",
    jobId: "job-2",
    status: "failed",
    startSender: async () => undefined,
    send: () => { throw new Error("connection closed"); },
    resetSender: () => undefined,
    warn: () => { warnings += 1; },
  });
  expect(result).toBe(false);
  expect(warnings).toBe(1);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
pnpm --dir apps/api exec vitest run src/services/worker/nuq-rabbitmq-notification.test.ts
```

Expected: FAIL because `nuq-rabbitmq-notification.ts` and the helper do not exist.

- [ ] **Step 3: Implement the minimal helper**

Implement exactly two attempts. Each attempt calls `startSender()` before `send()`. On failure call `resetSender()`. After the second failure call `warn()` with only queue name, job ID, status, attempt count, error name/code/message; return `false`. Return `true` after a successful send.

- [ ] **Step 4: Wire NuQ to the helper**

Replace direct `sendToQueue()` in `sendJobEnd()` with the helper. The callbacks must read `this.sender` at call time, reset it on failure, and preserve the existing queue name, listener ID, correlation ID, and UTF-8 status body. `jobFinish()` and `jobFail()` continue returning the PostgreSQL update result regardless of the helper's boolean result.

- [ ] **Step 5: Run focused GREEN tests**

Run:

```bash
pnpm --dir apps/api exec vitest run \
  src/services/worker/nuq-rabbitmq-notification.test.ts \
  src/__tests__/nuq-postgres.test.ts \
  src/__tests__/nuq-sanitize.test.ts
```

Expected: all selected tests pass with no unhandled rejection.

### Task 2: Bound harness child-process shutdown

**Files:**
- Create: `apps/api/src/lib/bounded-process-termination.ts`
- Create: `apps/api/src/lib/bounded-process-termination.test.ts`
- Modify: `apps/api/src/harness.ts`

- [ ] **Step 1: Write the failing process-termination tests**

Use an `EventEmitter` fake child and injected `sendSignal` callback:

```ts
it("does not force kill a child that closes during grace", async () => {
  const child = fakeChild(101);
  const signals: NodeJS.Signals[] = [];
  const pending = terminateChildProcess(child, {
    timeoutMs: 20,
    sendSignal: (_pid, signal) => { signals.push(signal); },
  });
  child.emit("close", 0);
  await pending;
  expect(signals).toEqual(["SIGTERM"]);
});

it("force kills and resolves when a child ignores SIGTERM", async () => {
  const child = fakeChild(102);
  const signals: NodeJS.Signals[] = [];
  await terminateChildProcess(child, {
    timeoutMs: 10,
    sendSignal: (_pid, signal) => { signals.push(signal); },
  });
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
pnpm --dir apps/api exec vitest run src/lib/bounded-process-termination.test.ts
```

Expected: FAIL because the module and function do not exist.

- [ ] **Step 3: Implement bounded termination**

Export `terminateChildProcess(child, options)` with defaults `timeoutMs=30_000` and Linux/macOS process-group signalling through `process.kill(-pid, signal)`. Send SIGTERM once, resolve on `close`/`error`, and on timeout send SIGKILL then resolve. Preserve Windows support by using the existing `taskkill /t /f` branch through an injected/default launcher.

- [ ] **Step 4: Wire the harness**

Replace the private unbounded production `terminateProcess()` implementation with the new helper. Keep `stopping` bookkeeping so expected exits resolve rather than become service failures. Both `stopDevelopmentServices()` and `gracefulShutdown()` must pass the same 30-second production bound.

- [ ] **Step 5: Run focused GREEN tests**

Run:

```bash
pnpm --dir apps/api exec vitest run src/lib/bounded-process-termination.test.ts
```

Expected: both graceful and forced paths pass; fake timers/handles are fully cleaned up.

### Task 3: Verify the complete Core candidate

**Files:**
- Modify only if test-driven fixes require it: files from Tasks 1-2

- [ ] **Step 1: Run the nine-file production-focused suite**

Run the existing Docker-compatible focused suite that previously produced 81/81 passing tests, adding the two new test files. Expected: all files pass.

- [ ] **Step 2: Run TypeScript and formatting checks**

Run:

```bash
pnpm --dir apps/api run build
pnpm --dir apps/api exec prettier --check \
  src/services/worker/nuq-rabbitmq-notification.ts \
  src/services/worker/nuq-rabbitmq-notification.test.ts \
  src/lib/bounded-process-termination.ts \
  src/lib/bounded-process-termination.test.ts \
  src/harness.ts \
  src/services/worker/nuq.ts
git diff --check
```

Expected: exit 0 for every command.

- [ ] **Step 3: Commit the implementation**

```bash
git add apps/api/src/services/worker/nuq-rabbitmq-notification.ts \
  apps/api/src/services/worker/nuq-rabbitmq-notification.test.ts \
  apps/api/src/lib/bounded-process-termination.ts \
  apps/api/src/lib/bounded-process-termination.test.ts \
  apps/api/src/harness.ts apps/api/src/services/worker/nuq.ts
git commit -m "fix(queue): recover from RabbitMQ notification failures"
```

- [ ] **Step 4: Build an exact-SHA amd64 image**

Build from `apps/api` with `GIT_SHA=$(git rev-parse HEAD)`. Verify OCI revision, `/app/BUILD_SHA`, capability `coreRevision`, and the new tests from the image/development dependency layer all equal or correspond to the exact commit.

### Task 4: Integrate and deploy

**Files:**
- Production compose reference: `/opt/firecrawl-core/compose.yaml`

- [ ] **Step 1: Push the candidate to the user's main branch**

Verify local HEAD and `origin/main`, then fast-forward push without force. Confirm GitHub main equals the exact implementation commit and required CI concludes success.

- [ ] **Step 2: Publish/transfer the exact amd64 image**

Use the full commit SHA tag. Inspect the production image ID and revision before changing compose.

- [ ] **Step 3: Roll only the Core API container**

Update only the Core API image reference, validate Compose, and recreate the API container. Do not recreate RabbitMQ, Redis, NuQ PostgreSQL, Playwright, UI, or volumes.

- [ ] **Step 4: Verify production recovery and continuity**

Check:

```text
Core capability HTTP 200 and exact coreRevision
UI /healthz 200 and /readyz 200
all containers healthy
formal run completed/queued/running counts continue changing
webui_firecrawl_mutation_leases unknown count = 0
reconciliation-required counts = 0
```

Observe at least five minutes of RabbitMQ/Core logs for worker exits, harness shutdown, missed heartbeats, and API loss. If any gate fails, roll back to the previous exact Core image.
