import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { executeInBatches } from "@/db/runBatch";
import {
  competitorLinkDomains,
  competitors,
  contentPages,
  outreachTargets,
} from "@/db/schema";
import type { OutreachStatus } from "@/types/schemas/rankloopOutreach";

/** One computed target, ready to be written. The human-owned columns
 *  (status, notes, contactUrl) are deliberately absent — a recompute has no
 *  business supplying them. */
export type OutreachTargetUpsert = {
  projectId: string;
  domain: string;
  domainRank: number | null;
  competitorCount: number;
  evidenceJson: string;
  matchedAssetPageId: string | null;
  matchTypeJson: string | null;
  templateKind: "resource_page" | "data_citation" | "broken_link" | null;
  /** Only written into a row that has none; see upsertTargets. */
  draftMessage: string | null;
};

// ---------------------------------------------------------------------------
// Gap inputs
// ---------------------------------------------------------------------------

/**
 * Every referring domain stored for the project's tracked competitors, with
 * the competitor it belongs to. One join instead of a query per competitor:
 * the gap is a whole-project computation and a five-competitor project caps
 * at 1000 rows (200 per competitor).
 *
 * Skipped and merely-suggested competitors are excluded — the gap is "who
 * links to the rivals you chose to track", and a suggestion the user never
 * accepted must not put work on their board.
 */
async function listGapSourceRows(projectId: string) {
  return db
    .select({
      competitorId: competitorLinkDomains.competitorId,
      competitorDomain: competitors.domain,
      domain: competitorLinkDomains.domain,
      domainRank: competitorLinkDomains.domainRank,
      backlinks: competitorLinkDomains.backlinks,
    })
    .from(competitorLinkDomains)
    .innerJoin(
      competitors,
      eq(competitorLinkDomains.competitorId, competitors.id),
    )
    .where(
      and(
        eq(competitors.projectId, projectId),
        eq(competitors.status, "tracked"),
      ),
    );
}

/** How many referring-domain rows exist across tracked competitors. Zero
 *  while competitors are tracked is the tab's keyless signal. */
async function countGapSourceRows(projectId: string): Promise<number> {
  const rows = await db
    .select({ rowCount: count() })
    .from(competitorLinkDomains)
    .innerJoin(
      competitors,
      eq(competitorLinkDomains.competitorId, competitors.id),
    )
    .where(
      and(
        eq(competitors.projectId, projectId),
        eq(competitors.status, "tracked"),
      ),
    );
  return rows[0]?.rowCount ?? 0;
}

/** Tracked competitors, counted for the stamp and the first empty state. */
async function countTrackedCompetitors(projectId: string): Promise<number> {
  const rows = await db
    .select({ rowCount: count() })
    .from(competitors)
    .where(
      and(
        eq(competitors.projectId, projectId),
        eq(competitors.status, "tracked"),
      ),
    );
  return rows[0]?.rowCount ?? 0;
}

/** The pages a target could be pitched. Utility pages and hubs are out:
 *  nobody links to a tag archive, and a blog index is not an asset. */
