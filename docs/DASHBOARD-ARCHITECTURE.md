# Dashboard server architecture (OpenSEO / rankloop 2.0)

Reference for grafting new feature groups (e.g. "Write": Opportunities, Articles,
Receipts) into `apps/dashboard` so the result is indistinguishable from upstream.
Everything below is read from the vendored code at
`/Users/worklab/rankloop-v2/apps/dashboard` — paths are relative to that root
unless absolute.

Stack: TanStack Start (React 19, file routes, server functions) on a single
Cloudflare Worker (`wrangler.jsonc` -> `main: src/server.ts`), Drizzle ORM over
**D1 (SQLite, default)** or **Postgres via Hyperdrive (opt-in)**, TanStack Query
client-side, Zod v4, better-auth (hosted mode), vitest for unit tests,
Playwright for e2e. Lint = oxlint (`--type-aware`), format = prettier,
dead-code = knip. `pnpm` (pinned via `packageManager`, currently `pnpm@10.30.1`).

---

## 1. Runtime entrypoints

`src/server.ts` is the Worker module. Its default export routes, in order:
`/agents/*` (chat Durable Objects, authorized in the Worker via
`resolveUserContextFromHeaders` before reaching the DO), the Autumn billing
webhook + OAuth provider wrapper (hosted mode only), the self-hosted MCP route,
then falls through to `appFetch = createStartHandler(defaultStreamHandler)`
(the TanStack Start app, which serves routes AND server functions). It also
re-exports Workflow classes (`SiteAuditWorkflow`, `RankCheckWorkflow`) and DO
classes as named exports, and a `scheduled` cron handler.

Both `fetch` and `scheduled` wrap everything in `withPgClient` (no-op on D1):

```ts
function fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Scope a per-request Postgres client (no-op in D1 mode). The client isn't
  // closed here — the Workers↔Hyperdrive socket is reclaimed at invocation end.
  return withPgClient(() => Promise.resolve(handleFetch(request, env, ctx)));
}
```

`src/start.ts` registers the global server-function middleware:

```ts
import { createCsrfMiddleware, createStart } from "@tanstack/react-start";
import { globalServerFunctionMiddleware } from "@/serverFunctions/middleware";

const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware],
  functionMiddleware: globalServerFunctionMiddleware,
}));
```

`src/router.tsx` builds the router with `defaultPreload: "intent"`,
`DefaultCatchBoundary`, `NotFound`. `src/routes/__root.tsx` wraps the app in
`QueryClientProvider` using the singleton `queryClient` from
`@/client/tanstack-db`.

---

## 2. The canonical backend flow

`.greptile/rules.md` states it verbatim (this file is the enforced review
contract — new code is reviewed against it):

```text
TanStack server function -> service -> repository -> provider-aware db/schema
```

> - The server function owns authentication middleware, Zod input validation,
>   verified-context injection, and transport-only shaping.
> - The service owns business rules, provider, cache, and Workflow
>   orchestration, and translates provider or domain failures into application
>   errors when appropriate.
> - The repository owns Drizzle persistence and query behavior.
> - Do not put new database or provider orchestration directly in
>   `src/serverFunctions/**`.
> - Do not create an empty repository for provider-only or pure-computation
>   features.

`CLAUDE.md` (repo root, "Agent guidance") adds: "For new application-backed
backend functionality, default to: TanStack server function → service →
repository" and "Keep schema changes, queries, and mutations compatible with
both SQLite and Postgres."

Directory shape per domain, under `src/server/features/<domain>/`:

```
src/server/features/rank-tracking/
  repositories/RankTrackingRepository.ts   (+ snapshotQueries.ts helpers, colocated .test.ts)
  services/RankTrackingService.ts          (+ smaller service modules, colocated .test.ts)
src/server/features/projects/
  repositories/ProjectRepository.ts
  services/ProjectService.ts               (thin facade)
  services/projects.ts                     (the actual functions + projects.test.ts)
```

Repositories and Services are exported as plain frozen object literals of free
functions, `as const` — **no classes**:

```ts
export const ProjectRepository = {
  listProjects,
  listArchivedProjects,
  countProjects,
  getProjectForOrganization,
  ...
} as const;
```

Simple domains skip a facade and put functions straight into
`services/<name>.ts` (e.g. `domain/services/DomainService.ts`). Provider-only
features have **no repository at all** (`backlinks/services/BacklinksService.ts`).
Shared server helpers live in `src/server/lib/` (DataForSEO client, errors,
posthog, r2, scrape, runtime-env, …). Pure code shared with the client lives in
`src/shared/` (error codes, billing constants, json helpers).

