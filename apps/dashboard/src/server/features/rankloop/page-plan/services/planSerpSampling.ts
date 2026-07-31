import { env } from "cloudflare:workers";
import { z } from "zod";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { PagePlanRepository } from "@/server/features/rankloop/page-plan/repositories/PagePlanRepository";
import {
  judgeCandidateSerp,
  readSerpSample,
  unsampledSerpCheck,
  type SerpSample,
  type SerpSampleReading,
} from "@/server/features/rankloop/page-plan/serpVerdict.logic";
import type { PlanCandidateEntry } from "@/server/features/rankloop/page-plan/services/PagePlanService";
import { UniverseRepository } from "@/server/features/rankloop/universe/repositories/UniverseRepository";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import type { SerpLiveItem } from "@/server/lib/dataforseo";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import {
  PLAN_SERP_CALL_COST_USD,
  PLAN_SERP_DEPTH,
} from "@/shared/rankloop-page-plan";

// The metered half of a plan run: fetching a candidate's SERPs, storing them
// for S7 to reuse, and settling its verdict. Split from PagePlanService
// because everything here spends money and nothing else in the plan does —
// the free half must stay runnable, and readable, on its own.

export function hasSerpProvider(): boolean {
  return Boolean(env.DATAFORSEO_API_KEY?.trim());
}

const paaItemSchema = z.object({
  items: z.array(z.object({ title: z.string() })),
});

/**
 * Fold a live SERP response into the shape the verdict reads. Positions are
 * rank_group — organic rank, the number a user counts — so a SERP with three
 * features stacked above the results doesn't read as everything sitting at
 * position 4. Features are recorded only when the response carried them.
 */
export function toSerpSample(
  keyword: string,
  items: SerpLiveItem[],
): SerpSample {
  const organic = items.flatMap((item) => {
    if (item.type !== "organic") return [];
    const position = item.rank_group ?? item.rank_absolute ?? null;
    if (position === null || !item.url || !item.domain) return [];
    return [
      {
        position,
        url: item.url,
        domain: item.domain,
        title: item.title ?? "",
        description: item.description ?? null,
      },
    ];
  });
  return {
    keyword,
    organic,
    aiOverview: items.some((item) => item.type === "ai_overview"),
    featuredSnippet: items.some((item) => item.type === "featured_snippet"),
  };
}

/** The "people also ask" questions, when the response carried them — S7's
 *  briefs read these back out of the snapshot this run paid for, and use this
 *  same reader on the rare keyword no plan run ever sampled. */
export function readPaaQuestions(items: SerpLiveItem[]): string[] {
  return items.flatMap((item) => {
    if (item.type !== "people_also_ask") return [];
    const parsed = paaItemSchema.safeParse(item);
    return parsed.success ? parsed.data.items.map((entry) => entry.title) : [];
  });
}

/**
 * Sample one candidate's SERPs and settle its verdict.
 *
 * Every response is persisted with purpose='plan' before it is judged: the
 * money is spent either way, and S7's briefs read these snapshots back rather
 * than paying for the same keywords twice. A killed candidate flips to
 * 'declined' with its reason — planner-declined, decidedAt still null, so the
 * next recompute is free to change its mind.
 */
export async function sampleCandidate(input: {
  projectId: string;
  entry: PlanCandidateEntry;
  billingCustomer: BillingCustomerContext;
}): Promise<{ sampled: number; costUsd: number }> {
  const project = await ProjectRepository.getProjectById(input.projectId);
  if (!project) return { sampled: 0, costUsd: 0 };
  // The adaptive ceiling S5 earned from what this site already ranks for.
  // Read from the gate that owns it rather than copied here: a project with
  // no gate row still gets a ceiling (the fixed floor), so the caution rule is
  // live from the first plan run instead of dormant until a universe sync.
  const kdCeiling = await UniverseRepository.getKdCeiling(input.projectId);

  const client = createDataforseoClient(input.billingCustomer);
  const now = new Date();
  const readings: SerpSampleReading[] = [];
  for (const keyword of input.entry.sampleKeywords) {
    const items = await client.serp.live({
      keyword,
      locationCode: project.locationCode,
      languageCode: project.languageCode,
      depth: PLAN_SERP_DEPTH,
    });
    const sample = toSerpSample(keyword, items);
    const paa = readPaaQuestions(items);
    await PagePlanRepository.insertSerpSnapshot({
      projectId: input.projectId,
      keyword,
      organicJson: JSON.stringify(sample.organic),
      paaJson: paa.length > 0 ? JSON.stringify(paa) : null,
      featuresJson: JSON.stringify({
        aiOverview: sample.aiOverview,
        featuredSnippet: sample.featuredSnippet,
      }),
    });
    readings.push(readSerpSample(sample, now));
  }

  const check = judgeCandidateSerp({
    readings,
    kdBandP75: input.entry.kdBandP75,
    kdCeiling,
  });
  await PagePlanRepository.applySerpCheck({
    pageTypeId: input.entry.pageTypeId,
    serpCheckJson: JSON.stringify(check),
    status: check.status === "kill" ? "declined" : "proposed",
  });

  return {
    sampled: readings.length,
    costUsd: readings.length * PLAN_SERP_CALL_COST_USD,
  };
}

/** Mark a candidate the run couldn't afford (or couldn't reach a provider
 *  for). The card says which — "not sampled" with no reason is exactly the
 *  kind of silence this product doesn't do. */
export async function markUnsampled(
  pageTypeId: string,
  reason: string,
): Promise<void> {
  await PagePlanRepository.applySerpCheck({
    pageTypeId,
    serpCheckJson: JSON.stringify(unsampledSerpCheck(reason)),
    status: "proposed",
  });
}