async function listAssetPages(projectId: string) {
  return db
    .select({
      id: contentPages.id,
      url: contentPages.url,
      path: contentPages.path,
      title: contentPages.title,
    })
    .from(contentPages)
    .where(
      and(
        eq(contentPages.projectId, projectId),
        inArray(contentPages.kind, ["post", "page"]),
      ),
    );
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/** The board, ranked the way the gap ranked it, with the matched asset
 *  resolved. Left join: matchedAssetPageId is ON DELETE SET NULL, and a
 *  target with no asset is a first-class row. */
async function listTargets(projectId: string) {
  return db
    .select({
      target: outreachTargets,
      assetPath: contentPages.path,
      assetUrl: contentPages.url,
      assetTitle: contentPages.title,
    })
    .from(outreachTargets)
    .leftJoin(
      contentPages,
      eq(outreachTargets.matchedAssetPageId, contentPages.id),
    )
    .where(eq(outreachTargets.projectId, projectId))
    .orderBy(
      desc(outreachTargets.competitorCount),
      desc(outreachTargets.domainRank),
      asc(outreachTargets.domain),
    );
}

/** The columns a recompute has to reason about before it overwrites
 *  anything: what exists, what a human has already done to it, and whether it
 *  is already carrying a stale stamp. */
async function listTargetStates(projectId: string) {
  return db
    .select({
      id: outreachTargets.id,
      domain: outreachTargets.domain,
      status: outreachTargets.status,
      notes: outreachTargets.notes,
      draftMessage: outreachTargets.draftMessage,
      staleAsOf: outreachTargets.staleAsOf,
    })
    .from(outreachTargets)
    .where(eq(outreachTargets.projectId, projectId));
}

/**
 * Write the computed gap.
 *
 * The conflict set names every computed column and no human-owned one:
 * status, notes and contactUrl are never in it, so a monthly refresh cannot
 * move a target the user marked 'replied' back to 'to_contact'.
 *
 * `draftMessage` is the subtle one. It is written on the row's first
 * generation and then belongs to whoever edited it, and there is no
 * edited-at column to tell an edited draft from a generated one — so the
 * only safe rule is that a stored draft is never overwritten. The caller
 * passes null for rows that already have one.
 */
async function upsertTargets(
  rows: OutreachTargetUpsert[],
  now: string,
): Promise<void> {
  await executeInBatches(rows, (tx, row) =>
    tx
      .insert(outreachTargets)
      .values({
        id: crypto.randomUUID(),
        ...row,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [outreachTargets.projectId, outreachTargets.domain],
        set: {
          domainRank: row.domainRank,
          competitorCount: row.competitorCount,
          evidenceJson: row.evidenceJson,
          matchedAssetPageId: row.matchedAssetPageId,
          matchTypeJson: row.matchTypeJson,
          templateKind: row.templateKind,
          // Null for a row that already has a draft — the caller decided.
          ...(row.draftMessage === null
            ? {}
            : { draftMessage: row.draftMessage }),
          updatedAt: now,
        },
      }),
  );
}

/**
 * Stamp (or clear) the "left the gap" marker on the rows named.
 *
 * Deliberately not folded into upsertTargets' conflict set: the rows being
 * stamped are precisely the ones the upsert does NOT write, and the rows being
 * cleared are only the handful that carried a stamp — so the whole rule reads
 * in one place in the service instead of half here and half in a SET clause.
 * `updatedAt` is left alone: a domain leaving the gap is not a change to the
 * target, and the column is what the human's own edits move.
 */
async function setTargetsStale(
  projectId: string,
  targetIds: string[],
  staleAsOf: string | null,
): Promise<void> {
  await executeInBatches(targetIds, (tx, targetId) =>
    tx
      .update(outreachTargets)
      .set({ staleAsOf })
      .where(
        and(
          eq(outreachTargets.id, targetId),
          eq(outreachTargets.projectId, projectId),
        ),
      ),
  );
}

/** Drop targets by id. Batched rather than one IN (...) so a 100-id sweep
 *  stays under D1's ~100 bound-parameter ceiling. */
async function deleteTargets(
  projectId: string,
  targetIds: string[],
): Promise<void> {
  await executeInBatches(targetIds, (tx, targetId) =>
    tx
      .delete(outreachTargets)
      .where(
        and(
          eq(outreachTargets.id, targetId),
          eq(outreachTargets.projectId, projectId),
        ),
      ),
  );
}

/** Returns the ids it actually touched, so the service can tell a real
 *  update from a target belonging to another project. */
async function updateTargetStatus(input: {
  projectId: string;
  targetId: string;
  status: OutreachStatus;
  updatedAt: string;
}): Promise<string[]> {
  const updated = await db
    .update(outreachTargets)
    .set({ status: input.status, updatedAt: input.updatedAt })
    .where(
      and(
        eq(outreachTargets.id, input.targetId),
        eq(outreachTargets.projectId, input.projectId),
      ),
    )
    .returning({ id: outreachTargets.id });
  return updated.map((row) => row.id);
}

async function updateTargetDraft(input: {
  projectId: string;
  targetId: string;
  draftMessage: string;
  updatedAt: string;
}): Promise<string[]> {
  const updated = await db
    .update(outreachTargets)
    .set({ draftMessage: input.draftMessage, updatedAt: input.updatedAt })
    .where(
      and(
        eq(outreachTargets.id, input.targetId),
        eq(outreachTargets.projectId, input.projectId),
      ),
    )
    .returning({ id: outreachTargets.id });
  return updated.map((row) => row.id);
}

export const OutreachRepository = {
  listGapSourceRows,
  countGapSourceRows,
  countTrackedCompetitors,
  listAssetPages,
  listTargets,
  listTargetStates,
  upsertTargets,
  setTargetsStale,
  deleteTargets,
  updateTargetStatus,
  updateTargetDraft,
};
