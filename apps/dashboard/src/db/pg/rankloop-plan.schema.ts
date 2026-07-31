import { sql } from "drizzle-orm";
import { integer, pgTable, real, text, uniqueIndex } from "drizzle-orm/pg-core";
import { projects } from "./app.schema";

// See src/db/pg/app.schema.ts for why timestamps are ISO-8601 UTC text.
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// ============================================================================
// rankloop Page plan — the runs that cluster the keyword universe into page
// types. What a run PRODUCES lives in page_types (rankloop-write.schema.ts);
// this file is only the run ledger behind it, kept in its own pair because
// rankloop-write.schema.ts is already the largest schema module.
// ============================================================================

// One row per page-plan execution (detect → evidence → SERP sample → derive
// contracts → write page_types). Workflow instance id === run row id — the
// workflow is the authoritative runtime, this row the durable record it
// reports into.
export const pagePlanRuns = pgTable(
  "page_plan_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["pending", "running", "done", "error"] })
      .notNull()
      .default("pending"),
    // Null while the run is in flight — written alongside the flip to done.
    // Counts what was PROPOSED, not what survived: planner-declined types are
    // still stored (the "not worth building" panel reads them).
    typesProposed: integer("types_proposed"),
    // How many backlog rows this run actually clustered. A live COUNT of the
    // plannable backlog can't stand in for it: approving a type flips its
    // keywords to 'planned', so the pool shrinks by exactly the rows the plan
    // is built on and the stamp would contradict itself one approval later.
    keywordsClustered: integer("keywords_clustered"),
    // How many of the run's 40-call SERP budget it actually spent. 0 is a
    // real answer, not a missing one — a keyless project still detects and
    // proposes, with every verdict honestly marked 'unsampled'.
    serpSampled: integer("serp_sampled"),
    // Metered SERP spend for this run. Stored per run so the recompute
    // button's cost sentence can be measured against history rather than
    // guessed, and so a self-host operator can see what a plan really costs.
    costUsd: real("cost_usd"),
    error: text("error"),
    startedAt: text("started_at").notNull().default(isoNow),
    finishedAt: text("finished_at"),
  },
  (table) => [
    // At most one active plan per project — a second INSERT while a run is
    // pending/running fails this partial unique, and that failed INSERT is
    // the already-running signal (the site_study_runs idiom). Recompute is
    // allowed, but only one at a time: two concurrent runs would both rewrite
    // the same planner-declined page_types rows.
    uniqueIndex("page_plan_runs_one_active_per_project_idx")
      .on(table.projectId)
      .where(sql`${table.status} IN ('pending', 'running')`),
  ],
);
