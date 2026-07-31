import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { projects } from "./app.schema";

// ============================================================================
// rankloop Competitor intelligence — the studied competitor set (tracked
// domains, their page-level snapshots, and the study runs that fill both).
// Split out of rankloop-write.schema.ts: same Write side, own file.
// ============================================================================

// Competitor domains: discovery suggests, the user tracks or skips. The
// metric columns stay null until the first paid data call fills them in —
// a suggested row costs nothing until someone decides it matters.
export const competitors = sqliteTable(
  "competitors",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    status: text("status", { enum: ["suggested", "tracked", "skipped"] })
      .notNull()
      .default("suggested"),
    discoveredVia: text("discovered_via"),
    domainRank: integer("domain_rank"),
    organicKeywords: integer("organic_keywords"),
    estTraffic: real("est_traffic"),
    backlinks: integer("backlinks"),
    referringDomains: integer("referring_domains"),
    // null until first studied; 'sitemap_only' marks a study that could read
    // the sitemap but not crawl (WAF/bot challenge), so page-level numbers
    // for that competitor are partial.
    coverage: text("coverage", { enum: ["full", "sitemap_only"] }),
    // The studied playbook, written by the study's summarize step: cadence
    // timeline, page-type mix, winners-vs-median feature deltas, medians.
    // An aggregate render source, not relational data — the page-level rows
    // it was computed from live in competitor_pages.
    studySummaryJson: text("study_summary_json"),
    lastStudiedAt: text("last_studied_at"),
  },
  (table) => [
    uniqueIndex("competitors_project_domain_idx").on(
      table.projectId,
      table.domain,
    ),
  ],
);

// Competitor pages, refreshed monthly and updated in place (the unique below
// is the upsert target). decayed/removed statuses are the what-not-to-build
// signal: pages a competitor let rot or deleted are negative evidence for
// the page plan, which is why they are kept instead of pruned.
export const competitorPages = sqliteTable(
  "competitor_pages",
  {
    id: text("id").primaryKey(),
    competitorId: text("competitor_id")
      .notNull()
      .references(() => competitors.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    title: text("title"),
    pageType: text("page_type"),
    etv: real("etv"),
    keywordCount: integer("keyword_count"),
    wordCount: integer("word_count"),
    structuralFeaturesJson: text("structural_features_json"),
    status: text("status", { enum: ["active", "decayed", "removed"] })
      .notNull()
      .default("active"),
    firstSeenAt: text("first_seen_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    lastSeenAt: text("last_seen_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("competitor_pages_competitor_url_idx").on(
      table.competitorId,
      table.url,
    ),
  ],
);

// One row per competitor-study execution (metrics + top-earning pages + the
// sitemap/crawl blog study). Workflow instance id === run row id — the
// workflow is the authoritative runtime, this row the durable record it
// reports into.
export const competitorStudyRuns = sqliteTable(
  "competitor_study_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    competitorId: text("competitor_id")
      .notNull()
      .references(() => competitors.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["pending", "running", "done", "error"] })
      .notNull()
      .default("pending"),
    // What THIS run achieved (competitors.coverage carries the latest):
    // null in flight, 'sitemap_only' when the crawl step got blocked and the
    // study fell back to sitemap-derived numbers only.
    coverage: text("coverage", { enum: ["full", "sitemap_only"] }),
    // Null while the run is in flight — written alongside the flip to done.
    pagesStudied: integer("pages_studied"),
    error: text("error"),
    startedAt: text("started_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    finishedAt: text("finished_at"),
  },
  (table) => [
    // At most one active study per competitor — a second INSERT while a run
    // is pending/running fails this partial unique, and that failed INSERT
    // is the already-running signal (the site_study_runs idiom above).
    uniqueIndex("competitor_study_runs_one_active_per_competitor_idx")
      .on(table.competitorId)
      .where(sql`${table.status} IN ('pending', 'running')`),
  ],
);
