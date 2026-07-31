import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { projects } from "./app.schema";
import { pageTypes } from "./rankloop-write.schema";

// ============================================================================
// rankloop Write side — facts in (GSC sync, corpus manifest, SERP grounding,
// indexation)
// ============================================================================

// Interned page URLs for the GSC fact table. A gsc_performance row is ~40
// bytes of metrics while page URLs run ~80 chars; repeating the raw text per
// fact row (and again inside the 5-column unique index) would 5–10x
// row+index size, which matters when everything shares a single D1.
export const gscPages = sqliteTable(
  "gsc_pages",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
  },
  (table) => [
    uniqueIndex("gsc_pages_project_url_idx").on(table.projectId, table.url),
  ],
);

// Interned query strings — same size reality as gscPages.
export const gscQueries = sqliteTable(
  "gsc_queries",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    query: text("query").notNull(),
  },
  (table) => [
    uniqueIndex("gsc_queries_project_query_idx").on(
      table.projectId,
      table.query,
    ),
  ],
);

// One row per (page, query, date, grain) from the Search Console sync: daily
// rows cover a rolling 90d window with a top-N/day cap, monthly rollups keep
// the history beyond it. Everything below the daily cap is summed into one
// remainder row per day — pageId/queryId stay NOT NULL because the sync
// interns dedicated sentinel page/query rows for it (a NULL in the unique
// key never conflicts, so remainder rows would silently pile up).
export const gscPerformance = sqliteTable(
  "gsc_performance",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    pageId: text("page_id")
      .notNull()
      .references(() => gscPages.id, { onDelete: "cascade" }),
    queryId: text("query_id")
      .notNull()
      .references(() => gscQueries.id, { onDelete: "cascade" }),
    // YYYY-MM-DD; 'month' rows store the first of the month, so one date
    // column serves both grains and the dedupe key stays a single index.
    date: text("date").notNull(),
    grain: text("grain", { enum: ["day", "month"] })
      .notNull()
      .default("day"),
    clicks: integer("clicks").notNull(),
    impressions: integer("impressions").notNull(),
    ctr: real("ctr").notNull(),
    position: real("position").notNull(),
    // One mark per (sync run, date), stamped on every row that pull writes,
    // sentinel included. Re-pulling a date only inserts and updates, so a
    // (page, query) pair that has since dropped below the cap would keep its
    // row AND be counted again inside the sentinel remainder that now stands
    // for it; the sync deletes the day's rows whose mark differs. Null on
    // rows written before this column existed — the first re-pull retires
    // them.
    syncMark: text("sync_mark"),
  },
  (table) => [
    uniqueIndex("gsc_performance_project_page_query_date_grain_idx").on(
      table.projectId,
      table.pageId,
      table.queryId,
      table.date,
      table.grain,
    ),
  ],
);

// The maintained corpus manifest: what exists on the site right now. Site
// study derives it from crawl runs; every publish appends to it. Measured
// fields (wordCount, inlinkCount, contentHash, …) stay null until a crawl
// has actually seen the page — publish-appended rows arrive before the next
// crawl does.
export const contentPages = sqliteTable(
  "content_pages",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    path: text("path").notNull(),
    kind: text("kind", { enum: ["post", "page", "hub", "other"] }).notNull(),
    title: text("title"),
    description: text("description"),
    publishedAt: text("published_at"),
    modifiedAt: text("modified_at"),
    wordCount: integer("word_count"),
    category: text("category"),
    keyword: text("keyword"),
    // set null, not cascade: deleting a page type must not delete manifest
    // rows for pages that are still live on the site.
    pageTypeId: text("page_type_id").references(() => pageTypes.id, {
      onDelete: "set null",
    }),
    inlinkCount: integer("inlink_count"),
    outlinkPathsJson: text("outlink_paths_json"),
    contentHash: text("content_hash"),
    source: text("source", { enum: ["crawl", "publish"] }).notNull(),
    lastCrawledAt: text("last_crawled_at"),
  },
  (table) => [
    uniqueIndex("content_pages_project_url_idx").on(table.projectId, table.url),
  ],
);

// SERP snapshots for planning (page-type evidence) and grounding (brief
// citations). History table, deliberately no unique — refreshes append
// rather than update, so a brief can point at the exact snapshot it was
// grounded in.
export const serpSnapshots = sqliteTable(
  "serp_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    keyword: text("keyword").notNull(),
    purpose: text("purpose", { enum: ["plan", "grounding"] }).notNull(),
    organicJson: text("organic_json").notNull(),
    paaJson: text("paa_json"),
    // AIO / featured-snippet / heavy-ads flags.
    featuresJson: text("features_json"),
    fetchedAt: text("fetched_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    index("serp_snapshots_project_keyword_fetched_idx").on(
      table.projectId,
      table.keyword,
      table.fetchedAt,
    ),
  ],
);

// URL Inspection results. The upstream GSC client fetches these but never
// stores them; persisted here so indexation history survives across runs
// and the receipts flow can tell "not indexed yet" from "dropped out".
export const indexationChecks = sqliteTable(
  "indexation_checks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    verdict: text("verdict").notNull(),
    coverageState: text("coverage_state"),
    checkedAt: text("checked_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    index("indexation_checks_project_url_checked_idx").on(
      table.projectId,
      table.url,
      table.checkedAt,
    ),
  ],
);