---

## 3. Server functions (`src/serverFunctions/*.ts`)

One file per domain, colocated with nothing else. Every function is
`createServerFn({ method: "POST" })` for anything project-scoped or mutating;
`method: "GET"` only for org/user-level, no-input status reads
(`config.ts:getSeoApiKeyStatus`, `gsc.ts:getGscGrantStatus`,
`onboarding.ts:getOnboardingAnswers`, `sam.ts:listSamSessions`).

Canonical project-scoped shape (from `src/serverFunctions/dashboard.ts`):

```ts
export const getDashboardActivation = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(dashboardProjectInputSchema)
  .handler(({ context }) =>
    DashboardService.getActivation({
      projectId: context.projectId,
      organizationId: context.organizationId,
      domain: context.project.domain,
    }),
  );
```

Org-scoped shape (from `src/serverFunctions/projects.ts`):

```ts
export const getProjects = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .handler(async ({ context }) =>
    ProjectService.listProjectsEnsuringOne(context.organizationId),
  );
```

Zod schemas live in `src/types/schemas/<domain>.ts`, exporting both the schemas
and `z.infer` input types (`CreateProjectInput` etc.). Every project-scoped
schema includes `projectId: z.string().min(1)`. Analytics events are fired from
the server function (not the service) with
`waitUntil(captureServerEvent({ distinctId: context.userId, event: "domain:action", organizationId, properties: { project_id, ... } }))`
— event names are `feature:verb_noun` snake-cased, property keys snake_cased.

### 3.1 Middleware & project scoping (ADR 0001)

Read `specs/0001-project-scoping-for-server-functions.md` in full. The decision:

> Project-scoped server functions must accept `projectId` in their input.
> Global server-function middleware now always resolves the authenticated user
> and organization. If the payload includes `projectId`, that same global
> middleware loads the project for the current organization and adds it to
> server-function context. … handlers use `context.project.id`, not
> session-backed current-project state.

Implementation, `src/serverFunctions/middleware.ts`:

```ts
export const globalServerFunctionMiddleware = [
  errorHandlingMiddleware,
  ensureUserMiddleware,
] as const;

export const requireAuthenticatedContext = [
  createMiddleware({ type: "function" }).server(async ({ next, context }) => {
    const authenticatedContext = getAuthenticatedContext(context);
    return next({ context: authenticatedContext });
  }),
] as const;

export const requireProjectContext = [
  createMiddleware({ type: "function" }).server(async ({ next, context }) => {
    const authenticatedContext = getAuthenticatedContext(context);
    if (!authenticatedContext.project) {
      throw new AppError("INTERNAL_ERROR",
        "Project context missing from authenticated server function");
    }
    return next({
      context: {
        ...authenticatedContext,
        project: authenticatedContext.project,
        projectId: authenticatedContext.project.id,
      },
    });
  }),
] as const;
```

The function-level middlewares only **narrow types**; the real authorization is
in the global `ensureUserMiddleware` (`src/middleware/ensureUser.ts`), which
sniffs `projectId` out of the raw payload and resolves it against the caller's
org:

```ts
  if (projectId) {
    // ADR 0001 intentionally keeps project authorization here so every
    // project-scoped server function gets the same request-scoped org+project
    // check before handlers run. Function-level middleware narrows the type.
    project = await ProjectRepository.getProjectForOrganization(
      projectId,
      context.organizationId,
    );
    if (!project) {
      throw new AppError("NOT_FOUND");
    }
  }
```

Gotcha preserved in `src/types/schemas/projects.ts`: an input field that IS a
project id but must not be auth-resolved gets a different name —

```ts
// Deliberately not named `projectId`: ensureUserMiddleware resolves any
// `projectId` in input data against active projects and 404s on archived
// ones before the handler runs.
export const restoreProjectSchema = z.object({
  archivedProjectId: z.string().min(1),
});
```

Sub-resources (configs, audits, …) are re-checked in the handler/service by
querying with `and(eq(id), eq(projectId))` — e.g. `requireConfig(configId,
context.projectId)` in `serverFunctions/rank-tracking.ts`, and every
`AuditService.*(auditId, context.projectId)`.

### 3.2 Auth context & modes

`src/middleware/ensure-user/types.ts`:

```ts
export type EnsuredUserContext = {
  userId: string;
  userEmail: string;
  emailVerified: boolean;
  organizationId: string;
  project?: EnsuredProject;
};
```

