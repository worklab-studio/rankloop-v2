import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  real,
  serial,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projects } from "./app.schema";

// See src/db/pg/app.schema.ts for why timestamps are ISO-8601 UTC text.
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// ============================================================================
// rankloop Write side — decisions out (competitors, backlog, page plan,
// proposals, articles, receipts, spend, GSC sync runs, site study runs,
// competitor study runs, writer settings)
// ============================================================================

// The keyword backlog. searchVolume/keywordDifficulty are nullable by
// doctrine: free sources (autocomplete, harvest) have no metrics, and a
// volume floor would starve every NULL-volume long-tail row — selection
// must run with min_volume=0.
export const keywordBacklog = pgTable(
  "keyword_backlog",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    keyword: text("keyword").notNull(),
    source: text("source", {
      enum: ["gsc", "gap", "expansion", "autocomplete", "harvest", "manual"],
    }).notNull(),
    seed: text("seed"),
    category: text("category"),
    format: text("format"),
    // set null, not cascade: declining a page type must not delete the
    // keywords that were clustered under it — they go back to the pool.
    pageTypeId: text("page_type_id").references(() => pageTypes.id, {
      onDelete: "set null",
    }),
    searchVolume: integer("search_volume"),
    keywordDifficulty: integer("keyword_difficulty"),
    intent: text("intent"),
    // Free sources get a neutral prior here, not a metric-derived score, so
    // they surface via the pool mix instead of outranking metric rows.
    score: real("score").notNull().default(0),
    // Harvesters never pass status — the 'discovered' default is what
    // selection picks from.
    status: text("status", {
      enum: [
        "discovered",
        "planned",
        "proposed",
        "queued",
        "published",
        "skipped",
        "needs_human",
      ],
    })
      .notNull()
      .default("discovered"),
    clusterKey: text("cluster_key"),
    notesJson: text("notes_json"),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("keyword_backlog_project_keyword_idx").on(
      table.projectId,
      table.keyword,
    ),
  ],
);

// Page-type proposals from site study: a pSEO template, blog category or hub
// plus the evidence that justified proposing it. Approval is a human
// decision (decidedAt), never automatic.
export const pageTypes = pgTable(
  "page_types",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["pseo", "blog", "hub"] }).notNull(),
    status: text("status", { enum: ["proposed", "approved", "declined"] })
      .notNull()
      .default("proposed"),
    urlPattern: text("url_pattern"),
    keywordPattern: text("keyword_pattern"),
    templateContractJson: text("template_contract_json"),
    // { mode: 'dataset' | 'compiled' | null, ...config }
    dataSourceJson: text("data_source_json"),
    // No FK: content_pages lives in rankloop-data.schema.ts, which already
    // imports pageTypes from this file — an FK back would be an import
    // cycle. A dangling id after a manifest prune is acceptable for a hub
    // pointer; the UI treats a miss as "hub page gone".
    hubContentPageId: text("hub_content_page_id"),
    // Keyword/competitor evidence backing the proposal (counts, sample
    // queries) — kept so the approval screen can show WHY, not just what.
    evidenceJson: text("evidence_json"),
    // Live-SERP sanity check captured at proposal time.
    serpCheckJson: text("serp_check_json"),
    demand: integer("demand"),
    instanceCount: integer("instance_count").notNull().default(0),
    createdAt: text("created_at").notNull().default(isoNow),
    decidedAt: text("decided_at"),
  },
  (table) => [
    uniqueIndex("page_types_project_name_idx").on(table.projectId, table.name),
  ],
);

// The "no data row, no page" backbone: a pSEO article may only be briefed
// when its entity has a row here. provenanceJson records per-cell sourceUrl
// + fetchedAt — every value must say where it came from, and cells that
// can't are what needsReview flags for a human.
export const pageTypeData = pgTable(
  "page_type_data",
  {
    id: text("id").primaryKey(),
    pageTypeId: text("page_type_id")
      .notNull()
      .references(() => pageTypes.id, { onDelete: "cascade" }),
    entity: text("entity").notNull(),
    rowJson: text("row_json").notNull(),
    provenanceJson: text("provenance_json").notNull(),
    confidence: real("confidence"),
    // 0/1; set when a cell's provenance is missing or low-confidence.
    needsReview: integer("needs_review").notNull().default(0),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("page_type_data_page_type_entity_idx").on(
      table.pageTypeId,
      table.entity,
    ),
  ],
);

