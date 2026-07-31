import { env } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { BacklinksService } from "@/server/features/backlinks/services/BacklinksService";
import { DomainService } from "@/server/features/domain/services/DomainService";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { CompetitorsRepository } from "@/server/features/rankloop/competitors/repositories/CompetitorsRepository";
import type {
  CompetitorLinkDomainUpsert,
  CompetitorPageUpsert,
} from "@/server/features/rankloop/competitors/repositories/CompetitorsRepository";
import {
  classifyPathByShape,
  compareWinnersToMedian,
  diffPageSnapshot,
  type SnapshotPage,
  type StructuralFeatures,
} from "@/server/features/rankloop/competitors/study.logic";
import type {
  CrawledFeature,
  SitemapStudy,
} from "@/server/features/rankloop/competitors/services/competitorCrawl";
import { urlToPath } from "@/server/features/rankloop/site-study/services/derive.logic";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import type { CompetitorPlaybook } from "@/types/schemas/rankloopCompetitors";

// DataForSEO Labs bills relevant_pages per returned row; 100 is where the
// tail stops being pages worth studying and starts being noise.
const TOP_PAGES_LIMIT = 100;

// The link gap is computed from the top of each competitor's referring-domain
// list, ordered by rank: the domains a human could plausibly write to sit at
// the top, and the tail is scrapers and parked domains. 200 per competitor
// keeps a five-competitor project's gap at 1000 rows to group, which is one
// join and a Map.
const REFERRING_DOMAINS_LIMIT = 200;

export type StudyContext = {
  competitorId: string;
  domain: string;
  projectId: string;
  organizationId: string;
  locationCode: number;
  languageCode: string;
  /** The snapshot the previous study left behind — read before this run
   *  overwrites it, so the refresh diff has two points to compare. */
  prior: SnapshotPage[];
};

/** The system actor every scheduled rankloop job bills through: a competitor
 *  study has no acting user, but metering needs one. */
function systemBillingCustomer(context: {
  organizationId: string;
  projectId: string;
}): BillingCustomerContext {
  return {
    userId: "system",
    userEmail: "system@openseo.so",
    organizationId: context.organizationId,
    projectId: context.projectId,
  };
}

function hasDataforseoKey(): boolean {
  return Boolean(env.DATAFORSEO_API_KEY?.trim());
}

// ---------------------------------------------------------------------------
// Step 1 — prepare
// ---------------------------------------------------------------------------

/** Flip the run to running and gather everything the later steps need,
 *  including the prior page snapshot the refresh diff compares against. */
async function prepare(input: {
  runId: string;
  projectId: string;
  competitorId: string;
}): Promise<StudyContext> {
  const run = await CompetitorsRepository.getStudyRunById(input.runId);
  if (!run || run.status === "done" || run.status === "error") {
    throw new NonRetryableError(
      `Run ${input.runId} is no longer active (status=${run?.status ?? "missing"})`,
    );
  }

  const competitor = await CompetitorsRepository.getCompetitorById(
    input.competitorId,
    input.projectId,
  );
  if (!competitor) {
    throw new NonRetryableError(`Competitor ${input.competitorId} not found`);
  }
  const project = await ProjectRepository.getProjectById(input.projectId);
  if (!project) {
    throw new NonRetryableError(`Project ${input.projectId} not found`);
  }

  await CompetitorsRepository.updateStudyRun(input.runId, {
    status: "running",
  });

  return {
    competitorId: competitor.id,
    domain: competitor.domain,
    projectId: input.projectId,
    organizationId: project.organizationId,
    locationCode: project.locationCode,
    languageCode: project.languageCode,
    prior: await CompetitorsRepository.getPageSnapshot(competitor.id),
  };
}

// ---------------------------------------------------------------------------
// Step 2 — authority metrics
// ---------------------------------------------------------------------------

/**
 * Fill the competitor's authority columns. Key-gated and non-fatal: with no
 * key (or a provider that refuses — backlinks is a separate DataForSEO
 * subscription many accounts don't hold) the columns are written as nulls and
 * the study carries on. The sitemap half is the part that always works, and a
 * playbook without a domain rank is still a playbook.
 */
