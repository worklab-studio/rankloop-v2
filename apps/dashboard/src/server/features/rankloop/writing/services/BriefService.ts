import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { PagePlanRepository } from "@/server/features/rankloop/page-plan/repositories/PagePlanRepository";
import {
  hasSerpProvider,
  readPaaQuestions,
  toSerpSample,
} from "@/server/features/rankloop/page-plan/services/planSerpSampling";
import { ProposalsRepository } from "@/server/features/rankloop/proposals/repositories/ProposalsRepository";
import {
  assembleBrief,
  parseSerpSnapshot,
} from "@/server/features/rankloop/writing/brief";
import { BriefRepository } from "@/server/features/rankloop/writing/repositories/BriefRepository";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { AppError } from "@/server/lib/errors";
import {
  PLAN_SERP_CALL_COST_USD,
  PLAN_SERP_DEPTH,
} from "@/shared/rankloop-page-plan";
import { parseTemplateContract } from "@/types/schemas/rankloopPagePlan";

// buildBrief: the document the writer will receive, assembled from stored
// facts and rendered by the engine. Nothing in this file calls a model —
// S7b's generator consumes what this produces, and the point of the split is
// that a human can read the contract before anything is written against it.
//
// One SERP is the only thing a brief can spend money on, and it spends it at
// most once: the page plan's sample is reused when it exists, a grounding
// sample the last brief bought is reused after that, and only a keyword
// neither ever touched reaches the provider.

/** Where the Search-context section came from — the drawer stamps it, because
 *  "cached from your page plan" and "we just bought this" are different
 *  sentences to a user who is watching their spend. */
type BriefSerpSource = "plan" | "grounding" | "fetched" | "none";

type BriefCostPreview = {
  keyword: string;
  cachedSerpSource: "plan" | "grounding" | null;
  cachedSerpFetchedAt: string | null;
  /** True only when a fetch would actually happen: no cached snapshot AND a
   *  provider to call. */
  willFetchSerp: boolean;
  costUsd: number;
  serpProviderConfigured: boolean;
};

type BriefResult = {
  markdown: string;
  keyword: string;
  serpSource: BriefSerpSource;
  serpFetchedAt: string | null;
  /** What this call actually spent, not what it might have. */
  costUsd: number;
};

// ---------------------------------------------------------------------------
// Context resolution
// ---------------------------------------------------------------------------

async function loadContext(projectId: string, proposalId: string) {
  const proposal = await ProposalsRepository.getProposalById(
    projectId,
    proposalId,
  );
  if (!proposal) throw new AppError("NOT_FOUND", "Proposal not found.");
  if (proposal.track !== "net_new" || proposal.type !== "write_new") {
    throw new AppError(
      "VALIDATION_ERROR",
      "Only net-new proposals have a writer brief.",
    );
  }
  if (!proposal.keywordBacklogId || !proposal.pageTypeId) {
    throw new AppError(
      "VALIDATION_ERROR",
      "This proposal has no keyword or page type to brief from.",
    );
  }

  const [project, row, pageType, allTypes, pages, settings] = await Promise.all(
    [
      ProjectRepository.getProjectById(projectId),
      BriefRepository.getKeywordRow(projectId, proposal.keywordBacklogId),
      PagePlanRepository.getPageTypeById(projectId, proposal.pageTypeId),
      PagePlanRepository.getPageTypes(projectId),
      BriefRepository.getLinkablePages(projectId),
      BriefRepository.getWriterSettings(projectId),
    ],
  );

  if (!project) throw new AppError("NOT_FOUND", "Project not found.");
  // Both are plain ids by design (a decision record outlives its inputs), so
  // a missing row is a real state and not a broken join.
  if (!row) {
    throw new AppError(
      "NOT_FOUND",
      "The keyword behind this proposal is gone.",
    );
  }
  if (!pageType) {
    throw new AppError(
      "NOT_FOUND",
      "The page type behind this proposal is gone.",
    );
  }

  return { project, row, pageType, allTypes, pages, settings };
}

// ---------------------------------------------------------------------------
// The SERP, cached or bought
// ---------------------------------------------------------------------------

async function readCachedSerp(projectId: string, keyword: string) {
  const plan = await BriefRepository.getLatestSerpSnapshot(
    projectId,
    keyword,
    "plan",
  );
  if (plan) return { purpose: "plan" as const, snapshot: plan };

  const grounding = await BriefRepository.getLatestSerpSnapshot(
    projectId,
    keyword,
    "grounding",
  );
  return grounding
    ? { purpose: "grounding" as const, snapshot: grounding }
    : null;
}

/**
 * What opening this brief would cost, before it costs it.
 *
 * Read-only and provider-free: the drawer calls this first so it can state the
 * price in the same click the user is deciding about, which is the house rule
 * for anything metered.
 */
