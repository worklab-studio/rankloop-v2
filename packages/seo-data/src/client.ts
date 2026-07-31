/** Thin DataForSEO client, ported from rankloop 0.2 discover.py and
 * extended to the read-side endpoints (ranked keywords, competitors,
 * keyword gap, backlinks).
 *
 * Deliberately NOT the official generated SDK: the value here is the
 * safety wrapper — dual-status validation, per-call cost capture, the
 * cumulative spend ledger, and a hard budget ceiling checked BEFORE every
 * paid call. ~200 lines, zero dependencies.
 *
 * DataForSEO nests status twice — body-level AND task-level — and both
 * must be 20000 or you're reading an error dressed as a 200. */

import { BudgetExceededError, type SpendLedger } from "./ledger.ts";

const BASE = "https://api.dataforseo.com/v3";

/** Cost model (USD, list prices at port time) for PROJECTIONS only. The
 * ledger always records the real cost returned in each response body.
 * Endpoints without an entry here are simply not projected up front. */
export const COST = {
  related: 0.011,
  volume: 0.05,
  difficulty: 0.001,
  serp: 0.002,
} as const;

export interface DataForSeoOptions {
  login: string;
  password: string;
  ledger: SpendLedger;
  /** Hard cumulative ceiling in USD. Checked before every call. */
  budgetUsd: number;
  locationCode?: number; // 2840 = United States
  languageCode?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export class DataForSeoError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message);
    this.name = "DataForSeoError";
  }
}

interface TaskEnvelope {
  status_code?: number;
  status_message?: string;
  cost?: number;
  tasks?: {
    status_code?: number;
    status_message?: string;
    result?: unknown[] | null;
  }[];
}

export class DataForSeoClient {
  private readonly auth: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  readonly locationCode: number;
  readonly languageCode: string;

  constructor(private readonly opts: DataForSeoOptions) {
    this.auth = "Basic " + Buffer.from(`${opts.login}:${opts.password}`).toString("base64");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = opts.baseUrl ?? BASE;
    this.locationCode = opts.locationCode ?? 2840;
    this.languageCode = opts.languageCode ?? "en";
  }

  /** One live-endpoint call. Returns [resultList, costUsd] after logging
   * the cost. Throws BudgetExceededError when the ledger has already
   * reached the ceiling — the check is BEFORE the call, so the ceiling is
   * never crossed by more than one request. */
  async post(path: string, payload: Record<string, unknown>, operation: string): Promise<[unknown[], number]> {
    const spent = await this.opts.ledger.total("dataforseo");
    if (spent >= this.opts.budgetUsd) throw new BudgetExceededError(spent, this.opts.budgetUsd);

    const res = await this.fetchImpl(this.baseUrl + path, {
      method: "POST",
      headers: { Authorization: this.auth, "Content-Type": "application/json" },
      body: JSON.stringify([payload]),
    });
    if (!res.ok) throw new DataForSeoError(`http ${res.status} on ${path}`);
    const body = (await res.json()) as TaskEnvelope;
    if (body.status_code !== 20000)
      throw new DataForSeoError(
        `DataForSEO error ${body.status_code}: ${body.status_message}`, body.status_code);
    const task = body.tasks?.[0];
    if (!task || task.status_code !== 20000)
      throw new DataForSeoError(
        `task error ${task?.status_code}: ${task?.status_message}`, task?.status_code);
    const cost = Number(body.cost ?? 0);
    await this.opts.ledger.log("dataforseo", operation, cost, { path });
    return [task.result ?? [], cost];
  }

  private langLoc(): Record<string, unknown> {
    return { location_code: this.locationCode, language_code: this.languageCode };
  }

  // ---------- write-side grounding (ported from discover.py) ----------

