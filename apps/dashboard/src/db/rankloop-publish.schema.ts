import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { projects } from "./app.schema";

// ============================================================================
// rankloop Write side — publish connections (how approved changes reach the
// site)
// ============================================================================

// Per-project credentials for the least-dangerous write path (WordPress
// application passwords first). configJson is symmetricEncrypt-ed with the
// BETTER_AUTH_SECRET-keyed cipher before insert — the same contract as the
// self-hosted GSC OAuth grant (see gsc/selfHostedOAuth.ts) — so a DB read
// never yields a usable password and the operator requirement stays one
// secret, not two.
export const publishConnections = sqliteTable(
  "publish_connections",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    adapter: text("adapter", {
      enum: ["wordpress", "webhook", "github"],
    }).notNull(),
    // Encrypted JSON, shaped per adapter (see publish/adapters/config.ts) —
    // for wordpress: { baseUrl, username, applicationPassword }. Every shape
    // also carries defaultPostStatus and linkInjection. Reads back to clients
    // masked ({ baseUrl, username, hasPassword }).
    configJson: text("config_json").notNull(),
    // What the last "Test connection" observed. 'unconfigured' means saved
    // but never tested — distinct from 'failed', which is a real verdict.
    status: text("status", { enum: ["unconfigured", "ok", "failed"] })
      .notNull()
      .default("unconfigured"),
    lastCheckedAt: text("last_checked_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    // One connection per project; changing adapters replaces the row (the
    // gsc_connections idiom).
    uniqueIndex("publish_connections_project_idx").on(table.projectId),
  ],
);