// Decisions the engine proposes and a human approves. Rows are decision
// records: pageTypeId/keywordBacklogId/contentPageId are plain ids (no FKs)
// so an executed proposal survives whatever later happens to the row that
// spawned it — and contentPageId couldn't be an FK anyway (rankloop-data
// imports from this file; see hubContentPageId above).
export const proposals = pgTable(
  "proposals",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    type: text("type", {
      enum: ["write_new", "retitle", "refresh", "push", "merge", "prune"],
    }).notNull(),
    track: text("track", { enum: ["optimize", "net_new"] }).notNull(),
    status: text("status", {
      enum: [
        "proposed",
        "approved",
        "declined",
        "executing",
        "done",
        "measured",
        "expired",
      ],
    })
      .notNull()
      .default("proposed"),
    // Keyword (net_new) or site path (optimize).
    target: text("target").notNull(),
    title: text("title"),
    pageTypeId: text("page_type_id"),
    keywordBacklogId: text("keyword_backlog_id"),
    contentPageId: text("content_page_id"),
    score: real("score").notNull(),
    // The score's inputs, kept so the UI can explain why this ranked.
    factorsJson: text("factors_json"),
    evidenceJson: text("evidence_json"),
    createdAt: text("created_at").notNull().default(isoNow),
    expiresAt: text("expires_at"),
    decidedAt: text("decided_at"),
    executedAt: text("executed_at"),
  },
  (table) => [
    // At most one active proposal per (project, type, target), enforced at
    // the DB level — INSERT of a duplicate while one is proposed/approved/
    // executing fails with a unique-constraint violation, which is the
    // already-active signal. Terminal rows (done, measured, declined,
    // expired) fall out of the index so history accumulates freely.
    uniqueIndex("proposals_one_active_per_target_idx")
      .on(table.projectId, table.type, table.target)
      .where(sql`${table.status} IN ('proposed', 'approved', 'executing')`),
  ],
);

// One row per writing attempt-chain for a proposal. The pipeline walks
// briefing → writing → gate → (fixing → gate)* → review → approved →
// publishing → published; attempts counts gate failures.
export const articles = pgTable(
  "articles",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    proposalId: text("proposal_id")
      .notNull()
      .references(() => proposals.id, { onDelete: "cascade" }),
    // Plain id, no FK: which template briefed this article is provenance and
    // must survive the page type being declined or deleted later.
    pageTypeId: text("page_type_id"),
    keyword: text("keyword").notNull(),
    slug: text("slug"),
    title: text("title"),
    description: text("description"),
    status: text("status", {
      enum: [
        "briefing",
        "writing",
        "gate",
        "fixing",
        "review",
        "approved",
        "publishing",
        "published",
        "failed",
      ],
    })
      .notNull()
      .default("briefing"),
    attempts: integer("attempts").notNull().default(0),
    // 'agent' pipes the brief to the user's own writer (no API spend here);
    // 'api' means this app makes the calls and meters them into llm_spend.
    writerMode: text("writer_mode", { enum: ["agent", "api"] }).notNull(),
    model: text("model"),
    briefMd: text("brief_md"),
    content: text("content"),
    lawReportJson: text("law_report_json"),
    adapter: text("adapter"),
    adapterRef: text("adapter_ref"),
    publishedUrl: text("published_url"),
    publishedAt: text("published_at"),
    // What the publish injected and where: [{ contentPageId, path, outcome }].
    // Null until the links step runs, and still null after a run that injected
    // nothing. It is a record of edits made to pages rankloop does not own, so
    // it is written even when the step partly failed — the UI shows what was
    // actually touched, and a future unpublish has the list it would need to
    // reverse.
    linksInjectedJson: text("links_injected_json"),
    // Null in agent mode — spend is only known when this app made the calls.
    costUsd: real("cost_usd"),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (table) => [
    // One in-flight article per proposal: a second INSERT while any
    // non-terminal row exists fails this partial unique. Retries reuse the
    // row (attempts increments); only published/failed frees the slot.
    uniqueIndex("articles_one_in_flight_per_proposal_idx")
      .on(table.proposalId)
      .where(sql`${table.status} NOT IN ('published', 'failed')`),
  ],
);

// Before/after measurement for executed actions. baselineJson pins the
// pre-action GSC window and metrics; resultJson lands when the measurement
// window closes. 'contaminated' marks receipts whose window overlapped
// another action on the same target — the numbers would lie, so they are
// flagged rather than reported.
export const receipts = pgTable(
  "receipts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    actionType: text("action_type").notNull(),
    // Plain ids, no FKs — a receipt is the historical record of an action
    // and must outlive the article/page rows it measured.
    articleId: text("article_id"),
    contentPageId: text("content_page_id"),
    targetQuery: text("target_query"),
    status: text("status", {
      enum: ["baseline", "measuring", "measured", "contaminated"],
    })
      .notNull()
      .default("baseline"),
    baselineJson: text("baseline_json"),
    resultJson: text("result_json"),
    windowStart: text("window_start"),
    windowEnd: text("window_end"),
    measuredAt: text("measured_at"),
    // YYYY-MM-DD deferral cursor (the rank_tracking_configs.nextCheckAt
    // idiom). Null means "consider me on every tick"; a date parks a receipt
    // that the pass looked at but could not advance — a stalled sync, a pruned
    // page — until tomorrow, so it yields its slot in the 50-row pass instead
    // of holding it 96 times a day.
    nextCheckAt: text("next_check_at"),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (table) => [
    index("receipts_project_status_idx").on(table.projectId, table.status),
  ],
);