async function getBriefCost(input: {
  projectId: string;
  proposalId: string;
}): Promise<BriefCostPreview> {
  const { row } = await loadContext(input.projectId, input.proposalId);
  const cached = await readCachedSerp(input.projectId, row.keyword);
  const providerConfigured = hasSerpProvider();
  const willFetchSerp = cached === null && providerConfigured;

  return {
    keyword: row.keyword,
    cachedSerpSource: cached?.purpose ?? null,
    cachedSerpFetchedAt: cached?.snapshot.fetchedAt ?? null,
    willFetchSerp,
    costUsd: willFetchSerp ? PLAN_SERP_CALL_COST_USD : 0,
    serpProviderConfigured: providerConfigured,
  };
}

/**
 * Buy one SERP and store it.
 *
 * One attempt, no retry: a brief is rebuilt on demand and a second live call
 * would double the spend on a keyword whose first call already failed. A
 * failure costs the brief its Search-context section, which the engine renders
 * as an honest line, and costs the user nothing.
 */
async function fetchGroundingSerp(input: {
  projectId: string;
  keyword: string;
  locationCode: number;
  languageCode: string;
  billingCustomer: BillingCustomerContext;
}) {
  const client = createDataforseoClient(input.billingCustomer);
  const items = await client.serp.live({
    keyword: input.keyword,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    depth: PLAN_SERP_DEPTH,
  });
  const sample = toSerpSample(input.keyword, items);
  const paa = readPaaQuestions(items);

  // Stored in the same shape the plan writes, so the next reader cannot tell
  // (and does not need to tell) which run paid for it.
  await BriefRepository.insertGroundingSerpSnapshot({
    projectId: input.projectId,
    keyword: input.keyword,
    organicJson: JSON.stringify(sample.organic),
    paaJson: paa.length > 0 ? JSON.stringify(paa) : null,
    featuresJson: JSON.stringify({
      aiOverview: sample.aiOverview,
      featuredSnippet: sample.featuredSnippet,
    }),
  });
  return {
    organicJson: JSON.stringify(sample.organic),
    paaJson: paa.length > 0 ? JSON.stringify(paa) : null,
  };
}

// ---------------------------------------------------------------------------
// buildBrief
// ---------------------------------------------------------------------------

async function buildBrief(input: {
  projectId: string;
  proposalId: string;
  billingCustomer: BillingCustomerContext;
  /** False renders the brief on cached grounding only. The drawer sends true
   *  after it has shown the user what the fetch costs. */
  allowSerpFetch: boolean;
}): Promise<BriefResult> {
  const context = await loadContext(input.projectId, input.proposalId);
  const keyword = context.row.keyword;

  const cached = await readCachedSerp(input.projectId, keyword);
  let source: BriefSerpSource = cached?.purpose ?? "none";
  let fetchedAt = cached?.snapshot.fetchedAt ?? null;
  let costUsd = 0;
  let snapshot: { organicJson: string; paaJson: string | null } | null =
    cached?.snapshot ?? null;

  if (!snapshot && input.allowSerpFetch && hasSerpProvider()) {
    try {
      snapshot = await fetchGroundingSerp({
        projectId: input.projectId,
        keyword,
        locationCode: context.project.locationCode,
        languageCode: context.project.languageCode,
        billingCustomer: input.billingCustomer,
      });
      source = "fetched";
      fetchedAt = new Date().toISOString();
      costUsd = PLAN_SERP_CALL_COST_USD;
    } catch (error) {
      // Operational, not fatal: the brief is still the writer's contract
      // without a SERP section, and failing the whole drawer over one provider
      // hiccup would hide a document that is already complete enough to write
      // from.
      console.info(
        `[rankloop-writing] grounding SERP unavailable for "${keyword}": ${String(error)}`,
      );
    }
  }

  const serp = snapshot ? parseSerpSnapshot(snapshot) : null;
  // A stored snapshot an older shape wrote parses to nothing. The spend is
  // real and still reported, but the brief has no Search context and says so
  // rather than claiming a source it did not use.
  if (!serp) source = "none";

  const markdown = assembleBrief({
    site: {
      url: context.project.domain ? `https://${context.project.domain}` : "",
      name: context.project.name,
      description: "",
    },
    row: context.row,
    pageTypeName: context.pageType.name,
    contract: parseTemplateContract(context.pageType.templateContractJson),
    urlPattern: context.pageType.urlPattern,
    approvedTypeNames: context.allTypes
      .filter((type) => type.status === "approved")
      .map((type) => type.name),
    pages: context.pages,
    serp,
    voiceCardMd: context.settings?.voiceCardMd ?? null,
    today: new Date().toISOString().slice(0, 10),
  });

  return {
    markdown,
    keyword,
    serpSource: source,
    serpFetchedAt: fetchedAt,
    costUsd,
  };
}

export const BriefService = {
  getBriefCost,
  buildBrief,
};
