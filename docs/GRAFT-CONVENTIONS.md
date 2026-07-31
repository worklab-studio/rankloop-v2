# Graft conventions: adding a feature to the OpenSEO dashboard the native way

Reference for grafting the "Write" feature group (Opportunities, Articles,
Receipts) into `apps/dashboard` so it is indistinguishable from upstream code.
Every claim below is grounded in a file path; when in doubt, open the cited
file and copy its shape.

The worked example throughout is **rank-tracking** (list screen + detail
screen + server functions + schema + both DB dialects + tests), with
**saved-keywords** as the single-screen table variant.

---

## 1. The repo's own rulebooks (read these first)

| File | What it governs |
|---|---|
| `apps/dashboard/AGENTS.md` and `apps/dashboard/CLAUDE.md` (identical) | Engineering principles |
| `apps/dashboard/.greptile/rules.md` + `.greptile/config.json` | The automated review bot's rules — PRs are reviewed against these |
| `apps/dashboard/.agents/PAPERCUTS.md` | Known tooling friction (worktree gotchas) |
| `apps/dashboard/docs/CONTRIBUTING.md` | The exact pre-review command list |
| `apps/dashboard/docs/LOCAL_DEVELOPMENT.md` | Dev setup, `AUTH_MODE`, DB commands |
| `apps/dashboard/docs/MAINTAINERS.md` | Release-notes workflow (`pnpm release:notes`) |

The load-bearing principles from AGENTS.md, verbatim:

> - Prefer simple, readable, flat code with minimal indirection.
> - For new application-backed backend functionality, default to: TanStack server function → service → repository.
> - Keep schema changes, queries, and mutations compatible with both SQLite and Postgres.
> - Use idiomatic TypeScript. Use Zod to validate untrusted data and narrow runtime values at trust boundaries.
> - Prefer idiomatic TanStack Query, Router, and Form patterns for server state, routing, and submitted forms.

And the review bot's backend law (`.greptile/rules.md`):

> ```text
> TanStack server function -> service -> repository -> provider-aware db/schema
> ```
> - Do not put new database or provider orchestration directly in `src/serverFunctions/**`.
> - Do not create an empty repository for provider-only or pure-computation features.

Also from rules.md, directly relevant to a grafted UI feature:

> Query keys include project or tenant scope when the result is scoped, plus
> every semantic input that changes the result.

> A change that alters … persistence or query behavior, schema or migrations …
> must include a focused behavioral test.

Changes to `.greptile/**`, `AGENTS.md`, `CLAUDE.md`, `.agents/skills/**`, and
`.github/**` are treated as review-control-plane changes needing maintainer
approval — a graft should not touch them.

---

## 2. Directory map (where each piece of a feature lives)

```
apps/dashboard/src/
  routes/_project/p/$projectId/     file-based routes (thin; page orchestration only)
  client/features/<feature>/        all feature UI: components, hooks, logic, tests
  client/components/                shared UI (Modal, Sidebar, table/AppDataTable, …)
  client/navigation/items.ts        THE nav registry (items + groups)
  client/lib/                       posthog, error-messages, dropdown helpers
  serverFunctions/<feature>.ts      createServerFn endpoints (transport layer only)
  server/features/<feature>/
    services/<X>Service.ts          business rules, provider calls, billing gates
    repositories/<X>Repository.ts   all Drizzle queries
  types/schemas/<feature>.ts        Zod input schemas + API/UI types
  shared/<feature>.ts               constants/pure fns used by BOTH client and server
  db/app.schema.ts                  SQLite (D1) table definitions
  db/pg/app.schema.ts               Postgres twins of the same tables
  db/schema.ts                      provider-aware barrel (add new tables to the export)
  middleware/ensureUser.ts          global auth + projectId → project resolution
```

Naming, exactly as upstream:

- feature dirs: kebab-case (`rank-tracking`, `saved-keywords`)
- components: `PascalCase.tsx`, prefixed with the feature name
  (`RankTrackingDomainList.tsx`, `SavedKeywordsTable.tsx`); big screens split
  into `…Parts.tsx`, `…Columns.tsx`, `…Toolbar.tsx` satellites
