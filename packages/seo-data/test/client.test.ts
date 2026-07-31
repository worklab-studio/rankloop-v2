/** Client tests against shape-accurate canned responses (the response
 * structure is the one the production Python parser consumed for months —
 * dual status envelopes, keyword_data nesting, PAA sub-items). No live
 * calls: the fetch implementation is injected. */

import { describe, expect, it } from "vitest";
import {
  BudgetExceededError, COST, DataForSeoClient, DataForSeoError, MemoryLedger,
  projectDiscoverCost,
} from "../src/index.ts";

type Json = Record<string, unknown>;

function envelope(result: unknown[], cost = 0.011): Json {
  return {
    status_code: 20000,
    status_message: "Ok.",
    cost,
    tasks: [{ status_code: 20000, status_message: "Ok.", result }],
  };
}

function fakeFetch(responses: Json[]) {
  const calls: { url: string; body: Json }[] = [];
  const impl = (async (url: unknown, init?: { body?: unknown }) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body))[0] });
    const next = responses.shift() ?? envelope([]);
    return {
      ok: true,
      status: 200,
      json: async () => next,
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function client(fetchImpl: typeof fetch, ledger = new MemoryLedger(), budgetUsd = 25) {
  return new DataForSeoClient({
    login: "user", password: "pass", ledger, budgetUsd, fetchImpl,
  });
}

describe("DataForSeoClient", () => {
  it("parses related keywords from the labs envelope", async () => {
    const { impl, calls } = fakeFetch([
      envelope([
        {
          items: [
            {
              keyword_data: {
                keyword: "single dose grinder",
                keyword_info: { search_volume: 880, competition: 0.31, cpc: 1.2 },
                search_intent_info: { main_intent: "commercial" },
              },
            },
            { keyword_data: { keyword: "grinder burr alignment", keyword_info: {} } },
          ],
        },
      ]),
    ]);
    const ideas = await client(impl).relatedKeywords("espresso grinder");
    expect(ideas).toEqual([
      { keyword: "single dose grinder", volume: 880, competition: 0.31, cpc: 1.2, intent: "commercial" },
      { keyword: "grinder burr alignment", volume: null, competition: null, cpc: null, intent: null },
    ]);
    expect(calls[0]!.url).toContain("/dataforseo_labs/google/related_keywords/live");
    expect(calls[0]!.body).toMatchObject({ keyword: "espresso grinder", location_code: 2840 });
  });

  it("parses SERP organic + nested People-Also-Ask, capped at 10/8", async () => {
    const organicItems = Array.from({ length: 14 }, (_, i) => ({
      type: "organic", url: `https://r.example/${i}`, title: `Result ${i}`, description: "d",
    }));
    const paaItems = Array.from({ length: 12 }, (_, i) => ({ title: `question ${i}` }));
    const { impl } = fakeFetch([
      envelope([{ items: [...organicItems, { type: "people_also_ask", items: paaItems }] }], 0.002),
    ]);
    const { organic, paa } = await client(impl).serp("best espresso grinder");
    expect(organic).toHaveLength(10);
    expect(paa).toHaveLength(8);
    expect(organic[0]).toEqual({ url: "https://r.example/0", title: "Result 0", description: "d" });
    expect(paa[0]).toBe("question 0");
  });

  it("logs the response body's REAL cost to the ledger", async () => {
    const ledger = new MemoryLedger();
    const { impl } = fakeFetch([envelope([], 0.0123)]);
    await client(impl, ledger).relatedKeywords("espresso");
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({
      provider: "dataforseo", operation: "related", costUsd: 0.0123,
    });
  });

  it("refuses to call once the cumulative ledger reaches the ceiling", async () => {
    const ledger = new MemoryLedger();
    await ledger.log("dataforseo", "previous-run", 25.0); // the ceiling caps EVER-spent
    const { impl, calls } = fakeFetch([envelope([])]);
    await expect(client(impl, ledger, 25).serp("kw")).rejects.toThrow(BudgetExceededError);
    expect(calls).toHaveLength(0); // checked BEFORE the request fires
  });

  it("rejects a task-level error dressed as a 200", async () => {
    const { impl } = fakeFetch([
      {
        status_code: 20000,
        cost: 0,
        tasks: [{ status_code: 40501, status_message: "Invalid Field." }],
      },
    ]);
    await expect(client(impl).relatedKeywords("espresso")).rejects.toThrow(DataForSeoError);
  });

  it("rejects a body-level error", async () => {
    const { impl } = fakeFetch([{ status_code: 40100, status_message: "Auth failed." }]);
    await expect(client(impl).serp("kw")).rejects.toThrow(/40100/);
  });

  it("maps the keyword gap (asymmetric domain intersection)", async () => {
    const { impl, calls } = fakeFetch([
      envelope([
        {
          items: [
            {
              keyword_data: {
                keyword: "espresso tamper size",
                keyword_info: { search_volume: 320 },
                keyword_properties: { keyword_difficulty: 12 },
                search_intent_info: { main_intent: "informational" },
              },
              first_domain_serp_element: { rank_absolute: 4 },
            },
          ],
        },
      ]),
    ]);
    const gap = await client(impl).keywordGap("mysite.example", "rival.example");
    expect(gap).toEqual([
      {
        keyword: "espresso tamper size", volume: 320, difficulty: 12,
        intent: "informational", competitorPosition: 4,
      },
    ]);
    expect(calls[0]!.body).toMatchObject({
      target1: "rival.example", target2: "mysite.example", intersections: false,
    });
  });

  it("maps backlinks summary fields", async () => {
    const { impl } = fakeFetch([
      envelope([
        {
          backlinks: 1520, referring_domains: 240, referring_domains_nofollow: 40,
          rank: 312, broken_backlinks: 12, first_seen: "2024-01-05 00:00:00 +00:00",
        },
      ], 0.02),
    ]);
    const s = await client(impl).backlinksSummary("demo.example");
    expect(s).toEqual({
      backlinks: 1520, referringDomains: 240, referringDomainsNofollow: 40,
      rank: 312, brokenBacklinks: 12, firstSeen: "2024-01-05 00:00:00 +00:00",
    });
  });
});

describe("projectDiscoverCost()", () => {
  it("matches the Python projection formula", () => {
    // 80 seeds, serp_top_n 80: 80*0.011 + 0.05 + 0.001 + 80*0.002 = 1.091
    expect(projectDiscoverCost(80, 80)).toBeCloseTo(
      80 * COST.related + COST.volume + COST.difficulty + 80 * COST.serp, 10);
  });
});
