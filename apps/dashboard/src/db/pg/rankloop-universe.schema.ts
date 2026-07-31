import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projects } from "./app.schema";

// See src/db/pg/app.schema.ts for why timestamps are ISO-8601 UTC text.
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// ============================================================================
// rankloop Keyword universe — the project's own relevance gate (what counts as
// on-topic here, and how hard a keyword may be) plus the ledger for the runs
// that fill the backlog through it. What a run PRODUCES lives in
// keyword_backlog (rankloop-write.schema.ts); this pair is only the gate and
// the ledger, kept in its own file because rankloop-write.schema.ts is
// already the largest schema module.
// ============================================================================

// One gate per project. This is the niche knowledge v1 read out of a
// hand-authored rankloop.toml — derived here from the project's own evidence
// (content_pages titles and paths, plus the GSC queries the site already
// earns impressions for), then edited by hand, never guessed by a model.
// Every source writes through it, so this row is the only place "on-topic for
// this site" is defined.
export const projectGate = pgTable(
  "project_gate",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Tokens appearing in at least 3 of the project's own documents, capped
    // at 40, stored as a literal alternation — never a user-facing regex, so
    // an edited gate cannot become a syntax error or a catastrophic pattern.
    positivesJson: text("positives_json").notNull(),
    // The shipped junk orbit every niche shares (jobs, salary, torrent,
    // casino, crypto, login, coupon code, free download) plus whatever the
    // user adds. Stored per project rather than read from a constant so a
    // user's removal of a default survives a rankloop upgrade.
    negativesJson: text("negatives_json").notNull(),
    // Dropped from the positives before the document-frequency count: brand
    // tokens are in every title, so leaving them in would admit the whole
    // internet that mentions the brand and starve the topic tokens of slots.
    brandTokensJson: text("brand_tokens_json").notNull(),
    // The adaptive difficulty ceiling, in KD points. 20 is the no-samples
    // branch of computeKdCeiling — a project with fewer than 10 ranked
    // non-brand samples keeps it. This column is the live value page-plan's
    // caution rule reads (UniverseRepository.getKdCeiling, which answers the
    // same 20 when no row exists yet), never a constant copied into that
    // feature. Also the previous value the +5-per-computation clamp reads
    // back, so a single sync can never reprice the whole backlog.
    kdCeiling: integer("kd_ceiling").notNull().default(20),
    // Null until a computation actually had samples to work from. The card
    // reads this to decide between "earned from 14 keywords you already rank
    // top-10 for" and admitting the number is the fixed starting floor.
    kdCeilingUpdatedAt: text("kd_ceiling_updated_at"),
    // The never-overwrite rule, enforced in the schema rather than by hoping
    // the UI hides the button: once a human has edited the tokens,
    // re-derivation must leave them alone.
    userEdited: boolean("user_edited").notNull().default(false),
    derivedAt: text("derived_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (table) => [
    // One gate per project — re-derivation updates this row in place instead
    // of appending a version, so the project is the upsert target.
    uniqueIndex("project_gate_project_idx").on(table.projectId),
  ],
);

// One row per keyword-universe execution: a single workflow whose per-source
// steps (gsc, gap, expansion, autocomplete, harvest) all upsert through the
// gate. Workflow instance id === run row id — the workflow is the
// authoritative runtime, this row the durable record it reports into, which
// is what lets getStaleRunReason judge a wedged slot.
export const keywordUniverseRuns = pgTable(
  "keyword_universe_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Which sources this dispatch asked for. Stored per run because the free
    // weekly block and a manual "Find gaps" are the same workflow with
    // different steps enabled — without it the ledger cannot say whether a
    // run cost money.
    sourcesJson: text("sources_json").notNull(),
    status: text("status", { enum: ["pending", "running", "done", "error"] })
      .notNull()
      .default("pending"),
    // Candidates the sources returned before the gate. Null while the run is
    // in flight — written alongside the flip to done.
    seenCount: integer("seen_count"),
    // How many of those survived the gate and were stored. The pair is the
    // run's whole honesty ("1,284 candidates seen · 312 passed your gate"):
    // rejected rows are counted here and written nowhere, which is why the
    // count has to be a column and not a query over keyword_backlog.
    keptCount: integer("kept_count"),
    error: text("error"),
    startedAt: text("started_at").notNull().default(isoNow),
    finishedAt: text("finished_at"),
  },
  (table) => [
    // At most one active universe run per project — a second INSERT while a
    // run is pending/running fails this partial unique, and that failed
    // INSERT is the already-running signal (the site_study_runs idiom). Two
    // concurrent runs would race the same (project_id, keyword) upsert target
    // and double-count seen/kept.
    uniqueIndex("keyword_universe_runs_one_active_per_project_idx")
      .on(table.projectId)
      .where(sql`${table.status} IN ('pending', 'running')`),
  ],
);
