import type { BillingCustomerContext } from "@/server/billing/subscription";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { normalizeIntent } from "@/server/features/keywords/services/research/helpers";
import type { UniverseCandidate } from "@/server/features/rankloop/universe/services/keywordAdmission";

// Paid expansion around what the backlog already believes in: Labs related
// keywords for the highest-scoring rows a project has. Opt-in because it is
// the only source that spends money without a competitor or a search console
// behind it — a project with a thin backlog would be paying to expand noise.

/** Seeds per run. Twenty related-keyword calls is ~$0.20, and the twenty-first
 *  best row in a backlog is not a better bet than re-running next week with a
 *  backlog that learned something. */
export const EXPANSION_SEED_LIMIT = 20;

/** Rows per seed. Labs bills per returned row; 100 covers the useful
 *  neighbourhood of a keyword without paying for its suburbs. */
export const EXPANSION_ROWS_PER_SEED = 100;

/** The four fields this source reads off a Labs keyword payload. Declared
 *  structurally rather than as the SDK's own item type so the fold can be
 *  exercised with plain objects — the SDK models are classes, and a test
 *  fixture would otherwise need a cast to pretend to be one. */
type ExpansionKeywordData = {
  keyword?: string | null;
  keyword_info?: { search_volume?: number | null } | null;
  keyword_properties?: { keyword_difficulty?: number | null } | null;
  search_intent_info?: { main_intent?: string | null } | null;
};

/** Fold Labs keyword payloads into candidates. Volume, difficulty and intent
 *  all come measured here — this is the one source that arrives with numbers,
 *  which is exactly what it costs money for. */
export function toExpansionCandidates(
  items: ExpansionKeywordData[],
  seed: string,
): UniverseCandidate[] {
  const candidates: UniverseCandidate[] = [];
  for (const item of items) {
    const keyword = item.keyword?.trim().toLowerCase();
    if (!keyword || keyword === seed) continue;
    const intent = normalizeIntent(item.search_intent_info?.main_intent);
    candidates.push({
      keyword,
      source: "expansion",
      searchVolume: item.keyword_info?.search_volume ?? null,
      keywordDifficulty: item.keyword_properties?.keyword_difficulty ?? null,
      intent: intent === "unknown" ? null : intent,
      seed,
    });
  }
  return candidates;
}

/**
 * One metered call per seed. A seed whose call fails costs the run that
 * seed's neighbourhood — the rest still expand, and the failed one comes back
 * as a seed next week because its score didn't change.
 */
export async function expandSeeds(input: {
  seeds: string[];
  locationCode: number;
  languageCode: string;
  billingCustomer: BillingCustomerContext;
}): Promise<UniverseCandidate[]> {
  const client = createDataforseoClient(input.billingCustomer);
  const candidates: UniverseCandidate[] = [];

  for (const seed of input.seeds.slice(0, EXPANSION_SEED_LIMIT)) {
    try {
      const items = await client.keywords.related({
        keyword: seed,
        locationCode: input.locationCode,
        languageCode: input.languageCode,
        limit: EXPANSION_ROWS_PER_SEED,
        depth: 2,
      });
      // Related items wrap the keyword payload one level deeper than
      // suggestions/ideas do.
      candidates.push(
        ...toExpansionCandidates(
          items.flatMap((item) =>
            item.keyword_data ? [item.keyword_data] : [],
          ),
          seed,
        ),
      );
    } catch (error) {
      console.warn(`[universe] expansion failed for "${seed}":`, error);
    }
  }
  return candidates;
}
