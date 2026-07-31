import { CompetitorsRepository } from "@/server/features/rankloop/competitors/repositories/CompetitorsRepository";
import {
  buildCadenceBuckets,
  classifyPathByShape,
  extractStructuralFeatures,
  summarizePageTypeMix,
  type CadenceBucket,
  type PageTypeMixEntry,
  type StructuralFeatures,
} from "@/server/features/rankloop/competitors/study.logic";
import { urlToPath } from "@/server/features/rankloop/site-study/services/derive.logic";
import { discoverUrls, parseRobotsTxt } from "@/server/lib/audit/discovery";
import { fetchPageHtml } from "@/server/workflows/site-audit-workflow-helpers";

// A competitor's sitemap is read for shape, not inventoried, so the ceiling
// only has to be past "big content site": 5,000 URLs covers that and keeps
// the step's return (cadence + mix + a 45-URL plan) far under the ~1 MiB
// Workflow step-output limit.
const MAX_SITEMAP_URLS = 5_000;

// The two cohorts the playbook compares: their best-earning pages against an
// evenly-spaced sample of ordinary ones. 30 + 15 is two crawl batches.
const WINNER_CRAWL_LIMIT = 30;
const MEDIAN_SAMPLE_SIZE = 15;

/** One batch per step: 25 sequential fetches at a 15-second timeout each fits
 *  inside a free step's 5-minute budget with room for a slow site. */
export const CRAWL_BATCH_SIZE = 25;

export type SitemapStudy = {
  cadence: CadenceBucket[];
  pageTypeMix: PageTypeMixEntry[];
  contentPageCount: number;
  /** Robots-allowed crawl plan, winners first then the median sample. */
  winnerUrls: string[];
  sampleUrls: string[];
};

/**
 * The always-on half of a competitor study: robots.txt → sitemap(s) → the
 * publishing shape those URLs imply. Free, and it is the reason a competitor
 * behind a WAF still produces a playbook — cadence and page-type mix come
 * from URLs and lastmods, never from page bodies.
 *
 * `earningUrls` are the top-earning pages Labs reported; they are filtered
 * against robots here rather than at crawl time so the whole plan obeys one
 * parse of one robots.txt.
 */
export async function studySitemap(input: {
  domain: string;
  earningUrls: string[];
}): Promise<SitemapStudy> {
  const origin = `https://${input.domain}`;
  const { urls, robotsText, lastmodByUrl } = await discoverUrls(
    origin,
    MAX_SITEMAP_URLS,
  );
  const robots = parseRobotsTxt(origin, robotsText);

  const contentUrls = urls.filter(
    (url) => classifyPathByShape(urlToPath(url)) !== "other",
  );
  const postUrls = contentUrls.filter(
    (url) => classifyPathByShape(urlToPath(url)) === "post",
  );

  // Cadence is a posting-frequency signal, so it counts posts — a site that
  // touches its pricing page monthly is not publishing monthly.
  const cadence = buildCadenceBuckets(
    postUrls.map((url) => lastmodByUrl[url] ?? null),
    new Date(),
  );

  const winnerUrls = input.earningUrls
    .filter((url) => robots.isAllowed(url))
    .slice(0, WINNER_CRAWL_LIMIT);
  const winnerSet = new Set(winnerUrls);
  const sampleUrls = pickEvenlySpaced(
    postUrls.filter((url) => !winnerSet.has(url) && robots.isAllowed(url)),
    MEDIAN_SAMPLE_SIZE,
  );

  return {
    cadence,
    pageTypeMix: summarizePageTypeMix(urls.map((url) => urlToPath(url))),
    contentPageCount: contentUrls.length,
    winnerUrls,
    sampleUrls,
  };
}

/**
 * Evenly spaced rather than first-N: sitemaps are usually emitted in
 * publication order, so the head of the list is a site's oldest (or newest)
 * work and would make the "median page" cohort a cohort of one era.
 */
export function pickEvenlySpaced<T>(items: T[], count: number): T[] {
  if (items.length <= count) return [...items];
  const stride = items.length / count;
  const picked: T[] = [];
  for (let i = 0; i < count; i++) picked.push(items[Math.floor(i * stride)]);
  return picked;
}

export type CrawledFeature = {
  url: string;
  cohort: "winner" | "sample";
  features: StructuralFeatures | null;
  blocked: boolean;
};

/**
 * Fetch one batch and extract its structural features, persisting what it
 * measured before returning. Persisting inside the step means a batch that
 * later gets blocked keeps whatever the earlier batches proved.
 */
export async function crawlFeatureBatch(input: {
  competitorId: string;
  batch: Array<{ url: string; cohort: "winner" | "sample" }>;
}): Promise<CrawledFeature[]> {
  const results: CrawledFeature[] = [];
  for (const target of input.batch) {
    const page = await fetchPageHtml(target.url);
    const features =
      page.fetchClass === "ok" && page.html
        ? extractStructuralFeatures(page.html)
        : null;
    results.push({
      url: target.url,
      cohort: target.cohort,
      features,
      blocked: page.fetchClass === "blocked",
    });
  }

  // Only the earning pages have a competitor_pages row to update — the median
  // sample comes from the sitemap, so its UPDATEs match nothing and its
  // features live only in the summary's median column. That is the point of
  // the sample: it is the baseline, not inventory.
  const measured = results.flatMap((result) =>
    result.features
      ? [
          {
            competitorId: input.competitorId,
            url: result.url,
            wordCount: result.features.wordCount,
            structuralFeaturesJson: JSON.stringify(result.features),
          },
        ]
      : [],
  );
  if (measured.length > 0) {
    await CompetitorsRepository.updateCompetitorPageFeatures(measured);
  }

  return results;
}

/**
 * Did this batch prove the site won't be crawled? Only a batch that measured
 * nothing AND was actively blocked degrades the study — a batch of 404s or
 * timeouts is a bad URL list, not a WAF, and the next batch may well succeed.
 */
export function isBlockedBatch(results: CrawledFeature[]): boolean {
  if (results.length === 0) return false;
  return (
    results.every((result) => result.features === null) &&
    results.some((result) => result.blocked)
  );
}
