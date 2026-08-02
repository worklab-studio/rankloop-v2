import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { outreachTargets, pageTypes, projects } from "@/db/schema";
import {
  classifyTarget,
  isNonTarget,
  looksSubmittable,
  miningQueries,
  targetKey,
  type TargetKind,
} from "@/server/features/rankloop/outreach/armory.logic";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { PLAN_SERP_CALL_COST_USD, PLAN_SERP_DEPTH } from "@/shared/rankloop-page-plan";

// The metered lane of the armory (spec 0029): SERP-mined roundups.
//
// Split from ArmoryService for the same reason planSerpSampling is split
// from PagePlanService — everything here spends money and nothing else in
// the armory does. The free half must stay runnable, and readable, alone.

export function hasSerpProvider(): boolean {
  return Boolean(env.DATAFORSEO_API_KEY?.trim());
}

/** Two SERP pages per query is enough: a roundup that ranks past position 20
 *  for its own category is not a roundup anyone reads. */
const MINING_DEPTH = Math.max(PLAN_SERP_DEPTH, 20);

/**
 * What a mining run would cost, before anyone commits to it.
 *
 * Quoted from the same per-call constant the plan uses, so the two screens
 * cannot disagree about the price of a SERP.
 */
export function quoteMining(categories: readonly string[], year: number): {
  queries: number;
  costUsd: number;
} {
  const queries = categories.flatMap((c) => miningQueries(c, year)).length;
  return { queries, costUsd: Math.round(queries * PLAN_SERP_CALL_COST_USD * 1000) / 1000 };
}

/** The approved page types' nouns — what this site is actually about. */
async function miningCategories(projectId: string): Promise<string[]> {
  const rows = await db
    .select({ name: pageTypes.name })
    .from(pageTypes)
    .where(eq(pageTypes.projectId, projectId));
  const names = rows
    .map((r) => r.name.trim())
    .filter((n) => n !== "")
    // Cap the fan-out. Six queries per category means five categories is
    // thirty calls; letting an approved-everything project mine forty
    // categories would be a bill nobody quoted.
    .slice(0, 5);
  return [...new Set(names)];
}

export interface MiningResult {
  /** Queries attempted. Every one is billed, including the ones that error. */
  queries: number;
  /** Queries that came back usable. */
  succeeded: number;
  costUsd: number;
  discovered: number;
  /** Named so the UI can say what was searched rather than "done". */
  ranQueries: string[];
  /** Reported rather than swallowed: a run that quietly searched four of six
   *  looks like a thin category instead of a provider hiccup. */
  failedQueries: string[];
}

/**
 * Mine the roundups a category's incumbents are listed on.
 *
 * The trick is in the queries, not the parsing: a bare "{noun}" search
 * returns the category's incumbents, while "best {noun} tools" and "{noun}
 * alternatives" return the lists those incumbents are ON — which is where a
 * new product gets added.
 */
async function mine(input: {
  projectId: string;
  billingCustomer: BillingCustomerContext;
  year: number;
}): Promise<MiningResult> {
  const [project] = await db
    .select({
      domain: projects.domain,
      locationCode: projects.locationCode,
      languageCode: projects.languageCode,
    })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .limit(1);
  if (!project?.domain) {
    return {
      queries: 0, succeeded: 0, costUsd: 0, discovered: 0,
      ranQueries: [], failedQueries: [],
    };
  }

  const categories = await miningCategories(input.projectId);
  const queries = categories.flatMap((c) => miningQueries(c, input.year));
  if (queries.length === 0) {
    return {
      queries: 0, succeeded: 0, costUsd: 0, discovered: 0,
      ranQueries: [], failedQueries: [],
    };
  }

  const existing = await db
    .select({ domain: outreachTargets.domain })
    .from(outreachTargets)
    .where(eq(outreachTargets.projectId, input.projectId));
  const known = new Set(existing.map((row) => targetKey(row.domain)));
  const ourKey = targetKey(project.domain);

  const client = createDataforseoClient(input.billingCustomer);
  const found = new Map<
    string,
    { domain: string; url: string; title: string; kind: TargetKind; query: string }
  >();

  const failed: string[] = [];

  for (const keyword of queries) {
    // Each query stands alone.
    //
    // DataForSEO returns "Internal SE Server Error" on individual keywords
    // often enough that a run of six will hit one, and the call is CHARGED
    // when it does. Letting that throw abandons every query already paid for
    // in this run — the user is billed for six searches and shown nothing.
    // A failed query is recorded and skipped; the rest of the run keeps its
    // results.
    let items;
    try {
      items = await client.serp.live({
        keyword,
        locationCode: project.locationCode,
        languageCode: project.languageCode,
        depth: MINING_DEPTH,
      });
    } catch (error) {
      failed.push(keyword);
      console.warn(
        `[rankloop-armory] SERP query failed for "${keyword}":`,
        error instanceof Error ? error.message : error,
      );
      continue;
    }

    for (const item of items) {
      if (item.type !== "organic" || !item.url || !item.domain) continue;
      const key = targetKey(item.domain);
      // Our own site ranking for "best X tools" is not a link opportunity.
      if (key === ourKey || known.has(key) || found.has(key)) continue;
      if (isNonTarget(item.url)) continue;

      const kind = classifyTarget(item.url);
      // A result that is neither a roundup nor a submittable page is just a
      // competitor ranking for the query. Those belong to the plan, not here.
      if (kind === "resource_page" && !looksSubmittable(item.url)) continue;

      found.set(key, {
        domain: item.domain,
        url: item.url,
        title: item.title ?? item.domain,
        kind,
        query: keyword,
      });
    }
  }

  const now = new Date().toISOString();
  for (const target of found.values()) {
    await db
      .insert(outreachTargets)
      .values({
        id: crypto.randomUUID(),
        projectId: input.projectId,
        domain: target.domain,
        lane: "serp",
        kind: target.kind,
        // The ranking page IS the submission target for a roundup: that is
        // the page you ask to be added to, not the site's home page.
        submissionUrl: target.url,
        domainRank: null,
        competitorCount: 0,
        evidenceJson: JSON.stringify({
          serp: { query: target.query, url: target.url, title: target.title, foundAt: now },
        }),
        createdAt: now,
        updatedAt: now,
      })
      // A domain already on the board from another lane keeps its evidence;
      // this only fills in what mining knows and the other lane did not.
      .onConflictDoNothing();
  }

  return {
    queries: queries.length,
    succeeded: queries.length - failed.length,
    // Charged for every attempt, including the failures — quoting only the
    // successes would understate the bill the user actually receives.
    costUsd: Math.round(queries.length * PLAN_SERP_CALL_COST_USD * 1000) / 1000,
    discovered: found.size,
    ranQueries: queries,
    failedQueries: failed,
  };
}

export const ArmoryMiningService = {
  hasSerpProvider,
  quoteMining,
  miningCategories,
  mine,
};
