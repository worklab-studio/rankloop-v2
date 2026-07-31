import type { BillingCustomerContext } from "@/server/billing/subscription";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import type { DomainIntersectionItem } from "@/server/lib/dataforseo";
import { normalizeIntent } from "@/server/features/keywords/services/research/helpers";
import type { UniverseCandidate } from "@/server/features/rankloop/universe/services/keywordAdmission";

// The keyword gap: what a tracked competitor ranks top-10 for and this site
// doesn't rank for at all. The most expensive source in the universe and the
// only one that needs no seed — the competitor already did the research.

/** Rows per competitor. DataForSEO Labs bills domain_intersection per
 *  returned row, and 100 is where the UI's "~$0.02 per competitor" sentence
 *  comes from — past it the tail is keywords they rank for by accident. */
export const GAP_ROWS_PER_COMPETITOR = 100;

/** "They top-10" — the definition of a gap worth chasing. A competitor
 *  sitting at position 40 for a keyword has not proven it is winnable; they
 *  have proven the same thing we would prove by publishing badly. */
const GAP_MAX_COMPETITOR_POSITION = 10;

/**
 * Fold one intersection response into candidates.
 *
 * Admitted **unfiltered by KD**, deliberately: the adaptive ceiling belongs at
 * scoring, where it can be re-applied every time it moves, not at admission,
 * where a hard keyword dropped today is a row that never comes back when the
 * site gets stronger. The competitor's position rides along in notesJson so
 * the tab can say who is holding the keyword and where.
 */
export function toGapCandidates(
  items: DomainIntersectionItem[],
  competitorDomain: string,
): UniverseCandidate[] {
  const candidates: UniverseCandidate[] = [];
  for (const item of items) {
    const keyword = item.keyword_data?.keyword?.trim().toLowerCase();
    if (!keyword) continue;
    const element = item.first_domain_serp_element;
    const position = element?.rank_group ?? element?.rank_absolute ?? null;
    if (position === null || position > GAP_MAX_COMPETITOR_POSITION) continue;

    const intent = normalizeIntent(
      item.keyword_data?.search_intent_info?.main_intent,
    );
    candidates.push({
      keyword,
      source: "gap",
      searchVolume: item.keyword_data?.keyword_info?.search_volume ?? null,
      keywordDifficulty:
        item.keyword_data?.keyword_properties?.keyword_difficulty ?? null,
      intent: intent === "unknown" ? null : intent,
      seed: competitorDomain,
      notes: { competitor: competitorDomain, competitorPosition: position },
    });
  }
  return candidates;
}

/**
 * One metered call per tracked competitor. `intersections: false` asks the
 * endpoint for the half of the Venn diagram we don't own, so a competitor
 * with no gap costs one call and returns nothing — which is a finding, not a
 * failure.
 */
export async function collectCompetitorGap(input: {
  siteDomain: string;
  competitorDomains: string[];
  locationCode: number;
  languageCode: string;
  billingCustomer: BillingCustomerContext;
}): Promise<UniverseCandidate[]> {
  const client = createDataforseoClient(input.billingCustomer);
  const candidates: UniverseCandidate[] = [];

  for (const domain of input.competitorDomains) {
    // One competitor's endpoint failure (a domain Labs has no index for, a
    // subscription that doesn't cover the endpoint) costs the run that
    // competitor's gap, not the other competitors' gaps.
    try {
      const items = await client.labs.domainIntersection({
        target1: domain,
        target2: input.siteDomain,
        locationCode: input.locationCode,
        languageCode: input.languageCode,
        limit: GAP_ROWS_PER_COMPETITOR,
      });
      candidates.push(...toGapCandidates(items, domain));
    } catch (error) {
      console.warn(`[universe] gap failed for ${domain}:`, error);
    }
  }
  return candidates;
}