- hooks: `useCamelCase.ts` (`useSavedKeywordsFilters.ts`, `useRankRunPolling.ts`)
- pure logic pulled out for testing: `camelCase.ts` or `X.logic.ts`
  (`RankTrackingFilters.logic.ts`, `savedKeywordsUtils.ts`)
- tests: colocated `X.test.ts` next to the file under test

---

## 3. Worked example: rank-tracking end to end

### 3.1 Routes (list + detail under a layout)

Three files. The layout owns the page header; children render into `<Outlet />`.

`src/routes/_project/p/$projectId/rank-tracking.tsx` — the whole file:

```tsx
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_project/p/$projectId/rank-tracking")({
  component: RankTrackingLayout,
});

function RankTrackingLayout() {
  return (
    <div className="px-4 py-4 pb-24 overflow-auto md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-7xl space-y-4">
        <div>
          <h1 className="text-2xl font-semibold">Rank Tracking</h1>
          <p className="text-sm text-base-content/70">
            Track keyword positions across domains
          </p>
        </div>

        <Outlet />
      </div>
    </div>
  );
}
```

Note the copy voice: Title Case `h1`, sentence-case subtitle, **no trailing
period** on the subtitle.

`src/routes/_project/p/$projectId/rank-tracking/index.tsx` (list screen) and
`…/rank-tracking/$configId.tsx` (detail screen) are thin: they read params via
`Route.useParams()`, own modal open/close state and query invalidation, and
delegate rendering to feature components:

```tsx
export const Route = createFileRoute("/_project/p/$projectId/rank-tracking/")({
  component: RankTrackingIndex,
});
```

The detail route resolves its entity from the list query rather than a
dedicated endpoint:

```tsx
const { data: configs, isPending } = useQuery({
  queryKey: ["rankTrackingConfigs", projectId],
  queryFn: () => getRankTrackingConfigs({ data: { projectId } }),
});

const config = configs?.find((c) => c.id === configId) ?? null;
```

Pending state is the daisyUI spinner; not-found is plain copy + a ghost button:

```tsx
if (isPending) {
  return (
    <div className="flex items-center justify-center py-20">
      <span className="loading loading-spinner loading-lg" />
    </div>
  );
}
```

Single-screen features skip the layout/index split: `saved.tsx` is one route
file whose component orchestrates the whole page (wrapper
`"overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8"`, inner
`"mx-auto max-w-6xl space-y-4"`).

SSR is disabled once for the whole project subtree in
`src/routes/_project/p/$projectId/route.tsx` — do not re-declare it:

```tsx
export const Route = createFileRoute("/_project/p/$projectId")({
  // Everything under this subtree fetches its data client-side with
  // react-query, so SSR would only render empty chrome.
  ssr: false,
  component: ProjectLayout,
});
```

### 3.2 Zod schema file — `src/types/schemas/rank-tracking.ts`

One file per feature. Section dividers are a house style:

```ts
// ---------------------------------------------------------------------------
// DB-derived types
// ---------------------------------------------------------------------------

export type RankTrackingConfig = InferSelectModel<typeof rankTrackingConfigs>;
```

**Every project-scoped input schema starts with `projectId`** — this is
load-bearing, not style. `ensureUserMiddleware`
(`src/middleware/ensureUser.ts`) extracts `data.projectId` from every server
function call and resolves+authorizes the project against the caller's
organization *before the handler runs*:

```ts
export const getConfigsSchema = z.object({
  projectId: z.string().uuid(),
});
```

Enums are derived from the Drizzle column, never duplicated:

```ts
const devicesEnum = z.enum(rankTrackingConfigs.devices.enumValues);
```

Bulk inputs are bounded (`.max(2000)`), lengths capped with shared constants
(`MAX_TRACKED_KEYWORD_LENGTH` from `@/shared/rank-tracking`).

### 3.3 Server functions — `src/serverFunctions/rank-tracking.ts`

The invariant shape, used by every endpoint in the file:

```ts
export const getRankTrackingConfigs = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getConfigsSchema)
  .handler(async ({ context }) => {
    return RankTrackingRepository.getConfigsForProject(context.projectId);
  });
```

- always `{ method: "POST" }`
- `requireProjectContext` from `@/serverFunctions/middleware` narrows the
  context to `{ userId, userEmail, organizationId, project, projectId }`
