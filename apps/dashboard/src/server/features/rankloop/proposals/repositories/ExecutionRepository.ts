import { and, eq, sql } from "drizzle-orm";
import type { InferInsertModel } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import { contentPages, proposals, receipts } from "@/db/schema";

// Reads and writes specific to executing an approved proposal (spec 0013).
// Split from ProposalsRepository the way audit splits its result writes:
// signal computation and execution share the proposals table but nothing
// else, and neither file needs to scroll past the other's queries.

export type ReceiptInsert = InferInsertModel<typeof receipts>;

async function getContentPageById(projectId: string, contentPageId: string) {
  const rows = await db
    .select({
      id: contentPages.id,
      url: contentPages.url,
      path: contentPages.path,
      title: contentPages.title,
      description: contentPages.description,
      category: contentPages.category,
    })
    .from(contentPages)
    .where(
      and(
        eq(contentPages.id, contentPageId),
        eq(contentPages.projectId, projectId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Posts only — hubs and utility pages are link chrome already, and a "link
 *  from your privacy policy" suggestion would be noise. */
async function getInlinkSourcePages(projectId: string) {
  return db
    .select({
      path: contentPages.path,
      title: contentPages.title,
      category: contentPages.category,
    })
    .from(contentPages)
    .where(
      and(eq(contentPages.projectId, projectId), eq(contentPages.kind, "post")),
    );
}

/**
 * The execution commit: proposal → done, the manifest title (retitle only),
 * and the opened receipt, as ONE atomic write set (runBatch). The proposal
 * update is a CAS on status='approved', so a photo-finish double execute
 * can't double-flip the row — and the receipt insert below is gated on that
 * same CAS, because contamination detection cannot clean up after a loser:
 * `isContaminated` reads *proposals*, and the loser stamped no executedAt, so
 * its orphan receipt would sit open with no execution behind it forever.
 * The receipt rides in the same batch because an executed proposal without
 * its receipt (or the reverse) would lie about what happened.
 */
async function markDoneWithReceipt(input: {
  projectId: string;
  proposalId: string;
  executedAt: string;
  receipt: ReceiptInsert;
  retitle?: { contentPageId: string; title: string };
}): Promise<void> {
  const receipt = input.receipt;
  await runBatch((tx) => [
    tx
      .update(proposals)
      .set({ status: "done", executedAt: input.executedAt })
      .where(
        and(
          eq(proposals.id, input.proposalId),
          eq(proposals.projectId, input.projectId),
          eq(proposals.status, "approved"),
        ),
      ),
    ...(input.retitle
      ? [
          tx
            .update(contentPages)
            .set({ title: input.retitle.title })
            .where(
              and(
                eq(contentPages.id, input.retitle.contentPageId),
                eq(contentPages.projectId, input.projectId),
              ),
            ),
        ]
      : []),
    // Gated on the CAS, inside the same batch: the SELECT reads the proposal
    // the UPDATE just touched, so it yields one row for the winner and zero
    // for a loser whose stamp never landed. Statements run in array order on
    // both backends (D1 batch, pg transaction), which is what makes the read
    // see the write. The projection is positional — drizzle emits the full
    // receipts column list for an insert-select — so these fields must stay in
    // the table's own column order, and none may be undefined: an
    // insert-select never applies a column default. Drizzle validates that
    // pairing on every call, so a new receipts column surfaces here as a loud
    // "Insert select error", not as silently shifted data.
    tx.insert(receipts).select(
      tx
        .select({
          id: sql<string>`${receipt.id}`.as("id"),
          projectId: sql<string>`${receipt.projectId}`.as("projectId"),
          actionType: sql<string>`${receipt.actionType}`.as("actionType"),
          articleId: sql<string | null>`${receipt.articleId ?? null}`.as(
            "articleId",
          ),
          contentPageId: sql<
            string | null
          >`${receipt.contentPageId ?? null}`.as("contentPageId"),
          targetQuery: sql<string | null>`${receipt.targetQuery ?? null}`.as(
            "targetQuery",
          ),
          status: sql<string>`${receipt.status ?? "baseline"}`.as("status"),
          baselineJson: sql<string | null>`${receipt.baselineJson ?? null}`.as(
            "baselineJson",
          ),
          resultJson: sql<string | null>`${receipt.resultJson ?? null}`.as(
            "resultJson",
          ),
          windowStart: sql<string | null>`${receipt.windowStart ?? null}`.as(
            "windowStart",
          ),
          windowEnd: sql<string | null>`${receipt.windowEnd ?? null}`.as(
            "windowEnd",
          ),
          measuredAt: sql<string | null>`${receipt.measuredAt ?? null}`.as(
            "measuredAt",
          ),
          nextCheckAt: sql<string | null>`${receipt.nextCheckAt ?? null}`.as(
            "nextCheckAt",
          ),
          createdAt: sql<string>`${receipt.createdAt ?? input.executedAt}`.as(
            "createdAt",
          ),
        })
        .from(proposals)
        .where(
          and(
            eq(proposals.id, input.proposalId),
            eq(proposals.projectId, input.projectId),
            eq(proposals.executedAt, input.executedAt),
          ),
        ),
    ),
  ]);
}

export const ExecutionRepository = {
  getContentPageById,
  getInlinkSourcePages,
  markDoneWithReceipt,
};