// Self-host LLM cost ledger, one row per API call (hosted metering stays
// Autumn's). articleId is null for non-article operations like site study.
export const llmSpend = pgTable(
  "llm_spend",
  {
    id: serial("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    operation: text("operation").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    costUsd: real("cost_usd").notNull(),
    articleId: text("article_id"),
    occurredAt: text("occurred_at").notNull().default(isoNow),
  },
  (table) => [
    index("llm_spend_project_occurred_idx").on(
      table.projectId,
      table.occurredAt,
    ),
  ],
);

// One row per Search Console sync execution (90-day backfill or daily
// delta). Workflow instance id === run row id — the workflow is the
// authoritative runtime, this row the durable record it reports into.
export const gscSyncRuns = pgTable(
  "gsc_sync_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    mode: text("mode", { enum: ["backfill", "daily"] }).notNull(),
    status: text("status", { enum: ["pending", "running", "done", "error"] })
      .notNull()
      .default("pending"),
    // YYYY-MM-DD in Pacific Time — GSC's reporting calendar. Daily runs
    // re-pull the trailing 3 days (GSC finalizes late), so consecutive
    // ranges overlap by design; the gsc_performance upsert absorbs it.
    rangeStart: text("range_start").notNull(),
    rangeEnd: text("range_end").notNull(),
    // Null while the run is in flight — written in the same step as the
    // final batch, alongside the flip to done.
    rowsWritten: integer("rows_written"),
    error: text("error"),
    startedAt: text("started_at").notNull().default(isoNow),
    finishedAt: text("finished_at"),
  },
  (table) => [
    // At most one active sync per project, enforced at the DB level — a
    // second INSERT while a run is pending/running fails this partial
    // unique, and that failed INSERT is the already-running signal (no
    // separate lock table; the rank_check_runs idiom).
    uniqueIndex("gsc_sync_runs_one_active_per_project_idx")
      .on(table.projectId)
      .where(sql`${table.status} IN ('pending', 'running')`),
  ],
);

// One row per site-study execution (ensure a fresh audit, then derive
// content_pages from it). Workflow instance id === run row id — the workflow
// is the authoritative runtime, this row the durable record it reports into.
export const siteStudyRuns = pgTable(
  "site_study_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["pending", "running", "done", "error"] })
      .notNull()
      .default("pending"),
    // Plain id, no FK: which audit fed the derive is provenance and must
    // survive that audit run being deleted later.
    auditRunId: text("audit_run_id"),
    // Null while the run is in flight — written alongside the flip to done.
    pagesDerived: integer("pages_derived"),
    error: text("error"),
    startedAt: text("started_at").notNull().default(isoNow),
    finishedAt: text("finished_at"),
  },
  (table) => [
    // At most one active study per project — a second INSERT while a run is
    // pending/running fails this partial unique, and that failed INSERT is
    // the already-running signal (the gsc_sync_runs idiom above).
    uniqueIndex("site_study_runs_one_active_per_project_idx")
      .on(table.projectId)
      .where(sql`${table.status} IN ('pending', 'running')`),
  ],
);

// Per-project writer settings: how much the loop writes, and in whose voice.
// One row per project, created on first save — a project without a row runs
// on the defaults below, which is why every column is notNull with one.
export const writerSettings = pgTable("writer_settings", {
  id: text("id").primaryKey(),
  // Unique, not the PK: the id keeps the app's one-uuid-per-row idiom while
  // the constraint is what makes "the settings for this project" a single row.
  projectId: text("project_id")
    .notNull()
    .unique()
    .references(() => projects.id, { onDelete: "cascade" }),
  postsPerDay: integer("posts_per_day").notNull().default(2),
  // A missed day is owed, not skipped — this caps how much of that debt one
  // catch-up may pay, so a fortnight offline can't dump 28 posts in a morning.
  catchupCap: integer("catchup_cap").notNull().default(6),
  // Null means the quota is off and selection is manual-only. A default date
  // here would start a clock nobody asked to start.
  quotaStartDate: text("quota_start_date"),
  // The writer's voice, in the user's own words. Null is a real answer: the
  // brief says so plainly rather than inventing a persona.
  voiceCardMd: text("voice_card_md"),
  trustDial: text("trust_dial", { enum: ["titles", "drafts", "autopilot"] })
    .notNull()
    .default("titles"),
  // Per-project model override. Null means the deployment's OPENROUTER_MODEL,
  // which is the honest default: the key is the operator's, so the model that
  // key is provisioned for should be too. A column default would pin a slug
  // that outlives the model it names.
  model: text("model"),
  createdAt: text("created_at").notNull().default(isoNow),
  updatedAt: text("updated_at").notNull().default(isoNow),
});
