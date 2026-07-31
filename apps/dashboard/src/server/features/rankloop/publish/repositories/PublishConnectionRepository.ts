import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { publishConnections } from "@/db/schema";

async function getForProject(projectId: string) {
  const rows = await db
    .select()
    .from(publishConnections)
    .where(eq(publishConnections.projectId, projectId))
    .limit(1);
  return rows[0] ?? null;
}

/** One connection per project — the (project_id) unique makes a re-save an
 *  in-place replace, the gsc_connections idiom. configJson arrives already
 *  encrypted; this layer never sees plaintext credentials. */
async function upsert(input: {
  projectId: string;
  adapter: (typeof publishConnections.adapter.enumValues)[number];
  configJson: string;
}) {
  const [row] = await db
    .insert(publishConnections)
    .values({ id: crypto.randomUUID(), ...input })
    .onConflictDoUpdate({
      target: publishConnections.projectId,
      set: {
        adapter: input.adapter,
        configJson: input.configJson,
        // Saved credentials are untested credentials — every re-save walks
        // the status back until "Test connection" earns 'ok' again.
        status: "unconfigured",
        lastCheckedAt: null,
        updatedAt: sql`(current_timestamp)`,
      },
    })
    .returning();
  if (!row) {
    throw new Error("Failed to upsert publish_connection");
  }
  return row;
}

async function setStatus(input: {
  projectId: string;
  status: "ok" | "failed";
  lastCheckedAt: string;
}): Promise<void> {
  await db
    .update(publishConnections)
    .set({
      status: input.status,
      lastCheckedAt: input.lastCheckedAt,
      updatedAt: sql`(current_timestamp)`,
    })
    .where(eq(publishConnections.projectId, input.projectId));
}

export const PublishConnectionRepository = {
  getForProject,
  upsert,
  setStatus,
};
