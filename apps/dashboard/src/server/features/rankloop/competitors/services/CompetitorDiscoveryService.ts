import { env, waitUntil } from "cloudflare:workers";
import { z } from "zod";
import { CompetitorsRepository } from "@/server/features/rankloop/competitors/repositories/CompetitorsRepository";
import type { SuggestedCompetitorInsert } from "@/server/features/rankloop/competitors/repositories/CompetitorsRepository";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { normalizeDomainInput } from "@/server/lib/domainUtils";
import { AppError } from "@/server/lib/errors";
import { buildCacheKey, getCached, setCached } from "@/server/lib/r2-cache";
import type { BillingCustomerContext } from "@/server/billing/subscription";

/** Competitor sets move on the timescale of a SERP, not a session — the same
 *  12 hours the domain overview caches on. */
const DISCOVERY_TTL_SECONDS = 12 * 60 * 60;

// Labs returns competitors ordered by keyword overlap. 20 is enough to fill a
// suggested list a human will actually read through; past that the overlap
// tail is domains that share a handful of long-tail queries.
const DISCOVERY_LIMIT = 20;

const discoveredCompetitorSchema = z.object({
  domain: z.string(),
  overlapKeywords: z.number().nullable(),
  estTraffic: z.number().nullable(),
});

const discoveryResultSchema = z.array(discoveredCompetitorSchema);

type DiscoveredCompetitor = z.infer<typeof discoveredCompetitorSchema>;

/**
 * Ask DataForSEO Labs which domains rank for the project's keywords, and file
 * the ones we've never seen as suggestions.
 *
 * Discovery only ever ADDS: a domain already in the table has been decided on
 * — tracked, or skipped — and re-running discovery must not walk that back or
 * overwrite metrics a study measured. That filter lives here rather than in
 * the upsert so it is the thing the tests pin.
 */
async function discoverCompetitors(input: {
  projectId: string;
  organizationId: string;
  domain: string;
  locationCode: number;
  languageCode: string;
  billingCustomer: BillingCustomerContext;
}): Promise<{ suggested: number }> {
  if (!env.DATAFORSEO_API_KEY?.trim()) {
    // The surface renders this as the setup pitch, not an error toast — the
    // manual add above it works without a key and stays usable.
    throw new AppError(
      "DATAFORSEO_AUTH_FAILED",
      "Add your DataForSEO API key to discover the domains you compete with.",
    );
  }

  const target = normalizeDomainInput(input.domain, false);
  const discovered = await fetchDiscovery({ ...input, target });

  const existing = await CompetitorsRepository.listCompetitors(input.projectId);
  const known = new Set(existing.map((competitor) => competitor.domain));
  const rows: SuggestedCompetitorInsert[] = discovered
    .filter(
      (candidate) =>
        candidate.domain !== target && !known.has(candidate.domain),
    )
    .map((candidate) => ({
      projectId: input.projectId,
      domain: candidate.domain,
      discoveredVia: "labs_competitors_domain",
      organicKeywords: candidate.overlapKeywords,
      estTraffic: candidate.estTraffic,
    }));

  if (rows.length > 0) {
    await CompetitorsRepository.insertSuggestedCompetitors(rows);
  }
  console.log(
    `[competitors] discovery for project ${input.projectId} suggested ${rows.length} of ${discovered.length} domains`,
  );
  return { suggested: rows.length };
}

/** The metered call, behind the shared R2 cache. Cached on the org + target +
 *  market so two projects on the same domain don't pay twice. */
async function fetchDiscovery(input: {
  projectId: string;
  organizationId: string;
  target: string;
  locationCode: number;
  languageCode: string;
  billingCustomer: BillingCustomerContext;
}): Promise<DiscoveredCompetitor[]> {
  const cacheKey = await buildCacheKey("competitors:discovery", {
    organizationId: input.organizationId,
    target: input.target,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    limit: DISCOVERY_LIMIT,
  });

  const cached = discoveryResultSchema.safeParse(await getCached(cacheKey));
  if (cached.success) return cached.data;

  const client = createDataforseoClient(input.billingCustomer);
  const items = await client.labs.competitorsDomain({
    target: input.target,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    limit: DISCOVERY_LIMIT,
  });

  const result: DiscoveredCompetitor[] = items.flatMap((item) => {
    const domain = item.domain?.trim().toLowerCase();
    if (!domain) return [];
    return [
      {
        domain,
        // `intersections` is the shared-keyword count — the overlap number the
        // suggested table ranks on, and the only metric worth paying for
        // before the user has decided the domain matters.
        overlapKeywords: item.intersections ?? null,
        estTraffic: item.full_domain_metrics?.organic?.etv ?? null,
      },
    ];
  });

  if (result.length > 0) {
    // waitUntil, not void: workerd cancels unregistered pending I/O once the
    // response is sent, so a fire-and-forget put never persists the cache.
    waitUntil(
      setCached(cacheKey, result, DISCOVERY_TTL_SECONDS).catch((error) => {
        console.error("competitors.discovery.cache-write failed:", error);
      }),
    );
  }

  return result;
}

export const CompetitorDiscoveryService = {
  discoverCompetitors,
};
