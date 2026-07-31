import { env } from "cloudflare:workers";
import { SiteStudyRepository } from "@/server/features/rankloop/site-study/repositories/SiteStudyRepository";
import type { ContentPageUpsert } from "@/server/features/rankloop/site-study/repositories/SiteStudyRepository";
import {
  derivePageKinds,
  invertInlinkCounts,
  urlToPath,
  type DeriveKindInput,
} from "@/server/features/rankloop/site-study/services/derive.logic";
import { getStaleRunReason } from "@/server/features/rankloop/staleRunProbe";
import { AppError } from "@/server/lib/errors";
import type {
  ContentInventorySummary,
  RankloopSiteStudy,
} from "@/types/schemas/rankloopSiteStudy";

type SiteStudyStartResult = {
  runId: string;
  alreadyRunning: boolean;
};

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

/**
 * Start a study run for a project, or return the run that's already active.
 * Coordination mirrors gsc-sync: workflow instance id === run row id, and the
 * partial unique on site_study_runs(project_id) WHERE status IN ('pending',
 * 'running') is the only lock — a blocked INSERT means a study is underway,
 * which callers treat as success, not an error. A blocker whose workflow
 * instance is dead (deploy reset, create-then-crash) is flipped to error and
 * the start retried, so one corpse can't wedge a project forever.
 */
async function startStudy(projectId: string): Promise<SiteStudyStartResult> {
  // At most two attempts: the retry only fires after clearing a stale
  // blocker, or when the blocking run finished between INSERT and SELECT.
  for (let attempt = 0; attempt < 2; attempt++) {
    const runId = crypto.randomUUID();
    const inserted = await SiteStudyRepository.tryCreateRun({
      id: runId,
      projectId,
    });

    if (!inserted) {
      const active =
        await SiteStudyRepository.getActiveRunForProject(projectId);
      if (!active) continue;
      if (attempt === 0) {
        // A workflow that died before its mark-error step (deploy reset,
        // crashed mid-run) leaves this row active forever and the
        // partial-index slot wedged. Probe the instance; a zombie flips to
        // error and the retry inserts into the freed slot.
        const staleReason = await getStaleRunReason({
          workflow: env.SITE_STUDY_WORKFLOW,
          runId: active.id,
          ageMs: Date.now() - new Date(active.startedAt).getTime(),
        });
        if (staleReason) {
          await SiteStudyRepository.updateRun(active.id, {
            status: "error",
            error: staleReason,
            finishedAt: new Date().toISOString(),
          });
          continue; // slot is free now — retry the insert
        }
      }
      return { runId: active.id, alreadyRunning: true };
    }

    try {
      await env.SITE_STUDY_WORKFLOW.create({
        id: runId,
        params: { runId, projectId },
      });
    } catch (error) {
      // Workflow couldn't start — flip the run to error so the partial-index
      // slot is released. Best-effort cleanup of any zombie instance.
      await SiteStudyRepository.updateRun(runId, {
        status: "error",
        error: "Failed to start study workflow",
        finishedAt: new Date().toISOString(),
      });
      try {
        const instance = await env.SITE_STUDY_WORKFLOW.get(runId);
        await instance.terminate();
      } catch {
        // Workflow may not have been created.
      }
      throw error;
    }
    return { runId, alreadyRunning: false };
  }

  throw new AppError("CONFLICT", "Could not start the site study. Try again.");
}

type InventoryRow = {
  kind: "post" | "page" | "hub" | "other";
  wordCount: number | null;
  publishedAt: string | null;
};

/**
 * Aggregate content_pages rows into what the Content inventory card renders.
 * Pure and exported for tests; `now` anchors the trailing-12-month cadence
 * window.
 */
export function summarizeInventory(
  rows: InventoryRow[],
  now: Date,
): ContentInventorySummary {
  const kindCounts = { post: 0, page: 0, hub: 0, other: 0 };
  const wordCounts: number[] = [];
  let lastPublishedAt: string | null = null;
  const countByMonth = new Map<string, number>();

  for (const row of rows) {
    kindCounts[row.kind] += 1;
    if (row.wordCount !== null) wordCounts.push(row.wordCount);
    if (row.kind === "post" && row.publishedAt) {
      if (lastPublishedAt === null || row.publishedAt > lastPublishedAt) {
        lastPublishedAt = row.publishedAt;
      }
      const month = row.publishedAt.slice(0, 7);
      countByMonth.set(month, (countByMonth.get(month) ?? 0) + 1);
    }
  }

  // Trailing 12 months, oldest first, ending in the current month — zero
  // months stay present so cadence gaps render as gaps, not missing bars.
  const monthlyPosts: Array<{ month: string; count: number }> = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i));
    const month = d.toISOString().slice(0, 7);
    monthlyPosts.push({ month, count: countByMonth.get(month) ?? 0 });
  }

  const sorted = wordCounts.toSorted((a, b) => a - b);
  const medianWordCount =
    sorted.length === 0
      ? null
      : sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]
        : Math.round(
            (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2,
          );

  return {
    totalPages: rows.length,
    kindCounts,
    medianWordCount,
    lastPublishedAt,
    monthlyPosts,
  };
}