async function recordMetrics(context: StudyContext): Promise<boolean> {
  if (!hasDataforseoKey()) {
    console.info(
      `[competitors] ${context.domain} metrics skipped — no DataForSEO key`,
    );
    return false;
  }
  const billingCustomer = systemBillingCustomer(context);

  const organic = await DomainService.getOverview(
    {
      projectId: context.projectId,
      domain: context.domain,
      includeSubdomains: false,
      locationCode: context.locationCode,
      languageCode: context.languageCode,
    },
    billingCustomer,
  ).catch((error: unknown) => {
    console.warn(
      `[competitors] ${context.domain} rank overview failed:`,
      error,
    );
    return null;
  });

  // Domain rank lives on the backlinks side, and that endpoint fails
  // independently of Labs — catch it separately so one missing subscription
  // doesn't null the organic numbers we already have.
  const authority = await BacklinksService.profileOverview(
    { target: context.domain, scope: "domain" },
    billingCustomer,
  ).catch((error: unknown) => {
    console.warn(`[competitors] ${context.domain} backlinks failed:`, error);
    return null;
  });

  await CompetitorsRepository.updateCompetitor(context.competitorId, {
    organicKeywords: organic?.organicKeywords ?? null,
    estTraffic: organic?.organicTraffic ?? null,
    domainRank: authority?.overview.summary.rank ?? null,
    backlinks: authority?.overview.summary.backlinks ?? null,
    referringDomains: authority?.overview.summary.referringDomains ?? null,
  });
  return organic !== null || authority !== null;
}

// ---------------------------------------------------------------------------
// Step 3 — top-earning pages
// ---------------------------------------------------------------------------

/**
 * The competitor's pages that actually earn traffic, filtered to the shapes
 * that carry content — a pricing page ranking for the brand name teaches
 * nothing about what to write. Key-gated and non-fatal: keyless, the study
 * has no earning cohort and the summarize step says so honestly instead of
 * inventing one.
 */
async function studyTopPages(context: StudyContext): Promise<SnapshotPage[]> {
  if (!hasDataforseoKey()) {
    console.info(
      `[competitors] ${context.domain} top pages skipped — no DataForSEO key`,
    );
    return [];
  }

  const client = createDataforseoClient(systemBillingCustomer(context));
  const page = await client.domain.relevantPages({
    target: context.domain,
    locationCode: context.locationCode,
    languageCode: context.languageCode,
    limit: TOP_PAGES_LIMIT,
    orderBy: ["metrics.organic.etv,desc"],
  });

  const rows: CompetitorPageUpsert[] = page.items.flatMap((item) => {
    const url = item.page_address?.trim();
    if (!url) return [];
    const kind = classifyPathByShape(urlToPath(url));
    if (kind === "other") return [];
    return [
      {
        competitorId: context.competitorId,
        url,
        title: null,
        pageType: kind,
        etv: item.metrics?.organic?.etv ?? null,
        keywordCount: item.metrics?.organic?.count ?? null,
      },
    ];
  });

  await CompetitorsRepository.upsertCompetitorPages(
    rows,
    new Date().toISOString(),
  );
  return rows.map((row) => ({ url: row.url, etv: row.etv }));
}

// ---------------------------------------------------------------------------
// Step 4 — referring domains
// ---------------------------------------------------------------------------

/**
 * Who links to this competitor — the raw material of the outreach link gap.
 * Key-gated and non-fatal like the two metered steps above: keyless, the
 * project simply has no gap to compute, and the Outreach tab says so instead
 * of the study failing.
 *
 * Ordered by rank rather than the client's own backlinks-desc default: the
 * question this feeds is "who could I reach", and a domain with 40 000 links
 * from a scraper network is not an answer. The competitor's own subdomains
 * are dropped — a site linking to itself is not a gap — and duplicates within
 * one page are collapsed so a batch can't conflict with itself.
 */