- handlers use `context.projectId` (verified), never `data.projectId`
- mutations go through the Service; trivial reads may call the Repository
  directly (see `getRankTrackingConfigs` above — that is upstream's own call)
- errors: `throw new AppError("PAYMENT_REQUIRED", "Upgrade to …")` from
  `@/server/lib/errors`; codes come from the closed set in
  `src/shared/error-codes.ts` (add a code there + a message in
  `src/client/lib/error-messages.ts` if you truly need a new one)
- server-side analytics on mutations, fire-and-forget:

```ts
import { waitUntil } from "cloudflare:workers";
...
waitUntil(
  captureServerEvent({
    distinctId: context.userId,
    event: "rank_tracking:config_create",
    organizationId: context.organizationId,
    properties: { project_id: context.projectId, domain: data.domain },
  }),
);
```

Event naming: `feature_snake:action_snake` (`rank_tracking:check_trigger`,
`saved_keywords:bulk_remove`, `dashboard:next_move_click`).

Hosted-plan gating, when a feature costs money:

```ts
const isHosted = await isHostedServerAuthMode();
if (isHosted && !(await customerHasPaidPlan(context.organizationId))) {
  throw new AppError(
    "PAYMENT_REQUIRED",
    "Upgrade to the paid plan to run rank checks",
  );
}
```

### 3.4 Service and repository — `src/server/features/rank-tracking/`

Both use the same export idiom: **module-level `async function`s aggregated
into a single const object at the bottom** — no classes:

```ts
export const RankTrackingRepository = {
  getConfigsForProject,
  getConfigById,
  createConfig,
  updateConfig,
  ...
};
```

Repository rules:

- import `db` from `@/db` and tables from `@/db/schema` — importing
  `@/db/d1/*` or `@/db/pg/*` anywhere else is an oxlint **error**
  (`eslint/no-restricted-imports` in `.oxlintrc.json`)
- typed inserts via `InferInsertModel<typeof table>`
- single-row fetch: `.limit(1)` then `return rows[0] ?? null;`
- batched writes via `executeInBatches` from `@/db/runBatch`; all-or-nothing
  multi-writes via `runBatch` (greptile rule "atomic-multi-write")
- every query is scoped: `and(eq(t.id, id), eq(t.projectId, projectId))`

Service rules: business invariants live here with WHY comments (see the
archived-config reactivation block in `RankTrackingService.ts` lines 61–98),
IDs are `crypto.randomUUID()` minted in the service, provider/billing failures
become `AppError`s.

### 3.5 DB schema — both dialects, always

Tables are defined **twice**: `src/db/app.schema.ts` (sqlite) and
`src/db/pg/app.schema.ts` (pg), same table/column/index names. The section
banner style in both files:

```ts
// ============================================================================
// Rank Tracking tables
// ============================================================================

// One configuration per project+domain — defines what domain to track and how
export const rankTrackingConfigs = sqliteTable(
```

Column conventions:

- `id: text("id").primaryKey()` (UUID minted app-side); autoincrement only for
  high-volume append-only rows (`rankSnapshots` uses
  `integer("id").primaryKey({ autoIncrement: true })` / `serial` in pg)
- snake_case SQL names, camelCase TS names
- timestamps are **text**. SQLite: `.default(sql`(current_timestamp)`)`.
  Postgres: the `timestampColumn(name)` helper + `.default(isoNow)` from the
  top of `pg/app.schema.ts` — read its header comment; the two defaults are
  intentionally not byte-identical
- booleans: `integer("is_active", { mode: "boolean" })` in sqlite,
  `boolean("is_active")` in pg
- enums inline on the text column:
  `text("devices", { enum: ["both", "desktop", "mobile"] })`
- FKs always declare `onDelete: "cascade"` (or a comment explaining why there
  is deliberately no FK — see `rankSnapshots.trackingKeywordId`)
- indexes as the third argument array; partial unique indexes for
  admission-control invariants (one active run per config) rather than
  count-then-act logic

Then register the new tables in the barrel `src/db/schema.ts`: add each table
name to the destructured `export const { … } = schema;` list (if you created a
new `*.schema.ts` module instead of extending `app.schema.ts`, also add it to
the `AppSchema` type intersection, both runtime spreads, and the import lists
in `schema-parity.test.ts`).

`src/db/schema-parity.test.ts` automatically asserts your sqlite and pg
definitions are structurally interchangeable — it will fail CI if the dialects
drift. That test is the drift guard; no action needed beyond keeping both
files in sync.

### 3.6 Migrations (codegen)

```sh
pnpm run db:generate        # runs drizzle-kit for BOTH dialects
pnpm run db:migrate:local   # applies the D1 migration to the local DB
```

Output lands in `drizzle/00NN_<name>.sql` and `drizzle-pg/00NN_<name>.sql`.
Names are drizzle-kit's random two-word slugs (`0036_curvy_silk_fever.sql`) —
accept them; a few are hand-named (`0029_location_name.sql`) via
`drizzle-kit generate --name`. Never hand-edit `drizzle*/meta/**`. Greptile:
"Review generated migration SQL semantically even though metadata snapshots
are ignored."

### 3.7 Shared constants — `src/shared/rank-tracking.ts`

Anything both client and server need (limits, cost math, label formatters)
lives in `src/shared/<feature>.ts` with doc-comment constants:

```ts
/** Maximum keywords allowed per rank tracking config */
export const MAX_KEYWORDS_PER_CONFIG = 1000;
```

`src/shared/` files must stay importable from the browser bundle — no
`cloudflare:workers`, no server-only imports.

### 3.8 Client feature dir + query conventions

Query keys are **inline literal arrays** (no central key factory), camelCase
noun first, projectId second, then every semantic input:

```ts
useQuery({
  queryKey: ["rankTrackingConfigSummaries", projectId],
  queryFn: () => getRankTrackingConfigSummaries({ data: { projectId } }),
});

useQuery({
  queryKey: ["savedKeywords", projectId, queryInput],
  queryFn: () => getSavedKeywords({ data: queryInput }),
  placeholderData: keepPreviousData,
});
```

Invalidation is prefix-based and wrapped in `void`:

```ts
const invalidateSavedKeywords = () =>
  queryClient.invalidateQueries({ queryKey: ["savedKeywords", projectId] });
```

Mutations: `useMutation` + `sonner` toasts with hand-pluralized counts +
`getStandardErrorMessage` fallback:

```ts
onSuccess: (result) => {
  void invalidateSavedKeywords();
  toast.success(
    `${result.deletedCount} keyword${result.deletedCount !== 1 ? "s" : ""} removed`,
  );
},
onError: (error) => {
  toast.error(getStandardErrorMessage(error, "Could not update tags"));
},
```

Client-side types are derived from the server function, not re-declared:

```ts
type ConfigSummary = Awaited<
  ReturnType<typeof getRankTrackingConfigSummaries>
>[number];
```

Tables: build on `src/client/components/table/` (`useAppTable`,
`makeSelectionColumn`, `SortableHeader`, `TablePagination`,
`TableBulkActionBar`) — do not hand-roll table plumbing. Modals: the shared
`Modal` in `src/client/components/Modal.tsx` (`card bg-base-100 border
border-base-300`, Escape-to-close).

Styling is daisyUI + Tailwind utility classes, theme tokens only (`bg-base-100`,
`border-base-300`, `text-base-content/70`, `btn btn-primary btn-sm`,
`skeleton`, `loading loading-spinner`). Icons are `lucide-react`, sized
`h-4 w-4` / `size-3.5`. Never hex colors; the themes are defined in
`src/client/styles/app.css` (`openseo` / `openseo-dark`).

External URLs from crawl/API/LLM data must render through `SafeExternalLink` /
`getSafeExternalUrl` (greptile rule "safe-external-links").

---

## 4. Checklist 1 — the "Write" nav group (3 items)

Everything is in **`src/client/navigation/items.ts`** plus the sidebar reads
it generically (`src/client/components/Sidebar.tsx` maps
`getProjectNavGroups(projectId)` — no sidebar edits needed).

1. Add three entries to the `projectNavItems` array, matching the existing
   object shape exactly:

   ```ts
   {
     to: "/p/$projectId/opportunities" as const,
     label: "Opportunities",
     icon: Lightbulb,
   },
   ```

   Labels are Title Case, `to` strings end with `as const`. Pick lucide icons
   and add them to the alphabetized import at the top of the file (upstream
   uses `Bookmark, Bot, ClipboardCheck, Globe, LayoutDashboard, …`).

2. Add the group in `getProjectNavGroups`'s returned array — position in the
   array is position in the sidebar (between "Research" and "My Site", or
   wherever it belongs):

   ```ts
   {
     label: "Write",
     items: [
       byPath("/p/$projectId/opportunities"),
       byPath("/p/$projectId/articles"),
       byPath("/p/$projectId/receipts"),
     ],
   },
   ```

   `byPath` is the file's own helper (`all.find((i) => i.to === path)!`).
   Group labels render uppercase via CSS (`uppercase tracking-wider`) — write
   them Title Case in code. Note the existing one-line comment above the
   function explaining group semantics; extend it if "Write" needs a one-line
   rationale.

3. The route paths only typecheck once the route files exist and the route
   tree regenerates (section 7). Add routes first or in the same change.

---

## 5. Checklist 2 — a new feature (table screen + detail + server fns + schema)

File-by-file, in dependency order. Substitute `articles` for your feature.

1. **DB tables** — `src/db/app.schema.ts` AND `src/db/pg/app.schema.ts`
   (section banner comment, both dialects, scoped FK to `projects`), then add
   table names to the destructure in `src/db/schema.ts`.
2. **Migrations** — `pnpm run db:generate && pnpm run db:migrate:local`.
3. **Shared constants** (if any) — `src/shared/articles.ts` (+ colocated
   `articles.test.ts` for any math/formatting).
4. **Schema file** — `src/types/schemas/articles.ts`: Zod input schemas
   (every one containing `projectId: z.string().uuid()`), DB-derived types via
   `InferSelectModel`, API/UI row types.
5. **Repository** — `src/server/features/articles/repositories/ArticlesRepository.ts`:
   plain async functions + aggregate export const.
6. **Service** — `src/server/features/articles/services/ArticlesService.ts`:
   invariants, `crypto.randomUUID()` IDs, `AppError` on rule violations.
   Skip the service for pure-read features ("Do not create an empty
   repository for provider-only or pure-computation features" — and
   conversely, don't add a pass-through service that only forwards to the
   repository).
7. **Server functions** — `src/serverFunctions/articles.ts`: the
   `createServerFn({ method: "POST" }).middleware(requireProjectContext)
   .validator(x).handler(...)` chain per endpoint; `waitUntil(captureServerEvent(...))`
   on mutations.
8. **Feature UI** — `src/client/features/articles/`: `ArticlesTable.tsx`,
   `ArticlesFilters.tsx`, `useArticlesFilters.ts`, etc. Keep each file under
   the 400-line lint cap (section 8) — that cap is *why* upstream features are
   split into many small files.
9. **Routes** — for list+detail:
   `src/routes/_project/p/$projectId/articles.tsx` (layout: h1 + subtitle +
   `<Outlet />`), `…/articles/index.tsx` (table screen),
   `…/articles/$articleId.tsx` (detail). For single screens: one
   `…/receipts.tsx`.
10. **Nav** — section 4.
11. **Tests** — section 6.
12. **(Optional, very native)** a numbered design note in
    `apps/dashboard/specs/` (`0009-write-queue.md`, next number in sequence)
    written as explanatory prose: "The feature / how it works / why it works
    that way", like `specs/0008-local-rank-tracking-locations.md`.

What NOT to do (each of these is an upstream tell of foreign code):

- a `queryKeys.ts` factory, `api/` client wrapper, or barrel `index.ts` in the
  feature dir (knip will also flag unused exports)
- classes for services/repositories
- `GET` server functions, fetch calls, or REST routes under `src/routes/api/`
  (that dir is for auth/webhook/OAuth plumbing only)
- storing relational data as JSON to avoid a join (AGENTS.md prohibits it)
- CSS files, styled-components, hex colors, non-daisyUI component kits
- `console.log` — upstream uses sparse `console.info("[rank-tracking] …")`
  with a bracketed feature prefix, and only for operational skips/failures

---

## 6. Checklist 3 — tests

### Unit/behavior tests (vitest)

`vitest.config.ts` — the whole story:

```ts
test: {
  environment: "node",
  include: ["src/**/*.test.ts"],
  restoreMocks: true,
  clearMocks: true,
},
```

- **Node environment, `.test.ts` only** — there are no component/DOM tests.
  Testable behavior is extracted into pure modules
  (`RankTrackingFilters.logic.ts`, `savedKeywordsUtils.ts`,
  `rankTrackingScorecards.ts`) and tested with plain `describe/it/expect`.
- Colocate: `src/client/features/rank-tracking/RankTrackingFilters.test.ts`
  sits next to what it tests. Same for `src/shared/*.test.ts` and
  `src/server/**/*.test.ts`.
- Service tests mock the repository + workers runtime with hoisted mocks and
  dynamic import (`RankTrackingService.test.ts`):

  ```ts
  const mocks = vi.hoisted(() => ({
    getConfigByProjectDomainLocation: vi.fn(),
    ...
  }));

  vi.mock("cloudflare:workers", () => ({ env: {} }));
  vi.mock(
    "@/server/features/rank-tracking/repositories/RankTrackingRepository",
    () => ({ RankTrackingRepository: mocks }),
  );
  ...
  const { RankTrackingService } = await import("./RankTrackingService");
  ```

- Test names state behavior, often the invariant: `it("reactivates an
  archived config instead of throwing, applying the new settings", …)`.
- Repository SQL itself is not integration-tested; only its pure helpers are
  (`snapshotQueries.test.ts` tests timestamp formatting).
- The greptile "behavior-evidence" rule: schema/persistence/billing/URL-state
  changes need a focused behavioral test; a bug fix should reproduce the old
  failure.

Run: `pnpm test` (CI uses `pnpm test:ci` = `vitest run --reporter=dot`).

### E2E (playwright) — optional for a graft, but here is the shape

- Specs in `apps/dashboard/e2e/*.spec.ts`; per-feature fixture data in
  `e2e/fixtures/<feature>-fixtures.ts`, activated by env flags the webServer
  passes (`VITE_E2E_DOMAIN_FIXTURES=1 VITE_E2E_KEYWORD_FIXTURES=1` in
  `playwright.config.ts` — a new fixture set means a new flag there).
- The server runs `AUTH_MODE=local_noauth` on port 3101; tests bootstrap by
  navigating `/` and parsing the project id from the redirect URL
  (`getProjectId(page)` helper in `keyword-research-navigation.spec.ts`).
- Locators are role-based first, `data-testid` where roles are ambiguous;
  URL assertions via `expect.poll(() => new URL(page.url()).searchParams…)`.
- Each spec gets a `test:e2e:<name>` script in `package.json` mirroring
  `test:e2e:keywords`.

---

## 7. Codegen you must know about

| Artifact | Generator | When |
|---|---|---|
| `src/routeTree.gen.ts` | the `tanstackStart()` vite plugin (see `vite.config.ts`) regenerates it automatically during `vite dev` / `vite build` | after adding/renaming any file under `src/routes/` — run `pnpm dev` once or `pnpm vite build` |
| `drizzle/`, `drizzle-pg/` | `pnpm run db:generate` (both dialects; configs `drizzle.config.ts` + `drizzle-pg.config.ts`) | after editing either `app.schema.ts` |
| `worker-configuration.d.ts` | `pnpm cf-typegen` (`wrangler types`) | only if you add Workers bindings in `wrangler.jsonc` — a UI graft normally doesn't |
| `src/db/better-auth-schema.ts` (+pg) | `pnpm auth:generate` | never for a feature graft |

`routeTree.gen.ts` is deliberately excluded everywhere — `.oxlintrc.json`
`ignorePatterns`, `.prettierignore`, knip `project` excludes, greptile
`ignorePatterns`. **Never hand-edit it, commit whatever the plugin generates.**
Until it regenerates, `createFileRoute("/_project/p/$projectId/articles")`
and the nav `to:` strings will not typecheck — that is expected mid-change.

---

## 8. Lint, format, and CI — what will reject grafted code

CI (`.github/workflows/ci.yml`) runs exactly what CONTRIBUTING.md tells you to
run locally:

```sh
pnpm ci:check     # prettier --check . && knip && tsc --noEmit
                  #   && tsc --noEmit -p badseo/tsconfig.json && oxlint . --type-aware
pnpm test:ci
pnpm vite build   # also runs the lean-worker-bundle eager-import guard
```

### oxlint (`.oxlintrc.json`) — the rules that actually bite

- `eslint/max-lines: 400` (excluding blanks/comments) and
  `max-lines-per-function: 320` — **split files the way upstream does**
  (`…Parts.tsx`, `…Columns.tsx`, extracted hooks) instead of writing one big
  screen file. Also `complexity: 40`, `max-depth: 4`, `max-params: 5`.
- `typescript/no-explicit-any`, plus the full `no-unsafe-*` family and
  `no-unsafe-type-assertion` — no `as Foo` casts. Where upstream truly needs
  one it carries a justification:
  `// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- guarded by schema-parity.test.ts`
- `typescript/consistent-type-imports` — `import type { … }` for type-only
  imports, everywhere.
- `unicorn/no-array-sort` — use `.toSorted()`, never `.sort()`.
- `import/no-cycle`.
- `eslint/no-restricted-imports` — `@/db/d1/*` and `@/db/pg/*` are banned
  outside `src/db/**` and `src/lib/auth.ts`; import `db` from `@/db`, tables
  from `@/db/schema`.
- Floating promises are consistently `void`-prefixed
  (`void navigate({...})`, `void queryClient.invalidateQueries(...)`).

### prettier

No `.prettierrc` — **stock defaults**: double quotes, semicolons, trailing
commas, 2-space indent, 80-col wrap. `.prettierignore` covers generated files.
Run `pnpm format:check` before pushing; a single-quoted file is an instant
foreign-code tell *and* a CI failure.

### knip (`knip.jsonc`)

Unused exports, files, and dependencies **fail CI**. Do not export "for
later"; do not add a dependency the graft doesn't import. Route files are
entry points; everything else must be reachable from them.

### tsc

`strict: true`, path alias `@/* → ./src/*` (`tsconfig.json`). All imports use
`@/…` — upstream never uses relative imports across directories (relative
`./` only within the same feature dir).

---

## 9. Voice and polish (the "doesn't look AI-generated" layer)

- **Comments explain WHY, not what**, and are load-bearing prose. Examples to
  imitate: the `activeOptions` comment in `navigation/items.ts` ("Without
  exact matching, the index path is a prefix of every project route…"), the
  reactivation block in `RankTrackingService.createConfig`, the index
  rationale comments in `app.schema.ts` ("No standalone index on runId — the
  unique index below has it as its leftmost column…"). Comments carry concrete
  numbers and tradeoffs; there are no `// TODO`, no `// Step 1:` narration,
  no restating the code.
- Section dividers: `// ----…----` (77 chars) in schemas/services/repos,
  `// ====…====` in db schema files.
- UI copy: Title Case for nav labels, headings, buttons ("Add Domain",
  "Tracked Domains"); sentence case for subtitles/status text, subtitles
  without trailing periods, toasts/errors with them. Counts always
  hand-pluralized.
- Empty/loading states: `skeleton` rows for lists, `loading loading-spinner
  loading-lg` centered `py-20` for pages, and empty states are designed (icon
  in a `rounded-xl bg-base-200` tile + copy), not "No data".
- Small numeric UX thresholds get named constants with a comment
  (`FILTER_BAR_MIN_DOMAINS = 6`, `FILTER_DEBOUNCE_MS = 350`).
- PostHog events accompany meaningful user actions, client-side via
  `captureClientEvent("articles:export", {...})`
  (`src/client/lib/posthog.ts`), server-side via `captureServerEvent` +
  `waitUntil`.
- Commit style (from MAINTAINERS.md release tooling): conventional-ish
  prefixes exist (`chore:`, `ci:`, `test:`, `build:`, `release:` are filtered
  out of release notes) — feature commits are plain user-facing descriptions.

## 10. Known tooling papercuts (`.agents/PAPERCUTS.md`)

- Fresh git worktree: `oxlint --type-aware` crashes with
  `Cannot find module '@oxlint/binding-darwin-arm64'`; fix with
  `pnpm install --force` (~22s).
- Regenerating the lockfile can trip the `minimumReleaseAge` gate on
  already-pinned transitive deps; unblock with
  `pnpm install --config.minimumReleaseAge=0` and keep the lockfile diff
  version-neutral.
- `web/` and `badseo/` are separate workspaces needing their own
  `pnpm --dir <ws> install` before their builds run. Neither is touched by a
  dashboard feature graft, but `tsc -p badseo/tsconfig.json` runs in
  `ci:check`.
