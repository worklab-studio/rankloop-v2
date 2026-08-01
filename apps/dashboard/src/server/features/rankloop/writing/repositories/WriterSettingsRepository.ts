import { eq } from "drizzle-orm";
import { db } from "@/db";
import { writerSettings } from "@/db/schema";

/**
 * The writer dials, or null when the project has never saved any.
 *
 * Null is not "no settings" — it is "the defaults", which the column defaults
 * already encode. Callers apply them (see WRITER_SETTINGS_DEFAULTS) rather
 * than this function inserting a row on read: a project that has never opened
 * the settings surface should not acquire one because something looked.
 */
async function getSettings(projectId: string) {
  const rows = await db
    .select()
    .from(writerSettings)
    .where(eq(writerSettings.projectId, projectId))
    .limit(1);
  return rows[0] ?? null;
}

/** Every project with the quota switched on. Small by construction — one row
 *  per project that has saved settings — so the daily block reads it whole
 *  and does its due-set arithmetic in memory. */
async function getAllSettings(projectId?: string) {
  const rows = db
    .select({
      projectId: writerSettings.projectId,
      postsPerDay: writerSettings.postsPerDay,
      catchupCap: writerSettings.catchupCap,
      quotaStartDate: writerSettings.quotaStartDate,
    })
    .from(writerSettings);
  // `projectId` narrows the same read to one project — the per-project
  // dispatcher does the identical arithmetic the sweep does, over one row.
  return projectId ? rows.where(eq(writerSettings.projectId, projectId)) : rows;
}

/**
 * Save the dials, creating the row on first save.
 *
 * Upsert on the project unique rather than read-then-branch: two tabs saving
 * at once would otherwise both see "no row" and race two INSERTs, and only
 * one of them would survive the constraint with an error the user did nothing
 * to deserve.
 */
async function upsertSettings(input: {
  projectId: string;
  postsPerDay: number;
  catchupCap: number;
  quotaStartDate: string | null;
  voiceCardMd: string | null;
  trustDial: "titles" | "drafts" | "autopilot";
  writerMode: "api" | "agent";
}): Promise<void> {
  const { projectId, ...dials } = input;
  const now = new Date().toISOString();
  await db
    .insert(writerSettings)
    .values({ id: crypto.randomUUID(), projectId, ...dials, updatedAt: now })
    .onConflictDoUpdate({
      target: writerSettings.projectId,
      set: { ...dials, updatedAt: now },
    });
}

/**
 * Save where the daily digest goes, and nothing else.
 *
 * Narrow on purpose. The digest channels are set on the Automation surface
 * while the dials are set on Articles, so a save that carried the whole row
 * would let whichever screen was open longer write back the settings it
 * loaded — a trust dial silently reverted by somebody switching on email is
 * exactly the kind of edit nobody would ever go looking for.
 *
 * The insert leaves every other column to its default, which is what
 * WRITER_SETTINGS_DEFAULTS already promises a project with no row is running.
 */
async function upsertDigestDelivery(input: {
  projectId: string;
  digestEmail: boolean;
  digestWebhookUrl: string | null;
}): Promise<void> {
  const { projectId, ...channels } = input;
  const now = new Date().toISOString();
  await db
    .insert(writerSettings)
    .values({ id: crypto.randomUUID(), projectId, ...channels, updatedAt: now })
    .onConflictDoUpdate({
      target: writerSettings.projectId,
      set: { ...channels, updatedAt: now },
    });
}

export const WriterSettingsRepository = {
  getSettings,
  getAllSettings,
  upsertSettings,
  upsertDigestDelivery,
};