async function studyReferringDomains(context: StudyContext): Promise<number> {
  if (!hasDataforseoKey()) {
    console.info(
      `[competitors] ${context.domain} referring domains skipped — no DataForSEO key`,
    );
    return 0;
  }

  const client = createDataforseoClient(systemBillingCustomer(context));
  const page = await client.backlinks.referringDomains({
    target: context.domain,
    limit: REFERRING_DOMAINS_LIMIT,
    orderBy: ["rank,desc"],
  });

  const seen = new Set<string>();
  const rows: CompetitorLinkDomainUpsert[] = [];
  for (const item of page.items) {
    const domain = item.domain
      ?.trim()
      .toLowerCase()
      .replace(/^www\./, "");
    if (!domain || seen.has(domain)) continue;
    if (domain === context.domain || domain.endsWith(`.${context.domain}`)) {
      continue;
    }
    seen.add(domain);
    rows.push({
      competitorId: context.competitorId,
      domain,
      domainRank: item.rank ?? null,
      backlinks: item.backlinks ?? null,
    });
  }

  await CompetitorsRepository.upsertCompetitorLinkDomains(
    rows,
    new Date().toISOString(),
  );
  return rows.length;
}

// ---------------------------------------------------------------------------
// Step 5 — summarize
// ---------------------------------------------------------------------------

/**
 * Write the playbook and settle every page's status. A sitemap-only study
 * still writes a playbook — cadence and page-type mix are sitemap-derived and
 * true either way — but its feature deltas are empty, because nothing read a
 * page body. The card branches on coverage, not on a missing playbook.
 */
async function summarize(input: {
  context: StudyContext;
  sitemap: SitemapStudy;
  crawled: CrawledFeature[];
  coverage: "full" | "sitemap_only";
  current: SnapshotPage[];
}): Promise<{ pagesStudied: number }> {
  const cohort = (name: "winner" | "sample"): StructuralFeatures[] =>
    input.crawled.flatMap((result) =>
      result.cohort === name && result.features ? [result.features] : [],
    );
  const winners = compareWinnersToMedian(cohort("winner"), cohort("sample"));

  const playbook: CompetitorPlaybook = {
    cadence: input.sitemap.cadence,
    pageTypeMix: input.sitemap.pageTypeMix,
    totalContentPages: input.sitemap.contentPageCount,
    featureDeltas: input.coverage === "full" ? winners.deltas : [],
    winnersMedianWordCount: winners.winnersMedianWordCount,
    medianSampleWordCount: winners.sampleMedianWordCount,
    winnersStudied: winners.winnersStudied,
    sampleStudied: winners.sampleStudied,
  };

  // A run that measured no pages proves nothing about the ones already
  // stored. The top-earning step is key-gated and non-fatal, so a keyless (or
  // failed) run arrives here with an empty set — diffing it would mark every
  // page the last study found as 'removed' and fill the what-not-to-build
  // panel with fiction. No snapshot, no verdict.
  if (input.current.length > 0) {
    const diff = diffPageSnapshot({
      prior: input.context.prior,
      current: input.current,
    });
    // The three sets are disjoint by construction, so order only matters in
    // that every page ends up carrying exactly one status.
    await CompetitorsRepository.setPageStatuses(
      input.context.competitorId,
      diff.active,
      "active",
    );
    await CompetitorsRepository.setPageStatuses(
      input.context.competitorId,
      diff.decayed,
      "decayed",
    );
    await CompetitorsRepository.setPageStatuses(
      input.context.competitorId,
      diff.removed,
      "removed",
    );
  }

  await CompetitorsRepository.updateCompetitor(input.context.competitorId, {
    coverage: input.coverage,
    studySummaryJson: JSON.stringify(playbook),
    lastStudiedAt: new Date().toISOString(),
  });

  return { pagesStudied: input.current.length };
}

export const CompetitorStudyService = {
  prepare,
  recordMetrics,
  studyTopPages,
  studyReferringDomains,
  summarize,
};
