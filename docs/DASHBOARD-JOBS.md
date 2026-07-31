# How the dashboard runs background, scheduled, and long work

Reference for grafting rankloop's Write feature group (Opportunities queue,
Articles pipeline, Receipts) into the vendored OpenSEO dashboard at
`apps/dashboard/`. All paths below are relative to `apps/dashboard/` unless
noted. Everything here was read from the code as of this commit — quotes are
verbatim.

The one-sentence answer: **the app has exactly four background-work
mechanisms — a single cron trigger, Cloudflare Workflows, Agents-SDK Durable
Objects, and request-piggybacked `waitUntil` work — and only the cron trigger
fails to run outside real Cloudflare.** There are no Cloudflare Queues, no
job tables, no worker threads, no node-cron, no GitHub Actions in this repo.

---

## 1. The three execution environments (what actually runs where)

All three run the same Worker code (`src/server.ts` default export) inside
**workerd**. The differences are in who hosts workerd and who fires triggers.

### Local dev (`pnpm dev` / `pnpm dev:agents`)

`vite dev` with `@cloudflare/vite-plugin` (see `vite.config.ts`):

```ts
cloudflare({ inspectorPort: false, viteEnvironment: { name: "ssr" } }),
```

The plugin boots **miniflare, which spawns a workerd subprocess**. Bindings
come from `wrangler.jsonc`; state persists under `.wrangler/state/v3/` with
subdirectories `cache d1 do kv r2 workflows` (verified on disk). The
`dev:clear-chat` script shows where DO state lives:

```json
"dev:clear-chat": "rm -rf .wrangler/state/v3/do/open-seo-OnboardingChatAgent",
```

`pnpm dev:agents` is **not** related to the Agents SDK — it is the
coding-agent-friendly dev loop (`portless run vite dev 2>&1 | tee
.logs/dev-server.log`, serving at `http://open-seo.localhost:1355`). Don't
confuse the two when naming things.

### Docker self-host (`Dockerfile.selfhost` + `compose.yaml`)