  /** Seed expansion via DataForSEO Labs related_keywords. */
  async relatedKeywords(seed: string, limit = 8): Promise<KeywordIdea[]> {
    const [result] = await this.post(
      "/dataforseo_labs/google/related_keywords/live",
      { keyword: seed, ...this.langLoc(), depth: 2, limit, include_seed_keyword: false },
      "related",
    );
    const ideas: KeywordIdea[] = [];
    for (const r of result as ItemsResult[]) {
      for (const item of r.items ?? []) {
        const kd = (item.keyword_data ?? {}) as Record<string, any>;
        const info = kd.keyword_info ?? {};
        ideas.push({
          keyword: String(kd.keyword ?? ""),
          volume: info.search_volume ?? null,
          competition: info.competition ?? null,
          cpc: info.cpc ?? null,
          intent: kd.search_intent_info?.main_intent ?? null,
        });
      }
    }
    return ideas;
  }

  /** Bulk keyword difficulty (near-free per keyword; max 1000 per call). */
  async bulkKeywordDifficulty(keywords: string[]): Promise<Map<string, number | null>> {
    const [result] = await this.post(
      "/dataforseo_labs/google/bulk_keyword_difficulty/live",
      { keywords: keywords.slice(0, 1000), ...this.langLoc() },
      "difficulty",
    );
    const out = new Map<string, number | null>();
    for (const r of result as ItemsResult[]) {
      for (const item of r.items ?? []) {
        out.set(String(item.keyword), (item.keyword_difficulty as number | undefined) ?? null);
      }
    }
    return out;
  }

  /** Top-10 organic + up to 8 People-Also-Ask questions. The PAA list is
   * the cheapest real FAQ research that exists. */
  async serp(keyword: string): Promise<{ organic: SerpOrganic[]; paa: string[] }> {
    const [result] = await this.post(
      "/serp/google/organic/live/advanced",
      { keyword, ...this.langLoc(), depth: 10 },
      "serp",
    );
    const organic: SerpOrganic[] = [];
    const paa: string[] = [];
    for (const r of result as ItemsResult[]) {
      for (const item of r.items ?? []) {
        if (item.type === "organic" && organic.length < 10) {
          organic.push({
            url: item.url as string | undefined,
            title: item.title as string | undefined,
            description: item.description as string | undefined,
          });
        }
        if (item.type === "people_also_ask") {
          for (const q of (item.items as Record<string, unknown>[] | undefined) ?? []) {
            if (q.title && paa.length < 8) paa.push(String(q.title));
          }
        }
      }
    }
    return { organic, paa };
  }

  // ---------- read side (the openseo surface) ----------

  /** Every keyword a domain ranks for (position, volume, url). */
  async rankedKeywords(domain: string, limit = 100): Promise<RankedKeyword[]> {
    const [result] = await this.post(
      "/dataforseo_labs/google/ranked_keywords/live",
      { target: domain, ...this.langLoc(), limit },
      "ranked_keywords",
    );
    const out: RankedKeyword[] = [];
    for (const r of result as ItemsResult[]) {
      for (const item of r.items ?? []) {
        const kd = (item.keyword_data ?? {}) as Record<string, any>;
        const el = (item.ranked_serp_element as Record<string, any>)?.serp_item ?? {};
        out.push({
          keyword: String(kd.keyword ?? ""),
          volume: kd.keyword_info?.search_volume ?? null,
          difficulty: kd.keyword_properties?.keyword_difficulty ?? null,
          intent: kd.search_intent_info?.main_intent ?? null,
          position: el.rank_absolute ?? null,
          url: el.url ?? null,
        });
      }
    }
    return out;
  }

  /** Domains competing on the same keywords as `domain`. */
  async competitors(domain: string, limit = 20): Promise<CompetitorDomain[]> {
    const [result] = await this.post(
      "/dataforseo_labs/google/competitors_domain/live",
      { target: domain, ...this.langLoc(), limit },
      "competitors",
    );
    const out: CompetitorDomain[] = [];
    for (const r of result as ItemsResult[]) {
      for (const item of r.items ?? []) {
        out.push({
          domain: String(item.domain ?? ""),
          intersections: (item.intersections as number | undefined) ?? null,
          avgPosition: (item.avg_position as number | undefined) ?? null,
          keywordCount: ((item.full_domain_metrics as Record<string, any>)?.organic?.count as number | undefined) ?? null,
        });
      }
    }
    return out;
  }

