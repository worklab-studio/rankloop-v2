import { sql } from "drizzle-orm";
import { integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { projects } from "./app.schema";
import { competitors } from "./rankloop-competitors.schema";
import { contentPages } from "./rankloop-data.schema";

// See src/db/pg/app.schema.ts for why timestamps are ISO-8601 UTC text.
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// ============================================================================
// rankloop Outreach — the link gap (domains linking to two or more tracked
// competitors but not to you) and the human work queue it becomes.
//
// rankloop researches, drafts and organizes; it never sends. There is
// deliberately NO email column anywhere below: contactUrl holds their
// contact/about PAGE, so the only path to a human is a human opening it.
// ============================================================================

// Referring domains per tracked competitor — the raw material of the gap,
// filled by the study's referring-domains step (top 200 by rank, key-gated).
// Rows missing from a later refresh are kept and simply stop advancing
// lastSeenAt: a lost link is still evidence this domain links out in the
// niche, and the gap is about who is reachable, not who is linking today.
export const competitorLinkDomains = pgTable(
  "competitor_link_domains",
  {
    id: text("id").primaryKey(),
    competitorId: text("competitor_id")
      .notNull()
      .references(() => competitors.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    domainRank: integer("domain_rank"),
    backlinks: integer("backlinks"),
    firstSeenAt: text("first_seen_at").notNull().default(isoNow),
    lastSeenAt: text("last_seen_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("competitor_link_domains_competitor_domain_idx").on(
      table.competitorId,
      table.domain,
    ),
  ],
);

// One row per gap domain: it links to 2+ tracked competitors and not to you.
// Recomputed at the end of every competitor study and upserted on
// (project_id, domain) — a refresh rewrites the computed columns and never
// touches the human-owned ones (status, notes, an edited draftMessage), which
// is exactly why targets are a table and not a derived view.
export const outreachTargets = pgTable(
  "outreach_targets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    domainRank: integer("domain_rank"),
    // Denormalized from evidenceJson so the 100-row table can rank and filter
    // without parsing a JSON blob per row on every render.
    competitorCount: integer("competitor_count").notNull(),
    // Per competitor: which of their URLs this domain links to, plus the
    // anchor when the provider gave one. NOT NULL because the evidence is the
    // reason to write at all — every draft quotes it, and a target that can't
    // say what it links to is a guess, not a target.
    evidenceJson: text("evidence_json").notNull(),
    // set null, not cascade: a target a human already contacted must survive
    // its matched asset dropping out of the manifest. The next refresh
    // re-matches, or leaves the target listed with no asset.
    matchedAssetPageId: text("matched_asset_page_id").references(
      () => contentPages.id,
      { onDelete: "set null" },
    ),
    // Why it matched (shared topic tokens / data page / guide). Moves with
    // matchedAssetPageId — no match, no reason to record.
    matchTypeJson: text("match_type_json"),
    // 'broken_link' is reserved: S4b never emits it (it needs link-status
    // checking first), but the value ships in the enum so landing that step
    // is code, not a migration.
    templateKind: text("template_kind", {
      enum: ["resource_page", "data_citation", "broken_link"],
    }),
    // Stored at generation time so a human's edits persist; a refresh updates
    // the evidence around it and leaves an edited draft alone.
    draftMessage: text("draft_message"),
    // Human-owned. rankloop cannot observe any of these transitions — nothing
    // here contacts anyone — so the board is a memory aid the user moves by
    // hand, not a tracker with a source of truth behind it.
    status: text("status", {
      enum: ["to_contact", "sent", "replied", "linked", "declined"],
    })
      .notNull()
      .default("to_contact"),
    // Their contact/about PAGE URL, discovered from the crawl. Never an email
    // address: rankloop does not extract them and has no transport to use one.
    contactUrl: text("contact_url"),
    notes: text("notes"),
    // Stamped when a human-owned target (status moved off to_contact, or a
    // note written) is absent from a fresh gap recompute. Those rows are
    // never deleted — the human's work is the record — but their computed
    // columns above stop being true, so the table dims them behind a "no
    // longer in the gap" chip instead of presenting a frozen
    // competitorCount as current. Cleared the moment the domain comes back;
    // always null for rows still in the gap, and for rows nobody touched
    // (those are deleted outright).
    staleAsOf: text("stale_as_of"),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("outreach_targets_project_domain_idx").on(
      table.projectId,
      table.domain,
    ),
  ],
);