`src/middleware/ensure-user/resolve.ts` dispatches on `AUTH_MODE`
(`src/lib/auth-mode.ts`, enum `["cloudflare_access", "local_noauth", "hosted"]`,
unset fails closed to `cloudflare_access`, a *set-but-invalid* value logs
`console.error` once):

- `local_noauth` → `resolveLocalNoAuthContext()` (`delegated.ts`): fixed
  `local-admin` / `admin@localhost` user, upserted into the better-auth `user`
  table with `onConflictDoNothing({ target: user.id })`, org via
  `ensureDelegatedOrganizationForUser`. `emailVerified: true` always.
- `cloudflare_access` → `cloudflareAccess.ts`: verifies
  `cf-access-jwt-assertion` with jose against `TEAM_DOMAIN` JWKS + `POLICY_AUD`,
  then the same delegated-context path.
- `hosted` → `hosted.ts`: better-auth session (`getAuth().api.getSession({ headers })`),
  active organization from the session, creating a default org on first touch.

`resolveUserContextFromHeaders(headers)` is also the trust boundary for **raw**
surfaces (Worker-level DO authorization in `server.ts`, API routes) — raw
routes never get server-function middleware and must call it themselves
(`.greptile/rules.md`: "Raw API routes, Worker dispatch, Durable Objects,
Workflows, webhooks, and callbacks … establish and translate their own trust
boundary explicitly").

Client-side mode check is build-time: `isHostedClientAuthMode()` reads
`import.meta.env.AUTH_MODE` (deploy-time contract that client build env matches
runtime env).

### 3.3 Error handling

- `src/shared/error-codes.ts`: the closed `ERROR_CODES` enum (zod
  `errorCodeSchema`), `isErrorCode`, plus `NON_REPORTABLE_ERROR_CODES` (codes
  never captured to PostHog: UNAUTHENTICATED, NOT_FOUND, VALIDATION_ERROR, …).
- `src/server/lib/errors.ts`: `class AppError extends Error` with
  `(code, message?, details?)`; `asAppError` (also promotes a bare
  `Error("NOT_FOUND")` whose message is a code); `toClientError` strips
  everything to the bare code **except** codes in `CLIENT_DETAIL_ERROR_CODES`
  (currently only `AUTH_CONFIG_MISSING`), which cross the wire as
  `"CODE: detail"`.
- `src/middleware/errorHandling.ts` (first in the global chain): catches,
  detects TanStack validator errors (message is a JSON issue array) → maps to
  `VALIDATION_ERROR`, captures reportable ones via
  `waitUntil(captureServerError(...))`, rethrows `toClientError(...)`.
- Client: `src/client/lib/error-messages.ts` — `getStandardErrorMessage(error,
  fallback?)` maps code → copy via `STANDARD_MESSAGES`, `getErrorCode(error)`
  for code-driven UI. New error codes require: enum entry, STANDARD_MESSAGES
  copy, and (if not reportable) NON_REPORTABLE set membership.

Services throw `new AppError("VALIDATION_ERROR", "Enter a valid domain, like acme.com.")`
— short, user-facing, sentence-cased messages with a concrete example.

---

## 4. Database layer (`src/db/`)

### 4.1 Files

```
src/db/
  app.schema.ts            SQLite tables: onboarding answers, projects, saved keywords,
                           tags, metrics, rank tracking, activation, backlink snapshots
  audit.schema.ts          per-domain SQLite schema files: one file per feature domain
  gsc.schema.ts            (sam, billing, better-auth, reddit-attribution, telemetry too)
  d1/client.ts             drizzle(env.DB, { schema }) — the D1 client
  d1/schema.ts             raw SQLite barrel: `export * from "../app.schema"; ...`
  pg/app.schema.ts         hand-written Postgres twin of every SQLite schema file
  pg/schema.ts             pg barrel: `export * from "./app.schema"; ...`
  pg/client.ts             per-request postgres-js client in AsyncLocalStorage
  pg/retry.ts              query retry wrapper for Hyperdrive failovers
  provider.ts              DATABASE_PROVIDER -> "d1" | "postgres"; HYPERDRIVE conn string
  schema.ts                provider-aware canonical barrel (typed as SQLite, cast)
  index.ts                 exports `db` + `withPgClient`
  runBatch.ts              the ONLY file allowed to call `.batch(`
  schema-parity.test.ts    structural D1<->PG drift guard (vitest)
```

### 4.2 The dual-dialect contract

`src/db/schema.ts` — repositories import tables from here and `db` from
`"@/db"`, so each repository is written once:

```ts
// The TYPE identity is the SQLite definitions; the runtime VALUES are whichever
// provider is active. `schema-parity.test.ts` asserts the two dialect schemas
// are structurally interchangeable (same tables/columns/nullability/PKs/unique
// indexes), which is what makes the single cast below sound. The Postgres
// schema is the one structural artifact NOT regenerated by `db:generate`, so the
// parity test is its drift guard.
type AppSchema = typeof sqliteApp & typeof sqliteAudit & ... ;

const runtimeSchema = getDatabaseProvider() === "postgres" ? { ...pgApp, ... } : { ...sqliteApp, ... };

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- guarded by schema-parity.test.ts
const schema = runtimeSchema as unknown as AppSchema;

export const { userOnboardingAnswers, projects, savedKeywords, ... } = schema;
```

Every table is **destructure-exported by name** at the bottom of `schema.ts`.
A new table must be added to: both dialect schema files, `d1/schema.ts` export
line (implicit via `export *` if in an existing file; a new file needs a new
`export * from` line in BOTH barrels), the `AppSchema` type union + both
runtime spreads + the destructured export list in `schema.ts`, and both import
lists in `schema-parity.test.ts`.

`src/db/index.ts`:

```ts
// Provider-aware database handle. D1 is the default (free, zero-config self-host
// on the Cloudflare free plan); Postgres is opt-in via DATABASE_PROVIDER=postgres.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- guarded by schema-parity.test.ts
export const db = (getDatabaseProvider() === "postgres"
  ? pgDb
  : d1Db) as unknown as typeof d1Db;
```

### 4.3 Schema style (SQLite side, `app.schema.ts`)

- Table fn: `sqliteTable("snake_case_name", { camelCol: text("snake_col") ... }, (table) => [ ...indexes ])`.
- IDs: `text("id").primaryKey()` populated with `crypto.randomUUID()` in the
  repository; high-volume append-only tables use
  `integer("id").primaryKey({ autoIncrement: true })` (metrics, snapshots).
- FKs always cascade: `.references(() => projects.id, { onDelete: "cascade" })`.
- Timestamps are TEXT: `text("created_at").notNull().default(sql`(current_timestamp)`)`.
- Enums via `text("status", { enum: ["pending", "running", "completed", "failed"] })`.
- Booleans via `integer("is_active", { mode: "boolean" })`.
- Index names are full snake-case sentences ending `_idx`; partial unique
  indexes with `.where(sql`...`)` are used for singletons and one-in-flight
  guards (see `rank_check_runs_one_active_per_config_idx`).
- Dense WHY-comments above almost every table and non-obvious index ("No
  standalone index on runId — the unique index below has it as its leftmost
  column, so it already serves runId lookups.").

### 4.4 Postgres twin (`pg/app.schema.ts`)

Same tables/columns/indexes with `pgTable`, `boolean()`, `serial` for
autoincrement, and the load-bearing timestamp convention:

```ts
// Timestamps are stored as *text* (same column shape as the SQLite schema).
// Postgres `timestamptz` would be parsed back into a JS Date by postgres-js
// (even with drizzle `mode:"string"`), silently breaking the lexicographic
// string comparisons the app does on timestamps. `isoNow` matches the format of
// `new Date().toISOString()` ...
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const timestampColumn = (name: string) => text(name);
```

NOTE (`.greptile/rules.md`): "SQLite and Postgres hand-authored timestamps are
text, but their database defaults are not byte-identical … Do not enforce a
false rule that every stored timestamp is ISO."

### 4.5 Postgres client (`pg/client.ts`)

Per-request client in `AsyncLocalStorage` because Workers forbid cross-request
socket reuse. `pgDb` is a Proxy that throws
`"Postgres database accessed outside a request scope. Entrypoints (fetch,
scheduled, workflow run) must wrap DB usage in withPgClient()."` if no scope is
active. `withPgClient` is reentrant, `max: 1`, `connect_timeout: 10`, never
calls `sql.end()`. **Any new entrypoint (cron, workflow, DO handler, queue)
must wrap itself in `withPgClient`.** Workflows use
`src/server/workflows/pgStep.ts`:

```ts
export function pgStep<T extends Rpc.Serializable<T>>(
  step: WorkflowStep, name: string,
  config: WorkflowStepConfig | undefined, fn: () => Promise<T>,
): Promise<T> {
  return config
    ? step.do(name, config, () => withPgClient(fn))
    : step.do(name, () => withPgClient(fn));
}
```

(ALS never crosses `step.do`, so each DB-touching step opens its own client.)

### 4.6 Atomic multi-statement writes: `runBatch` / `executeInBatches`

`db.batch` exists only on D1; on Postgres it throws. `src/db/runBatch.ts` is
the only file allowed to call `.batch(` — enforced by a vitest test in
`schema-parity.test.ts` that greps `src/` (`describe("no direct db.batch (must
use runBatch)")`). D1 runs one atomic ordered batch; Postgres runs the
statements sequentially inside `db.transaction`. Critical usage rule (verbatim
comment):

> IMPORTANT: build statements from the `tx` handle the callback receives, NOT
> the module-level `db`. On Postgres, statements built from the outer `db`
> would execute outside the transaction.

`executeInBatches(items, (tx, item) => tx.insert(...).values(item)...)` chunks
at `DB_BATCH_SIZE = 100` (D1 bound-parameter cap). Real call site
(`RankTrackingRepository.insertSnapshots`) always **targets** the dedupe index:

```ts
await executeInBatches(snapshots, (tx, snapshot) =>
  tx.insert(rankSnapshots).values(snapshot).onConflictDoNothing({
    target: [rankSnapshots.runId, rankSnapshots.trackingKeywordId, rankSnapshots.device],
  }),
);
```

### 4.7 Migrations

Two migration trees, both committed:

- `drizzle/` — D1/SQLite, generated by `drizzle.config.ts`
  (dialect `sqlite`, schema `./src/db/d1/schema.ts` — the raw barrel, because
  the provider-aware one imports `cloudflare:workers` and can't load under
  drizzle-kit's node runtime).
- `drizzle-pg/` — Postgres, generated by `drizzle-pg.config.ts`
  (schema `./src/db/pg/schema.ts`, `POSTGRES_DATABASE_URL` from `.env.local`).
- `drizzle-prod.config.ts` exists for `d1-http` remote credentials.

Scripts (`package.json`):

```
db:generate        = db:generate:d1 && db:generate:pg
db:generate:d1     = drizzle-kit generate
db:generate:pg     = drizzle-kit generate --config drizzle-pg.config.ts
db:migrate:local   = wrangler d1 migrations apply DB --local
db:migrate:prod    = wrangler d1 migrations apply DB --remote
db:migrate:pg      = drizzle-kit migrate --config drizzle-pg.config.ts
```

Migration files are mostly drizzle-kit's random names
(`0036_curvy_silk_fever.sql`); occasionally hand-named via drizzle-kit's
`--name` flag with the SAME slug in both trees (`drizzle/0035_dashboard.sql`
and `drizzle-pg/0012_dashboard.sql`; also `0029_location_name.sql` /
`0006_location_name.sql`). Review rule: "Review generated migration SQL
semantically even though metadata snapshots are ignored" — never hand-edit
`meta/` snapshots or ask for edits to generated files.

better-auth schemas are separately generated per dialect (`auth:generate:d1`,
`auth:generate:pg`) and carry hand-restored indexes guarded by
`REQUIRED_BETTER_AUTH_INDEXES` in the parity test.

### 4.8 `schema-parity.test.ts`

Asserts for every application table: same table set, same columns
(name/nullability/dialect-agnostic dataType/hasDefault/enum values), same PKs,
same unique tuples (including a `|partial` marker so a partial→full unique
change is caught), same FKs including `onDelete`. **Any new table/column added
to one dialect and not the other fails CI here.** New schema-file modules must
be imported into both `tablesFrom(...)` lists.

---

## 5. Env & config access

Three tiers — pick correctly (review rule: "Read secret-bearing server runtime
configuration through the runtime environment helpers or Workers bindings"):

1. **Direct binding access** — `import { env } from "cloudflare:workers"` then
   `env.DATAFORSEO_API_KEY`, `env.KV`, `env.DB`, `env.AUTH_MODE`. Typing comes
   from generated `worker-configuration.d.ts` (via `pnpm cf-typegen`) plus
   hand-maintained extensions in `src/env.d.ts` (`declare namespace Cloudflare
   { interface Env { ... } }` — optional vars are `?:`, each with a comment).
2. **Runtime-env helpers** — `src/server/lib/runtime-env.ts`:
   `getOptionalEnvValue(name)` / `getRequiredEnvValue(name)` (async; reads
   `process.env` first — where `.env.local` lands in dev — then the workers
   env; skips empty strings), `getEnvValueSync(env, name)` for DOs, and
   `isHostedServerAuthMode()`. Use these in code that must also run where
   `cloudflare:workers` may be absent, or for hosted/self-host divergence.
3. **Client build-time** — `import.meta.env.AUTH_MODE` etc., typed in
   `src/env.d.ts` `ImportMetaEnv`. Public values only; never a secret.

`DATABASE_PROVIDER` is read via `Reflect.get(env, "DATABASE_PROVIDER")` in
`provider.ts` (unset/empty → `"d1"`, unknown → throw).

---

## 6. Client-side conventions (queries against server functions)

- `src/client/tanstack-db/queryClient.ts`: singleton QueryClient,
  `gcTime: 1h`, `staleTime: 5m` defaults.
- **No central query-key registry.** Keys are inline string arrays:
  `["projects"]`, `["dashboardActivation", projectId]`,
  `["rankTrackingResults", projectId, configId, comparePeriod]`. First segment
  is a camelCase feature-noun; project/tenant scope comes immediately after;
  then every semantic input that changes the result (rule from
  `.greptile/rules.md`: "Query keys include project or tenant scope when the
  result is scoped, plus every semantic input that changes the result").
  When a key is shared between files it becomes an exported helper next to the
  hook (`buildKeywordResearchQueryKey` in
  `src/client/features/keywords/hooks/useKeywordResearchData.ts`) or a
  module-level const (`GRANT_STATUS_KEY` in `SearchConsoleConnectionCard.tsx`).
- Query: `useQuery({ queryKey: [...], queryFn: () => someServerFn({ data: { projectId, ... } }) })`.
  Server functions are imported directly from `@/serverFunctions/<domain>` and
  called with `{ data }`; there is no `useServerFn` wrapper anywhere.
- Mutations: `useMutation({ mutationFn, onSuccess: () => queryClient.invalidateQueries({ queryKey: [prefix, projectId] }), onError: (e) => toast.error(getStandardErrorMessage(e, "Couldn't … Try again.")) })`.
  Prefix invalidation is idiomatic and intentional. `void`-prefix the
  invalidate promises.
- Paid/expensive queries set `retry: false`, `refetchOnWindowFocus: false`,
  long `staleTime` (see `useKeywordResearchData`: 24h) — "Retry, focus-refetch,
  stale-time, and cache behavior must not cause accidental repeated spend."
- Routes: project pages live at
  `src/routes/_project/p/$projectId/<page>.tsx`; the layout
  (`_project/p/$projectId/route.tsx`) sets `ssr: false` ("Everything under this
  subtree fetches its data client-side with react-query, so SSR would only
  render empty chrome"), runs a non-blocking `useProjectAccessRedirect`
  (`["projectAccess", projectId]`, `staleTime: Infinity`, `retry: false`), and
  persists the last-visited project (`src/client/lib/active-project.ts`,
  localStorage key `openseo:lastProjectId` — client hint only, never trusted).
- Client feature code: `src/client/features/<domain>/` (PascalCase component
  files, `use*.ts` hooks, small `types.ts`). Sidebar entries:
  `src/client/navigation/items.ts` (`projectNavItems` + grouping in
  `getProjectNavGroups`; groups are "Overview" / "Research" / "My Site").
- Raw API routes: `src/routes/api/**` using
  `createFileRoute("/api/x")({ server: { handlers: { GET: ... } } })`
  (see `src/routes/api/health.ts`); they do their own auth via
  `resolveUserContextFromHeaders`.

---

## 7. Testing

`vitest.config.ts`:

```ts
export default defineConfig({
  plugins: [tsConfigPaths()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
    clearMocks: true,
  },
});
```

- Tests are **colocated** (`Foo.ts` + `Foo.test.ts`), plain node environment,
  no miniflare, no DB. There are **no repository integration tests** — the DB
  layer is guarded structurally (`schema-parity.test.ts`) and repositories stay
  thin; business logic is tested at the service level with the repository
  mocked.
- Canonical service-test pattern (`RankTrackingService.test.ts`):

```ts
const mocks = vi.hoisted(() => ({
  getConfigByProjectDomainLocation: vi.fn(),
  getConfigsForProject: vi.fn(),
  createConfig: vi.fn(),
  updateConfig: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/lib/dataforseo", () => ({ createDataforseoClient: vi.fn() }));
vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({ RankTrackingRepository: mocks }),
);

describe("RankTrackingService.createConfig", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it("reactivates an archived config instead of throwing, applying the new settings", async () => {
    ...
    const { RankTrackingService } = await import("./RankTrackingService");
    await expect(RankTrackingService.createConfig(baseInput)).resolves.toEqual({...});
```

  Key moves: `vi.hoisted` mock bag; **always** `vi.mock("cloudflare:workers",
  () => ({ env: {} }))` when the import graph touches it; `vi.resetModules()` +
  dynamic `await import("./SUT")` inside each test; assertions on AppError via
  `.rejects.toMatchObject({ code: "VALIDATION_ERROR" })`; test names are full
  behavioral sentences.
- Pure-function tests (filters, shaping, url utils, shared helpers) are plain
  `describe/it/expect` with no mocks — the majority of the ~100 test files.
- Static-guard tests are idiomatic here: schema parity, the `.batch(` grep, and
  `output-schema-validation.test.ts` for MCP.
- e2e: Playwright specs in `e2e/` (run separately, `pnpm test:e2e`), using
  fixture env flags (`VITE_E2E_DOMAIN_FIXTURES`).
- CI gate (`docs/CONTRIBUTING.md`): `pnpm ci:check && pnpm test:ci && pnpm vite build`
  where `ci:check = prettier --check . && knip && tsc --noEmit && tsc --noEmit
  -p badseo/tsconfig.json && oxlint . --type-aware`. Knip means **unused
  exports fail CI** — don't export speculative helpers.

---

## 8. The exact recipe: adding a "proposals" domain

Every file for a new project-scoped domain with a list/create/update surface,
in the order upstream would write them. (Rename to `opportunities` /
`articles` / `receipts` as needed — one schema file and one serverFunctions
file can host several related tables/functions for one feature group, exactly
like `app.schema.ts` hosts saved keywords + rank tracking + activation.)

1. **SQLite schema** — `src/db/proposals.schema.ts`
   (or add tables to an existing domain schema file if the group is small):

```ts
import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { projects } from "./app.schema";

// <WHY-comment: what a proposal row is and which surface writes it>
export const proposals = sqliteTable(
  "proposals",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: text("status", { enum: ["draft", "queued", "published"] })
      .notNull()
      .default("draft"),
    createdAt: text("created_at").notNull().default(sql`(current_timestamp)`),
  },
  (table) => [
    index("proposals_project_created_idx").on(table.projectId, table.createdAt),
  ],
);
```

2. **Postgres twin** — `src/db/pg/proposals.schema.ts`: same shape with
   `pgTable`, the file-local `isoNow` + `timestampColumn` helpers copied from
   `pg/app.schema.ts`, identical index names.

3. **Register the module** (new-file case; skip if added to an existing file):
   - `src/db/d1/schema.ts`: `export * from "../proposals.schema";`
   - `src/db/pg/schema.ts`: `export * from "./proposals.schema";`
   - `src/db/schema.ts`: import both (`sqliteProposals`, `pgProposals`), add to
     the `AppSchema` intersection, both runtime spreads, and add `proposals` to
     the destructured `export const { ... } = schema;`
   - `src/db/schema-parity.test.ts`: import both modules and add them to the
     `sqliteAppTables` / `pgAppTables` `tablesFrom(...)` calls.

4. **Migrations**: `pnpm db:generate` (emits into `drizzle/` AND
   `drizzle-pg/`; optionally `pnpm db:generate:d1 -- --name=proposals` and
   `pnpm db:generate:pg -- --name=proposals` for a readable slug), then
   `pnpm db:migrate:local`. Commit the SQL + `meta/` snapshots untouched.
   Verify: `pnpm test` (parity test now covers the new table).

5. **Input schemas** — `src/types/schemas/proposals.ts`:

```ts
import { z } from "zod";

export const listProposalsSchema = z.object({ projectId: z.string().min(1) });

export const createProposalSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().trim().min(1, "Title is required").max(200),
});

export type CreateProposalInput = z.infer<typeof createProposalSchema>;
```

6. **Repository** — `src/server/features/proposals/repositories/ProposalRepository.ts`:
   free functions over `db` + tables from `@/db/schema`; `crypto.randomUUID()`
   ids; org scoping is NOT its concern (the middleware resolved the project);
   every query constrains by `projectId`; bulk writes via
   `executeInBatches`; export `as const` object.

7. **Service** — `src/server/features/proposals/services/ProposalService.ts`
   (skip if the feature is pure CRUD-thin — but upstream still keeps a thin
   `services/` module for mapping rows to wire shapes, cf. `projects.ts`'s
   `mapProject`): business rules, `AppError` translation, Workflow/provider
   orchestration, colocated `*.test.ts` using the §7 mock pattern.

8. **Server functions** — `src/serverFunctions/proposals.ts`:

```ts
import { createServerFn } from "@tanstack/react-start";
import { ProposalService } from "@/server/features/proposals/services/ProposalService";
import { requireProjectContext } from "@/serverFunctions/middleware";
import { createProposalSchema, listProposalsSchema } from "@/types/schemas/proposals";

export const getProposals = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(listProposalsSchema)
  .handler(async ({ context }) => ProposalService.list(context.projectId));

export const createProposal = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(createProposalSchema)
  .handler(async ({ data, context }) =>
    ProposalService.create(context.projectId, data),
  );
```

   Add `waitUntil(captureServerEvent({ event: "proposals:create", ... }))` for
   meaningful actions. Hosted-only gating goes here too:
   `if (await isHostedServerAuthMode() && !(await customerHasPaidPlan(context.organizationId))) throw new AppError("PAYMENT_REQUIRED", ...)`.

9. **Client** — `src/client/features/proposals/ProposalsPage.tsx` (+ hooks):

```ts
const proposalsQuery = useQuery({
  queryKey: ["proposals", projectId],
  queryFn: () => getProposals({ data: { projectId } }),
});

const createMutation = useMutation({
  mutationFn: (title: string) => createProposal({ data: { projectId, title } }),
  onSuccess: () =>
    void queryClient.invalidateQueries({ queryKey: ["proposals", projectId] }),
  onError: (error) =>
    toast.error(getStandardErrorMessage(error, "Couldn't create the proposal. Try again.")),
});
```

10. **Route + nav** — `src/routes/_project/p/$projectId/proposals.tsx` with
    `createFileRoute(...)({ component: ... })` (routeTree regenerates on dev
    build; never hand-edit `routeTree.gen.ts`), and an entry in
    `src/client/navigation/items.ts` (`projectNavItems` + the appropriate group
    in `getProjectNavGroups`, lucide icon).

11. **If a long-running pipeline is needed** (Articles): a Workflow class in
    `src/server/workflows/`, registered in `wrangler.jsonc` `workflows` +
    exported from `src/server.ts` + the binding added to `src/env.d.ts`; DB
    access inside steps via `pgStep(step, "name", config, fn)`; a one-in-flight
    guard as a partial unique index (`WHERE status IN ('pending','running')`),
    mirroring `rank_check_runs`.

12. **Run the gate**: `pnpm ci:check`, `pnpm test:ci`, `pnpm vite build`.

---

## 9. House style (things reviewers/the owner will notice)

- Comment voice: explanatory WHY-comments, lowercase mid-sentence style,
  concrete numbers and incident references ("incident 2026-07-06"), no
  decorative comment banners except the `// ---- Section ----` dividers used
  inside large repositories. Every non-obvious index, cast, or guard has one.
- `oxlint-disable-next-line` always carries a `-- reason` suffix.
- No classes for services/repositories; no DI; no barrel `index.ts` except
  where upstream already has one (`client/tanstack-db`,
  `keywords/components`). "Keep code flat. Flag one-use managers, factories,
  base repositories, dependency-injection layers …" (`.greptile/rules.md`).
- `z.infer` types are exported next to their schemas; server return shapes are
  either inferred or small exported `interface`s in the serverFunctions file
  (`RankKeywordHistoryPoint`).
- Imports use the `@/` alias everywhere; serverFunctions import order tends to
  be: framework, cloudflare, server features/lib, middleware, types/schemas.
- `success`/`ok` result objects: `return { success: true }` or
  `{ ok: true as const }` — both exist; match the nearest neighbor.
- Never `console.log`; `console.error` for faults, `console.info` with a
  `[feature]` prefix for expected skips, `console.warn` for degraded caches.
- Copy in errors/toasts: sentence case, imperative fix ("Pick a different name
  or add a domain."), product nouns capitalized.
- `docs/`, `specs/` (numbered ADR-ish specs), `release-notes/vX.Y.Z.md`, and
  `.agents/PAPERCUTS.md` are living docs — a feature of this size would ship
  with a spec file (`specs/000N-*.md`, sections: Status/Context/Decision/
  Rationale/Consequences) and a release-note entry.