The container is `node:22` (comment in the Dockerfile: "Use the full Node
image so workerd has a working CA trust store for outbound HTTPS"). The
entrypoint (`docker-entrypoint.sh`) runs, in order:

1. `pnpm exec tsx scripts/selfhost-preflight.ts` — env validation ("fails in
   seconds with the exact fix instead of after a multi-minute build")
2. `pnpm run db:migrate:local` — D1 migrations against miniflare's local DB
3. a **fingerprinted conditional `pnpm run build`** (env-prefix vars are
   inlined at build time, so the build runs at container start but is skipped
   when the sha256 of build-relevant env matches the previous start)
4. `exec pnpm exec vite preview --host 0.0.0.0 --port "${PORT:-3001}"`

`vite preview` with the Cloudflare plugin also boots miniflare/workerd (the
plugin's `previewPlugin` calls `startOrUpdateMiniflare` in
`configurePreviewServer`). So **the Docker container is Node hosting workerd**,
serving the prebuilt worker. Persistence is a single named volume:

```yaml
volumes:
  - open_seo_data:/app/.wrangler
```

— which therefore carries D1, KV, R2, DO storage, **and workflow instance
state** across container restarts. The healthcheck probes `/api/health`
(route: `src/routes/api/health.ts`) with `--start-period=300s` to cover
migrations plus the boot-time build. `AUTH_MODE=local_noauth` is forced in
compose.

### Cloudflare (hosted prod, previews, Cloudflare self-host)

Deployed by **Alchemy** (`alchemy.run.ts`), never by these local configs:

> "This config serves local dev and Docker self-host only. All Cloudflare
> deployments — previews, prod, self-host — go through Alchemy
> (alchemy.run.ts), which provisions real resources per stage and never reads
> these ids." — `wrangler.jsonc`

But `wrangler.jsonc` stays the single source of truth for the runtime
contract; Alchemy parses it with zod and re-emits crons, DO classes, and
workflow classes:

```ts
// The worker's runtime contract — compatibility date/flags, crons,
// observability, placement, DO/workflow classes — has one source of truth:
// wrangler.jsonc (what local dev and Docker self-host already run).
```

Two deploy-time facts that matter for long work:

```ts
// Site audits parse and persist batches of HTML inside Workflow steps.
// Paid Workers permit up to five minutes; keep headroom for unusually
// link-heavy sites after bounding page bodies and bulk-writing links.
// Configurable CPU limits are a paid-plan feature, and self-host
// deploys (cloudflare_access) may run on the free plan — which rejects
// them — so those get the plan default instead.
...(authMode === "cloudflare_access" ? {} : { limits: { cpuMs: 300_000 } }),
```

and workflow names are account-scoped, so previews get stage suffixes:

```ts
// Workflow names are ACCOUNT-scoped: prod owns the unsuffixed names;
// previews carry the stage suffix so concurrent stages can't repoint each
// other's workflows (registration is a PUT-as-upsert on the name).
```

Smart Placement is on, with a comment that directly answers "where does
background work run":

```jsonc
// Smart Placement relocates only the `fetch` handler (cron + Workflow runs
// stay at the edge) toward external subrequests — Postgres via Hyperdrive,
// SEO APIs — not D1/KV/R2 bindings, so it's a DB no-op on the D1 default.
"placement": { "mode": "smart" },
```

---

## 2. Mechanism 1 — the cron trigger (rank-check scheduler)

There is exactly one cron, every 15 minutes:

```jsonc
"triggers": { "crons": ["*/15 * * * *"] },
```

and exactly one `scheduled` handler, at the bottom of `src/server.ts`:

```ts
export default {
  fetch,
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ) {
    // Scope a per-request Postgres client for the cron run (no-op in D1 mode).
    await withPgClient(() => runScheduledRankChecks(env));
  },
};
```

Note it ignores `controller.cron` — with a single cron there is nothing to
dispatch on. If rankloop adds more crons (e.g. a nightly signal-compute), the
upstream-consistent move is to add patterns to `triggers.crons` and switch on
`controller.cron` inside this one handler, keeping the body in a
`src/server/features/<feature>/services/scheduledX.ts` service like the
existing one.

### The cron body: `src/server/features/rank-tracking/services/scheduledRankChecks.ts`

The header comment states the contract:

```ts
// Cron body for the `scheduled` Worker handler: start a rank-check run for every
// config that's due. Wrapped in `withPgClient` at the entrypoint (server.ts).
export async function runScheduledRankChecks(env: Env) {
```

Behaviors worth copying exactly:

- **Due-query with a cap** — `getDueConfigsWithOrganization(nowIso)`
  (`RankTrackingRepository.ts`) selects active configs joined to unarchived
  projects `WHERE nextCheckAt <= now` with `.limit(50)`. The cron does not try
  to drain everything in one tick; the 15-minute cadence absorbs backlog.
- **Eager schedule advance** before starting work:
  ```ts
  // Advance nextCheckAt immediately to prevent retry storms if the run fails
  ```
  `computeNextCheckAt` (`src/shared/rank-tracking.ts`) anchors on the previous
  `nextCheckAt` and steps forward "until the result is in the future. This
  prevents schedule drift". Intervals are `daily | weekly | monthly | manual`;
  monthly runs land end-of-month at a randomized 04:00–10:00 UTC minute.
- **Per-config error isolation** — each config is wrapped in its own
  try/catch; a failure logs `[cron] Error processing config ...` and moves on.
- **Hosted-only billing gate** — `if (isHosted && !(await
  customerHasPaidPlan(...))) continue;`. Self-host skips all billing.
- **A synthetic system actor** for billing/analytics context:
  ```ts
  billingCustomer: {
    userId: "system",
    userEmail: "system@openseo.so",
    organizationId: config.organizationId,
    projectId: config.projectId,
  },
  ```
- Lowercase, prefix-tagged status prints:
  `[cron] Skipping config ${config.id} (${config.domain}) — no keywords`,
  `[cron] Started scheduled rank check ${result.runId} for config ...`.

The cron does not do the work itself — it only *starts a Workflow instance
per due config* (`beginRankCheckRun`, below). The cron handler stays
seconds-cheap; minutes-long work lives in Workflows.

### CRITICAL constraint: crons fire only on real Cloudflare

Neither miniflare nor the Vite plugin schedules crons. Wrangler's own bundled
message (verbatim from `node_modules/wrangler/wrangler-dist/cli.js`):

```
Scheduled Workers are not automatically triggered during local development.
To manually trigger a scheduled event, run:
  curl "http://${host}:${port}/cdn-cgi/handler/scheduled"
```

The Vite plugin passes `unsafeTriggerHandlers: true` to miniflare in **both**
dev and preview modes (verified at two sites in
`@cloudflare/vite-plugin/dist/index.mjs`), so the manual endpoint works in
local dev *and* in the Docker container:

```sh
curl "http://127.0.0.1:3001/cdn-cgi/handler/scheduled?cron=*/15+*+*+*+*"
```

But **nothing in the repo calls it**: `compose.yaml` has no sidecar,
`docker-entrypoint.sh` has no loop, and grep confirms zero references to
`cdn-cgi/handler/scheduled` in first-party code. Consequence, stated plainly
because no doc in the repo states it: **scheduled rank checks silently never
run in Docker self-host or local dev.** The UI still offers
Daily/Weekly/Monthly schedules (`RankTrackingConfigModal.tsx`) with no
self-host caveat, and `docs/SELF_HOSTING_DOCKER.md` never mentions the word
"cron". This is an upstream gap, not a design; the app compensates partially
with read-path reconciliation (mechanism 4).

For rankloop's daily routines this means: anything hitched to
`triggers.crons` gets hosted-Cloudflare behavior for free and needs one of
these for self-host parity:

1. a compose sidecar / entrypoint loop curling `/cdn-cgi/handler/scheduled`
   (smallest diff, matches the platform's own escape hatch), or
2. a DO-alarm scheduler via the Agents SDK base class already in the bundle
   (mechanism 3 — alarms *do* fire in miniflare), or
3. accept the same gap upstream accepted.

---

## 3. Mechanism 2 — Cloudflare Workflows (the long-work engine)

This is where all multi-minute work runs. Two workflows are registered:

```jsonc
"workflows": [
  { "name": "site-audit-workflow", "binding": "SITE_AUDIT_WORKFLOW", "class_name": "SiteAuditWorkflow" },
  { "name": "rank-check-workflow", "binding": "RANK_CHECK_WORKFLOW", "class_name": "RankCheckWorkflow" },
],
```

Both classes must ALSO be re-exported from the worker entry — forget this and
deploys break:

```ts
// src/server.ts
export { SiteAuditWorkflow } from "./server/workflows/SiteAuditWorkflow";
export { RankCheckWorkflow } from "./server/workflows/RankCheckWorkflow";
```

Workflows run in miniflare too (`.wrangler/state/v3/workflows/`), so **site
audits and manual rank checks genuinely work in local dev and Docker
self-host**, including `step.sleep`. Adding a rankloop
`ArticleWriteWorkflow` means: a class in `src/server/workflows/`, an entry in
`wrangler.jsonc` `workflows`, a re-export in `src/server.ts` — and nothing in
`alchemy.run.ts`, which loops over the wrangler list generically.

### Files

    src/server/workflows/SiteAuditWorkflow.ts        entry + error handling
    src/server/workflows/siteAuditWorkflowPhases.ts  discovery/lighthouse/finalize phases
    src/server/workflows/siteAuditWorkflowCrawl.ts   the batched crawl loop
    src/server/workflows/site-audit-workflow-helpers.ts  crawlPage (fetch+parse)
    src/server/workflows/RankCheckWorkflow.ts        entry + prepare/finalize
    src/server/workflows/rankCheckPaths.ts           live path + queued path
    src/server/workflows/pgStep.ts                   step.do wrapper (below)

### `pgStep` — the house `step.do` wrapper

Every DB-touching step goes through `pgStep`, and its doc comment is the
single most important gotcha for anyone writing a new workflow here:

```ts
/**
 * `step.do` with a request-scoped Postgres client active inside the step body.
 *
 * Cloudflare Workflows invoke each step callback in its own execution context —
 * steps are independently persisted and can resume in a fresh invocation, so the
 * `AsyncLocalStorage` scope opened by `withPgClient` around `run()` does NOT
 * propagate into a step. Each DB-touching step must therefore open its own
 * client. In D1 mode `withPgClient` is a no-op, so this is just a plain
 * `step.do`. ...
 * `T` mirrors `step.do`'s own `Rpc.Serializable<T>` bound so step results stay
 * serializable (the workflow engine persists and replays them). Pass `undefined`
 * for `config` to use the engine's default step config ...
 */
```

Also note both workflow classes open the scope at the top anyway:

```ts
async run(event: WorkflowEvent<AuditParams>, step: WorkflowStep) {
  // Scope a per-request Postgres client for this workflow invocation (no-op in
  // D1 mode). The socket is reclaimed when the invocation ends, so there is
  // nothing to tear down here.
  return withPgClient(() => this.runScoped(event, step));
}
```

### Step configs and the money/retry split (RankCheckWorkflow)

The fork encodes a rule: **steps that spend money never retry; steps that are
free and idempotent do.**

```ts
const SINGLE_ATTEMPT_STEP_CONFIG = {
  retries: { limit: 0, delay: "1 second" as const },
  timeout: "2 minutes" as const,
};
...
// Collect steps may issue hundreds of task_get calls, so they get more room
// than SINGLE_ATTEMPT_STEP_CONFIG's 2-minute timeout. Unlike the metered
// steps, retrying is safe and free: task_get isn't charged and snapshot
// inserts are onConflictDoNothing.
const COLLECT_STEP_CONFIG = {
  retries: { limit: 2, delay: "10 seconds" as const },
  timeout: "5 minutes" as const,
};
```

For an article-writing workflow, LLM calls are the metered steps: the
matching move is single-attempt steps whose results persist incrementally,
with a finalize step that recounts from the DB.

### `step.sleep` as the polling primitive

The scheduled rank-check path posts tasks to DataForSEO's cheap queue, then
polls with durable sleeps (`rankCheckPaths.ts`):

```ts
// Poll cadence for queued tasks. Standard-priority tasks complete in ~5
// minutes on average, so the first check waits 4 minutes; cumulative waits are
// 4 / 6 / 8 / 10 / 12 / 15 minutes, after which stragglers fall back to the
// live endpoint.
const QUEUED_POLL_INTERVALS = ["4 minutes", "2 minutes", "2 minutes",
  "2 minutes", "2 minutes", "3 minutes"] as const;
...
await step.sleep(`wait-${round}`, QUEUED_POLL_INTERVALS[round]);
```

Sleeping costs nothing (the instance hibernates), so a workflow can span 15+
wall-clock minutes trivially. This is the pattern for "wait for an external
writer/publisher to finish".

### Explicit platform-limit handling (all verbatim comments)

These are the limits the fork knows about and engineers around — rankloop
workflows must respect the same ones:

- **~1MiB step output**:
  ```ts
  // Workflows rejects step outputs over 1MiB; keep the sitemap seed list well
  // under that. ...
  const SITEMAP_SEED_BYTE_BUDGET = 768 * 1024;
  ```
  and in the crawl: `MAX_FRONTIER_LINKS_PER_BATCH = 2_000` with "the step
  return only carries new-to-the-frontier targets, deduped across the batch
  and capped". Full data goes to D1 inside the step; the step returns slim
  summaries. An article draft (tens of KB) is fine as a step return, but the
  house style is to persist to D1/R2 inside the step and return counts/ids.
- **~1k steps per instance**:
  ```ts
  // KV push + D1 progress in one step — merging them halves the per-batch
  // step count against the ~1k step budget.
  ```
- **128MB isolate heap**:
  ```ts
  // Keep only the slim summary in memory: at 10k pages, retaining link
  // lists for the whole crawl would not fit in the 128MB Worker heap.
  ```
- **CPU per step**: page bodies capped at 2MiB before Cheerio ("Large pages
  make Cheerio disproportionately expensive and can exhaust a crawl step's
  CPU or isolate memory"), and heavyweight parsers are dynamically imported
  so they don't sit in every isolate's baseline heap:
  ```ts
  // Dynamic import keeps cheerio (page-analyzer's HTML parser) out of the
  // worker's startup module graph ...
  ```
- **Subrequest budget per invocation**: `TASK_GETS_PER_COLLECT = 500` — "Cap
  task_gets per round so one collect step stays well inside the
  per-invocation subrequest limit at the 1000-keyword config ceiling."
- **Deploy resets are expected churn**, not errors:
  ```ts
  const isDeployReset =
    error instanceof Error &&
    error.message.includes("Durable Object reset because its code was updated");
  ```
- **Idempotency across step retries** via deterministic ids:
  ```ts
  // Deterministic ids keep the D1 writes idempotent across step retries.
  page.id = await deterministicAuditRowId(auditId, page.url);
  ```

### Run coordination: DB row as lock, workflow id === entity id

`src/server/features/rank-tracking/services/rankCheckRunGuards.ts` is the
canonical pattern for "at most one active job per X" and rankloop's article
pipeline should mirror it rather than inventing a lock table:

```ts
// Coordination model:
// - workflow id === run id (workflow instance is the authoritative runtime).
// - A partial unique index on rank_check_runs(config_id) WHERE status IN
//   ('pending','running') enforces at most one active run per config at the
//   DB level. A failed INSERT *is* the "already running" signal — no
//   separate lock table is needed.
// - Flipping status to 'completed'/'failed' is what frees the slot.
// - Missing/unknown workflow state is tolerated briefly during startup
//   before we treat a run as stale and mark it failed.
```

`beginRankCheckRun` does: insert run row (blocked by the partial index →
"already_running"), `workflow.create({ id: runId, params })`, and on create
failure flips the row to failed and best-effort `instance.terminate()`s any
zombie. Stale blockers are detected by asking the workflow binding for
`instance.status()` with a 60-second startup grace
(`RANK_CHECK_STARTUP_GRACE_MS`), then cleared and retried once.

The audit side does concurrency differently — post-insert capacity check to
avoid check-then-act races (`AuditService.startAudit`):

```ts
// Concurrency and capacity are enforced after the insert, not before: a
// pre-insert read is a check-then-act race, so parallel requests would all
// pass the free tier's one-running-audit gate. Post-insert, each request
// sees at least its own row, so at most one racer can pass; the losers
// roll back via the catch below.
```

Tier limits live in `audit-capacity.ts` (`free`: 1 running audit, paid:
unlimited running / 100k capacity units; "Self-hosted deployments resolve to
the paid tier").

### How workflows report progress to the UI

No push channel. The workflow writes progress into D1 (status columns on the
entity row: `status`, `pagesCrawled`, `currentPhase`,
`keywordsChecked/keywordsTotal`, `errorMessage`) plus, for the audit's live
crawl feed, a capped short-TTL KV list (`AuditProgressKV`). The client polls
server functions with TanStack Query:

```ts
// useRankRunPolling.ts
if (run?.status === "pending" || run?.status === "running") return 3000;
return false;
```

and the audit page polls status at 3000ms, the crawl-URL feed at 1500ms.
Completion analytics go through `captureServerEvent` with snake_case
`feature:action` names (`"rank_tracking:check_complete"`,
`"site_audit:complete"`) and a one-line log summary designed for Workers
Logs correlation:

```ts
// One-line summary per run so fallback rates are visible in Workers Logs.
// Keys match the PostHog event properties for log/event correlation.
console.log(`[rank-check] ${input.runId} completed org=... keywords=${keywordsChecked}/${keywordsTotal}...`);
```

---

## 4. Mechanism 3 — Durable Objects via the Agents SDK (long LLM work)

Two DOs, declared in `wrangler.jsonc` (SQLite-backed classes must appear in
`migrations`) and re-exported from `src/server.ts`:

```jsonc
"durable_objects": { "bindings": [
  { "name": "ONBOARDING_CHAT", "class_name": "OnboardingChatAgent" },
  { "name": "SAM_CHAT", "class_name": "SamChatAgent" },
]},
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["OnboardingChatAgent"] },
  { "tag": "v2", "new_sqlite_classes": ["SamChatAgent"] },
],
```

- `OnboardingChatAgent` (`src/server/features/onboarding/OnboardingChatAgent.ts`)
  extends `AIChatAgent` from `@cloudflare/ai-chat`; one instance per project.
- `SamChatAgent` (`src/server/features/sam/SamChatAgent.ts`) extends `Think`
  from `@cloudflare/think`; one instance per chat session. Runs genuinely
  long agentic turns: `maxSteps: 48` with the comment "SAM is meant to run
  complex multi-step work in one turn (site-read intake plus a full research
  chain, multi-competitor sweeps)".

Both base classes extend `Agent` from the `agents` package (v0.17.3 pinned).
Routing and auth happen in the Worker before anything reaches a DO
(`src/server.ts`):

```ts
// Route /agents/* to the onboarding and SAM chat DOs. Auth happens here (both
// the WS upgrade and any HTTP message-history fetch) ...
const response = await routeAgentRequest(request, env, {
  onBeforeConnect: (req, lobby) => authorizeChatAgent(req, lobby),
  onBeforeRequest: (req, lobby) => authorizeChatAgent(req, lobby),
});
```

The DO-instance-name-is-the-entity-id convention is stated twice:

```ts
// the DO instance name IS the projectId, set by the client
// (`useAgent({ name: projectId })`) and authorized in the Worker
// (`onBeforeConnect`) before any connection reaches here — so the DO trusts
// that its caller may act on `this.name`
```

DO-specific durability habits worth copying if the article writer becomes an
agent: hibernation-aware storage (SAM keeps the public origin in
`ctx.storage`, not an instance field, "because the DO hibernates: a turn can
arrive as a WS message on a wake-up where fetch() never ran"), transient DO
storage error retry (`persistMessages` retries on "internal error"/code
10001), and per-turn billing metering armed in `beforeTurn` / settled in
`onChatResponse`.

### The unused scheduling substrate (important)

The `agents` base class the fork already ships includes a full DO-alarm-backed
scheduler that **no first-party code uses yet**. From
`node_modules/agents/dist/agent-tool-types-CNyE1iz_.d.ts`:

```ts
/** Represents a scheduled task within an Agent */
  /** Unique identifier for the schedule */ id: string;
  /** Type of schedule for one-time execution at a specific time */ type: "scheduled"
  /** Type of schedule for delayed execution */ type: "delayed"
  /** Type of schedule for recurring execution based on cron expression */ type: "cron"
  /** Type of schedule for recurring execution at fixed intervals */ type: "interval"
```

plus retryable `schedule()`/`queue()`, keepAlive alarm heartbeats, and
alarm-boundary memory-limit recovery. The decisive property: **DO alarms fire
in miniflare**, i.e. in local dev and the Docker self-host, which cron
triggers do not. A singleton "scheduler agent" DO using `type: "cron"`
schedules is the only mechanism already in this bundle that gives rankloop
daily routines identical behavior in all three environments. The
`cloudflare:agents-sdk` skill covers the API; the wrangler side is just
another DO binding + migration tag + re-export, exactly like the two above.

---

## 5. Mechanism 4 — request-piggybacked background work

Three sub-patterns, all in production use:

### a. `ctx.waitUntil` on every fetch + DB compare-and-set claim

The self-host telemetry heartbeat (`src/server/lib/self-host-telemetry.ts`)
is a complete, tested template for "roughly daily job with no cron": every
request calls `ctx.waitUntil(maybeSendSelfHostHeartbeat())` (`src/server.ts`
line 141), which:

1. bails via an **in-memory throttle** (`lastCheckedAt`, 15-min steady-state
   check interval) so the DB isn't touched per request;
2. **claims** the beat with a single atomic UPDATE-where-stale:
   ```ts
   const [claimed] = await db.update(telemetryState)
     .set({ lastHeartbeatAt: now })
     .where(and(eq(telemetryState.id, TELEMETRY_STATE_ID),
       or(isNull(telemetryState.lastHeartbeatAt),
          lt(telemetryState.lastHeartbeatAt, cutoff))))
     .returning({ id: telemetryState.id });
   ```
   — losers of the race get zero rows and return. Works across isolates.
3. does the work, then marks state with race-safe arithmetic ("Preserve tool
   calls that race with the heartbeat send while clearing exactly the count
   included in this event").

If rankloop needs a self-host-safe "run signals if stale" nudge without
adding infrastructure, this is the sanctioned shape: same CAS claim, same
`waitUntil` piggyback, cadence functions unit-tested
(`getHeartbeatIntervalMs`/`getCheckIntervalMs` are exported for tests).

### b. `waitUntil` for post-response writes — with the workerd gotcha

Repeated verbatim in four services (serp.ts, DomainService.ts,
promptExplorer.ts, domainPagesPage.ts):

```ts
// waitUntil, not void: workerd cancels unregistered pending I/O once the
// response is sent, so a fire-and-forget put never persists the cache.
waitUntil(setCached(cacheKey, result, SERP_CACHE_TTL_SECONDS).catch(...));
```

Any "publish receipt after responding" write in the Write feature must use
`waitUntil` from `cloudflare:workers`, never a dangling promise. Note the
contrast inside Workflows: "Workflow entrypoints run outside the
server-function middleware ... Capture it here (awaited — Workflows have no
ctx.waitUntil)" (`SiteAuditWorkflow.ts`).

### c. Read-path reconciliation instead of background sweepers

There is no janitor cron. Stale state is repaired when someone looks at it:

- `RankTrackingService.getLatestRun` calls `reconcileActiveRankCheckRun` but
  only **reports** staleness ("Mutating from this read path caused a race
  where the original workflow kept running while a replacement was started");
  the actual repair happens inside the next `beginRankCheckRun`.
- `AuditService.getStatus` self-heals: "Self-heal audits whose workflow died
  without reaching the mark-failed step ... Without this they stay 'running'
  forever and hold capacity." It asks `instance.status()` and flips
  errored/terminated rows to failed.

An Articles pipeline should assume the same: status rows + workflow-instance
truth + read-time repair, not a cleanup cron.

---

## 6. What is genuinely missing for rankloop's background needs

| rankloop need | exists in fork? | reuse / gap |
|---|---|---|
| User-triggered minutes-long job (write one article) | **Yes** — Cloudflare Workflows | New `ArticleWriteWorkflow` modeled on `RankCheckWorkflow`: run row + partial unique index, `pgStep`, single-attempt metered LLM steps, incremental persistence, finalize recount, 3s UI polling. Works in all three environments today. |
| Daily routines on hosted Cloudflare (signal compute, GSC sync, publish sweep) | **Yes** — extend `triggers.crons` + dispatch on `controller.cron` in the one `scheduled` handler | Keep bodies as `services/scheduledX.ts`; copy eager-advance + limit-N + per-item try/catch from `runScheduledRankChecks`. |
| Daily routines in Docker self-host / local dev | **No** — crons never fire there (undocumented upstream gap; rank tracking already suffers it) | Options: compose sidecar `curl /cdn-cgi/handler/scheduled` (endpoint verified reachable — `unsafeTriggerHandlers: true` in both dev and preview modes); or a DO-alarm scheduler via the shipped-but-unused `Agent.schedule()` (alarms fire in miniflare); or CAS-claimed `waitUntil` piggyback for soft-deadline work. |
| Long LLM calls | **Yes, twice** — OpenRouter plumbing (`buildChatAgentModel` in `src/server/lib/openrouter.ts`, `OPENROUTER_API_KEY`/`OPENROUTER_MODEL` already threaded through compose.yaml *and* alchemy.run.ts and gated in self-host setup) and streaming agent loops in DOs | Inside a Workflow step, an LLM call is just awaited I/O — wall-clock wait is free; the 2-to-5-minute step `timeout` values are the knob. Cost metering per step mirrors `openRouterCostUsd(ctx.providerMetadata)` + `trackUsageCreditSpend` (hosted-gated via `isHostedServerAuthMode()`). |
| Queue with backpressure / fan-out | **No Cloudflare Queues anywhere** | Don't add one for the graft — upstream's idiom is "cron tick starts N workflow instances, DB row is the queue". The Opportunities queue is a table + `pick`-style query, exactly like `getDueConfigsWithOrganization`. |
| Scheduled GSC ingestion | **No** — GSC is 100% on-demand (`GscService.getPerformance` hits `www.googleapis.com` live per request; nothing stores analytics rows) | rankloop's GSC flywheel needs a new stored table + a cron body; nothing to reuse beyond the OAuth client (`gscClient.ts`) and connection repo. |
| Job/receipt history UI | Partial — audit history + rank-run history pages poll status rows | Copy `useRankRunPolling` + the audit `refetchInterval` pattern; terminal-state transition invalidates results queries. |

### Grafting checklist for a new workflow (to stay indistinguishable)

1. Class in `src/server/workflows/`, phases split into sibling files when
   >~150 lines (see the audit's 4-file split); all DB steps via `pgStep`.
2. `wrangler.jsonc` → `workflows` array entry (kebab-case name, SCREAMING
   binding, PascalCase class); re-export from `src/server.ts` with a one-line
   comment matching the existing ones.
3. Run row created before `workflow.create({ id: runId })`; id === row id;
   partial unique index for at-most-one-active; failure path flips the row
   and terminates the zombie instance.
4. Metered steps: `retries: { limit: 0 } }`; free idempotent steps: small
   retry budget; `onConflictDoNothing` inserts.
5. Progress = columns on the run row (+ KV feed only if per-item streaming
   matters); client polls at 3000ms while `pending|running`.
6. Logs: `` console.log(`[article] ${runId} ...`) `` lowercase, one line,
   bounded error echoes (`.replace(/\s+/g, " ").slice(0, 200)`); PostHog
   `captureServerEvent` with `article:*` snake_case properties; awaited (no
   waitUntil) inside workflow code.
7. Billing gates behind `isHostedServerAuthMode()`; self-host ungated.
8. Comments explain WHY in the fork's voice (concrete numbers, lowercase
   asides, "— so/otherwise" clauses), not what.