  /** Keyword gap: queries `competitor` ranks for that `domain` does not.
   * This is the Opportunity feed — the read side's direct line into the
   * writing backlog. */
  async keywordGap(domain: string, competitor: string, limit = 100): Promise<GapKeyword[]> {
    const [result] = await this.post(
      "/dataforseo_labs/google/domain_intersection/live",
      {
        target1: competitor, target2: domain, ...this.langLoc(), limit,
        intersections: false, // asymmetric: in target1, NOT in target2
      },
      "keyword_gap",
    );
    const out: GapKeyword[] = [];
    for (const r of result as ItemsResult[]) {
      for (const item of r.items ?? []) {
        const kd = (item.keyword_data ?? {}) as Record<string, any>;
        const first = (item.first_domain_serp_element as Record<string, any>) ?? {};
        out.push({
          keyword: String(kd.keyword ?? ""),
          volume: kd.keyword_info?.search_volume ?? null,
          difficulty: kd.keyword_properties?.keyword_difficulty ?? null,
          intent: kd.search_intent_info?.main_intent ?? null,
          competitorPosition: (first.rank_absolute as number | undefined) ?? null,
        });
      }
    }
    return out;
  }

  /** Backlink profile summary for a domain. */
  async backlinksSummary(domain: string): Promise<BacklinksSummary> {
    const [result] = await this.post(
      "/backlinks/summary/live",
      { target: domain, include_subdomains: true },
      "backlinks_summary",
    );
    const r = ((result as Record<string, any>[])[0] ?? {}) as Record<string, any>;
    return {
      backlinks: r.backlinks ?? null,
      referringDomains: r.referring_domains ?? null,
      referringDomainsNofollow: r.referring_domains_nofollow ?? null,
      rank: r.rank ?? null,
      brokenBacklinks: r.broken_backlinks ?? null,
      firstSeen: r.first_seen ?? null,
    };
  }

  /** Individual backlinks, newest first. */
  async backlinks(domain: string, limit = 100): Promise<BacklinkItem[]> {
    const [result] = await this.post(
      "/backlinks/backlinks/live",
      { target: domain, mode: "as_is", limit, order_by: ["first_seen,desc"] },
      "backlinks",
    );
    const out: BacklinkItem[] = [];
    for (const r of result as ItemsResult[]) {
      for (const item of r.items ?? []) {
        out.push({
          sourceUrl: (item.url_from as string | undefined) ?? null,
          targetUrl: (item.url_to as string | undefined) ?? null,
          anchor: (item.anchor as string | undefined) ?? null,
          dofollow: (item.dofollow as boolean | undefined) ?? null,
          firstSeen: (item.first_seen as string | undefined) ?? null,
          lost: (item.is_lost as boolean | undefined) ?? null,
          pageRank: ((item.rank as number | undefined) ?? null),
        });
      }
    }
    return out;
  }
}

interface ItemsResult {
  items?: Record<string, unknown>[] | null;
  [k: string]: unknown;
}

export interface KeywordIdea {
  keyword: string;
  volume: number | null;
  competition: number | null;
  cpc: number | null;
  intent: string | null;
}

export interface SerpOrganic {
  url?: string;
  title?: string;
  description?: string;
}

export interface RankedKeyword {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  intent: string | null;
  position: number | null;
  url: string | null;
}

export interface CompetitorDomain {
  domain: string;
  intersections: number | null;
  avgPosition: number | null;
  keywordCount: number | null;
}

export interface GapKeyword {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  intent: string | null;
  competitorPosition: number | null;
}

export interface BacklinksSummary {
  backlinks: number | null;
  referringDomains: number | null;
  referringDomainsNofollow: number | null;
  rank: number | null;
  brokenBacklinks: number | null;
  firstSeen: string | null;
}

export interface BacklinkItem {
  sourceUrl: string | null;
  targetUrl: string | null;
  anchor: string | null;
  dofollow: boolean | null;
  firstSeen: string | null;
  lost: boolean | null;
  pageRank: number | null;
}

/** Cost projection for a discover-style run (ported from discover.py):
 * deliberately simple — seeds x related + one volume batch + one
 * difficulty batch + serpTopN SERP pulls. */
export function projectDiscoverCost(seedCount: number, serpTopN: number): number {
  return seedCount * COST.related + COST.volume + COST.difficulty + serpTopN * COST.serp;
}