/** The polling payload: last run, the inventory summary the cards render
 *  ("Site studied · 214 pages, 34 posts"), and — while a study's audit is
 *  crawling — its live page counts for the progress spine. */
async function getStudy(projectId: string): Promise<RankloopSiteStudy> {
  const [lastRun, rows] = await Promise.all([
    SiteStudyRepository.getLatestRunForProject(projectId),
    SiteStudyRepository.getInventoryRows(projectId),
  ]);

  // No rows = no study has produced anything yet — the null is the card's
  // "Study my site" empty state, so an all-deleted corpus resurfaces it.
  const inventory =
    rows.length > 0 ? summarizeInventory(rows, new Date()) : null;

  const studying =
    lastRun?.status === "pending" || lastRun?.status === "running";
  const auditProgress = studying
    ? await SiteStudyRepository.getRunningAuditProgress(projectId)
    : null;

  return { lastRun, inventory, auditProgress };
}

// ---------------------------------------------------------------------------
// Derive (called from the workflow's derive step)
// ---------------------------------------------------------------------------

/**
 * Promote a completed audit's audit_pages into content_pages: upsert every
 * eligible page (source='crawl'), then delete the crawl-sourced rows this
 * derive didn't touch. Idempotent — upserts on (projectId, url) and a
 * marker-scoped delete — so the workflow step wrapping it is safe to retry.
 * Returns the number of rows derived, and throws rather than deleting when a
 * crawl that saw pages could load none of them.
 */
async function deriveFromAudit(input: {
  projectId: string;
  auditId: string;
  /** The audit's completedAt — one stable marker per derive, stamped as
   *  lastCrawledAt on every row so the stale-delete can scope on it. */
  crawlMark: string;
}): Promise<number> {
  const pages = await SiteStudyRepository.getPagesForDerive(input.auditId);

  // Only pages a visitor can actually load belong in the inventory: 200 +
  // ok. Redirect hops, 4xx/5xx, and bot-challenge rows are crawl artifacts,
  // not content. Non-indexable 200s stay — they classify as 'other'.
  const eligible = pages.filter(
    (page) => page.statusCode === 200 && page.fetchClass === "ok",
  );

  const kindInputs: Array<DeriveKindInput & { url: string }> = eligible.map(
    (page) => ({
      url: page.url,
      path: urlToPath(page.url),
      publishedAt: page.publishedAt,
      wordCount: page.wordCount,
      isIndexable: page.isIndexable,
      outlinkPaths: parseOutlinkPaths(page.outlinkPathsJson),
    }),
  );
  const kinds = derivePageKinds(kindInputs);
  const inlinks = invertInlinkCounts(kindInputs);

  const upserts: ContentPageUpsert[] = eligible.map((page, index) => {
    const { path, outlinkPaths } = kindInputs[index];
    return {
      projectId: input.projectId,
      url: page.url,
      path,
      kind: kinds.get(path) ?? "page",
      title: page.title || null,
      description: page.metaDescription || null,
      publishedAt: page.publishedAt,
      modifiedAt: page.modifiedAt,
      wordCount: page.wordCount,
      inlinkCount: inlinks.get(path) ?? 0,
      outlinkPathsJson:
        outlinkPaths.length > 0 ? JSON.stringify(outlinkPaths) : null,
      contentHash: page.contentHash,
      lastCrawledAt: input.crawlMark,
    };
  });

  await SiteStudyRepository.upsertContentPages(upserts);

  // No loadable pages is a degraded crawl, not an emptied site: a WAF
  // challenge day or a site-wide 5xx crawls every URL and derives nothing.
  // The delete below is scoped only by the marker, so on that verdict it
  // would take every crawl-sourced row with it — category, keyword and
  // pageTypeId included. Failing the run keeps the manifest intact and the
  // next weekly study repairs it.
  if (eligible.length === 0 && pages.length > 0) {
    throw new Error(
      `Audit ${input.auditId} derived no loadable pages (${pages.length} crawled, 0 eligible) — refusing to empty the content manifest`,
    );
  }

  await SiteStudyRepository.deleteStaleCrawlPages(
    input.projectId,
    input.crawlMark,
  );
  return upserts.length;
}

function parseOutlinkPaths(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

export const SiteStudyService = {
  startStudy,
  getStudy,
  deriveFromAudit,
};
