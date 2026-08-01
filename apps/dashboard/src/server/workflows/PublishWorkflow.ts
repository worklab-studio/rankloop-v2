import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { withPgClient } from "@/db";
import { PublishLinksService } from "@/server/features/rankloop/publish/services/PublishLinksService";
import { PublishService } from "@/server/features/rankloop/publish/services/PublishService";
import type { PublishContext } from "@/server/features/rankloop/publish/services/publishContext";
import { pgStep } from "@/server/workflows/pgStep";

// preflight -> hub -> publish -> manifest -> links -> wire -> indexnow ->
// receipt.
//
// The order is the argument. The hub exists before the instance does, because
// an instance nobody links to is an orphan. Exactly one step creates anything
// on the user's site and it is the one step with no retries. Everything after
// that step is either free or non-fatal, because the post is already live and
// failing the run would only make the database disagree with the site.

// Reading rows and rendering from them is free and idempotent, so it gets a
// small retry budget.
const FREE_STEP_CONFIG = {
  retries: { limit: 2, delay: "5 seconds" as const },
  timeout: "2 minutes" as const,
};

// Hub creation is safe to retry: `ensureHub` is a find-or-create, and finding
// the hub a timed-out attempt already made is the ordinary answer.
const HUB_STEP_CONFIG = {
  retries: { limit: 2, delay: "10 seconds" as const },
  timeout: "2 minutes" as const,
};

/**
 * The create, with no retries at all.
 *
 * A retried create is a duplicate post. An HTTP timeout does not tell us
 * whether WordPress saved the draft, and "probably not" is not a good enough
 * reason to risk two of somebody's articles going out under one title. A run
 * that dies here resumes against `articles.adapterRef`, which is written the
 * instant the post exists.
 */
const PUBLISH_STEP_CONFIG = {
  retries: { limit: 0, delay: "1 second" as const },
  timeout: "3 minutes" as const,
};

// Editing neighbours is read-merge-write per page and each page is independent,
// so a retry re-reads and re-merges; the merge is idempotent, so a page written
// by a lost attempt comes back unchanged the second time.
const LINKS_STEP_CONFIG = {
  retries: { limit: 1, delay: "10 seconds" as const },
  timeout: "3 minutes" as const,
};

interface PublishParams {
  articleId: string;
  projectId: string;
}

export class PublishWorkflow extends WorkflowEntrypoint<Env, PublishParams> {
  async run(event: WorkflowEvent<PublishParams>, step: WorkflowStep) {
    // Scope a per-request Postgres client for this invocation (no-op in D1
    // mode); step bodies open their own via pgStep.
    return withPgClient(() => this.runScoped(event, step));
  }

  private async runScoped(
    event: WorkflowEvent<PublishParams>,
    step: WorkflowStep,
  ) {
    const { articleId, projectId } = event.payload;

    const preflight = await pgStep(step, "preflight", FREE_STEP_CONFIG, () =>
      PublishService.preflight({ articleId, projectId }),
    );
    if (!preflight.ok) {
      await pgStep(step, "land-blocked", FREE_STEP_CONFIG, async () => {
        await PublishService.landBlocked({
          articleId,
          projectId,
          blocked: preflight.blocked,
        });
        return { landed: true };
      });
      console.info(
        `[rankloop-publish] ${articleId} refused: ${preflight.blocked.reason}`,
      );
      return;
    }

    try {
      await this.publish(preflight.context, step);
    } catch (error) {
      // Anything that threw past the steps' own retries: land the article
      // terminally before rethrowing. `preflight` claimed the row into
      // `publishing`, and a row left there holds the proposal's one in-flight
      // slot (articles_one_in_flight_per_proposal_idx), belongs to no queue
      // tab, and is refused by every path that could clear it — including a
      // second publish.
      console.error(`[rankloop-publish] ${articleId} crashed:`, error);
      await pgStep(step, "land-failed", FREE_STEP_CONFIG, () =>
        PublishService.landCrashed({
          articleId,
          projectId,
          detail: errorLine(error),
        }),
      );
      throw error;
    }
  }

  private async publish(
    context: PublishContext,
    step: WorkflowStep,
  ): Promise<void> {
    const hub = await pgStep(step, "hub", HUB_STEP_CONFIG, () =>
      PublishService.ensureHub(context),
    );
    if (hub.created) {
      console.info(
        `[rankloop-publish] created hub ${hub.path} for ${context.pageTypeName}`,
      );
    }

    // Chosen before the post is created, not after: a delegated target is
    // handed the whole list inside `createPost` and applies it itself, so the
    // decision has to exist by then. Selection is pure and deterministic, so
    // the editing targets act on exactly the same three pages a step later.
    const targets = await pgStep(step, "link-targets", FREE_STEP_CONFIG, () =>
      PublishLinksService.planLinks(context),
    );

    const published = await pgStep(step, "publish", PUBLISH_STEP_CONFIG, () =>
      PublishService.publishPost({
        context,
        hub,
        targets,
        anchor: context.title,
      }),
    );
    if (published.resumed) {
      console.info(
        `[rankloop-publish] ${context.articleId} already exists as ${published.adapterRef} — resuming`,
      );
    }

    const { contentPageId, publishedAt } = await pgStep(
      step,
      "manifest",
      FREE_STEP_CONFIG,
      () => PublishService.upsertManifestPage({ context, url: published.url }),
    );

    // Non-fatal from here down. The post is live; a neighbour that could not
    // be edited, a sitemap that could not be committed and an index ping that
    // did not land are all weaker outcomes, not failed ones, and turning any
    // of them into a thrown run would leave a published article marked
    // `publishing` forever.
    const { links } = await pgStep(step, "links", LINKS_STEP_CONFIG, () =>
      PublishLinksService.injectLinks({
        context,
        targets,
        anchor: context.title,
      }),
    ).catch((error: unknown) => {
      console.info(`[rankloop-publish] link injection failed:`, error);
      return { links: [] };
    });

    await pgStep(step, "wire", LINKS_STEP_CONFIG, () =>
      PublishLinksService.wireDerivedArtifacts({
        context,
        adapterRef: published.adapterRef,
      }),
    ).catch((error: unknown) => {
      console.info(`[rankloop-publish] derived artifacts failed:`, error);
      return { written: [] };
    });

    await pgStep(step, "indexnow", FREE_STEP_CONFIG, () =>
      PublishService.submitIndexNow(published.url),
    ).catch(() => ({ submitted: false }));

    // The one write that must not be partial: the article publishes, the
    // proposal is done, the keyword leaves the backlog and the receipt opens
    // with its baseline, all in one transaction.
    await pgStep(step, "receipt", FREE_STEP_CONFIG, async () => {
      await PublishService.commitPublished({
        context,
        contentPageId,
        adapter: published.adapter,
        adapterRef: published.adapterRef,
        publishedUrl: published.url,
        links,
        publishedAt,
      });
      return { committed: true };
    });

    const injected = links.filter((link) => link.outcome === "injected").length;
    console.info(
      `[rankloop-publish] ${context.articleId} -> ${published.url} (${injected} of ${targets.length} link${targets.length === 1 ? "" : "s"} injected)`,
    );
  }
}

/** One line of it, bounded: the detail rides in the article's law report and
 *  is read on the Failed tab, not in a log viewer. */
function errorLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 300);
}
