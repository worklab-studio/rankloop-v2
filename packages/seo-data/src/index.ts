/** @rankloop/seo-data — the paid-data layer with seatbelts.
 *
 * One client, one ledger: every DataForSEO call logs its real cost, a hard
 * cumulative ceiling stops runaway spend BEFORE the request fires, and the
 * same ledger interface later records LLM/image spend so cost-per-article
 * is a query, not a guess. */

export {
  DataForSeoClient, DataForSeoError, COST, projectDiscoverCost,
  type DataForSeoOptions, type KeywordIdea, type SerpOrganic, type RankedKeyword,
  type CompetitorDomain, type GapKeyword, type BacklinksSummary, type BacklinkItem,
} from "./client.ts";
export {
  MemoryLedger, BudgetExceededError,
  type SpendLedger, type SpendProvider,
} from "./ledger.ts";
