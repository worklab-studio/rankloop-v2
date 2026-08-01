import { ArticleRepository } from "@/server/features/rankloop/writing/repositories/ArticleRepository";
import { parseLawReport } from "@/types/schemas/rankloopWriter";

// Where an article lands when a run does not publish it — the refusal and the
// crash. Split from PublishService.ts, which is the eight steps themselves.
//
// Both write the same row, and between them they own the invariant the rest of
// publishing depends on: a run never ends with the article still in
// `publishing`, and never moves a row another run holds.

export type PublishBlocked = {
  reason:
    | "not_connected"
    | "trust_dial"
    | "laws_unmet"
    | "no_content"
    | "already_published"
    | "lost_claim";
  detail: string;
};

/**
 * Land a refusal: the article goes back to `review` and the reason is written
 * beside its law report.
 *
 * The report's own verdict is left exactly as the gate wrote it. An article
 * that was blocked by a missing connection still passed nineteen laws, and
 * overwriting that checklist with a red one would make the product lie about
 * its own work in the one place users check it.
 */
export async function landBlocked(input: {
  articleId: string;
  projectId: string;
  blocked: PublishBlocked;
}): Promise<void> {
  // Two refusals are about a row this run does not own. `already_published`
  // would un-say something the site has already said; `lost_claim` belongs to
  // the run that won, and writing `review` over its `publishing` would make
  // its commit CAS miss — a live post the database never records as published.
  if (
    input.blocked.reason === "already_published" ||
    input.blocked.reason === "lost_claim"
  ) {
    return;
  }
  const article = await ArticleRepository.getArticleById(
    input.projectId,
    input.articleId,
  );
  const report = parseLawReport(article?.lawReportJson ?? null);
  await ArticleRepository.updateArticle(input.articleId, {
    status: "review",
    ...(report
      ? {
          lawReportJson: JSON.stringify({
            ...report,
            failure: {
              reason: "publish_blocked" as const,
              detail: input.blocked.detail,
            },
          }),
        }
      : {}),
  });
}

/**
 * Land a run that threw somewhere past the claim.
 *
 * `failed`, not `review` and not `published`, and both halves of that are
 * deliberate. `review` would re-arm a one-click publish for an article whose
 * post may already exist — a create whose response was lost, or a WordPress
 * meta write that threw after the post was made, both leave a live page with
 * no `adapterRef` — and a duplicate post is the one outcome the create step's
 * zero retries exist to prevent. `published` would bypass `commitPublished`
 * entirely, leaving a published row with no receipt, a proposal still
 * `approved` and a null `publishedAt` the Published tab assumes cannot exist.
 *
 * `failed` is terminal, releases the proposal's one in-flight slot, renders on
 * the Failed tab with its reason, and is editable — a human can recheck it
 * back into the queue, and the stored `adapterRef` then resumes the run that
 * got this far instead of creating a second post.
 */
export async function landCrashed(input: {
  articleId: string;
  projectId: string;
  detail: string;
}): Promise<{ landed: boolean }> {
  const article = await ArticleRepository.getArticleById(
    input.projectId,
    input.articleId,
  );
  // Only a row this run still holds. A crash in the receipt step can arrive
  // after the commit already flipped the article, and the last write of a run
  // must never be the one that un-publishes a live post.
  if (!article || article.status !== "publishing") return { landed: false };

  const report = parseLawReport(article.lawReportJson);
  // The ref is the evidence, so the sentence changes with it: an article whose
  // post is already live needs a human to know that before they touch it.
  const detail = article.adapterRef
    ? `The post exists on your site, but this run stopped before recording it: ${input.detail}`
    : `The publish run stopped: ${input.detail}`;
  await ArticleRepository.updateArticle(input.articleId, {
    status: "failed",
    lawReportJson: JSON.stringify({
      ...(report ?? {
        passed: false,
        checkedAt: new Date().toISOString(),
        laws: [],
      }),
      failure: { reason: "internal_error" as const, detail },
    }),
  });
  return { landed: true };
}
