// Mining is the one part of the armory that spends money, so the quote has
// to be right before anyone commits to it, and the filters have to keep the
// results worth what was paid.

import { describe, expect, it } from "vitest";
import {
  classifyTarget,
  isNonTarget,
  looksSubmittable,
  miningQueries,
} from "./armory.logic";
import { PLAN_SERP_CALL_COST_USD } from "@/shared/rankloop-page-plan";

/** Mirrors ArmoryMiningService.quoteMining without importing the service,
 *  which pulls in cloudflare:workers and a DataForSEO client. */
function quote(categories: readonly string[], year: number) {
  const queries = categories.flatMap((c) => miningQueries(c, year)).length;
  return {
    queries,
    costUsd: Math.round(queries * PLAN_SERP_CALL_COST_USD * 1000) / 1000,
  };
}

describe("the mining quote", () => {
  it("prices from the same constant the plan uses", () => {
    // Two screens quoting different prices for a SERP is how a user stops
    // believing either number.
    const { queries, costUsd } = quote(["CRM"], 2026);
    expect(queries).toBe(6);
    expect(costUsd).toBeCloseTo(6 * PLAN_SERP_CALL_COST_USD, 5);
  });

  it("scales with categories", () => {
    expect(quote(["CRM", "helpdesk"], 2026).queries).toBe(12);
  });

  it("quotes nothing when there is nothing to search for", () => {
    // No approved page types means rankloop does not know what this site is
    // about. Charging for six searches against a blank noun would be a bill
    // for guesses.
    expect(quote([], 2026)).toEqual({ queries: 0, costUsd: 0 });
    expect(quote(["   "], 2026)).toEqual({ queries: 0, costUsd: 0 });
  });
});

describe("what mining keeps from a SERP", () => {
  it("keeps roundups, which are the whole point", () => {
    for (const url of [
      "https://x.example/best-crm-tools",
      "https://x.example/blog/best-crm-software-2026",
      "https://x.example/salesforce-alternatives",
    ]) {
      expect(classifyTarget(url), url).toBe("listicle");
    }
  });

  it("keeps a directory that takes submissions", () => {
    expect(looksSubmittable("https://x.example/submit")).toBe(true);
    expect(classifyTarget("https://x.example/directory/crm")).toBe("directory");
  });

  it("drops pages nobody can be added to", () => {
    // A competitor's pricing page ranking for "best CRM tools" is a
    // competitor, not a link opportunity. Those belong to the plan.
    expect(isNonTarget("https://competitor.example/pricing")).toBe(true);
    expect(isNonTarget("https://competitor.example/login")).toBe(true);
  });

  it("treats a plain product page as neither roundup nor submittable", () => {
    const url = "https://competitor.example/features";
    expect(classifyTarget(url)).toBe("resource_page");
    expect(looksSubmittable(url)).toBe(false);
  });
});

describe("the queries themselves", () => {
  it("asks for the lists incumbents are on, not the incumbents", () => {
    const queries = miningQueries("CRM", 2026);
    // A bare "crm" search returns Salesforce. These return the pages
    // Salesforce is listed on, which is where a new product gets added.
    expect(queries).not.toContain("crm");
    expect(queries).toContain("best crm tools");
    expect(queries).toContain("crm alternatives");
    expect(queries).toContain("submit crm");
  });

  it("takes the year from the caller", () => {
    // Read from a clock inside the query builder, this becomes untestable
    // and silently wrong every January.
    expect(miningQueries("crm", 2027)).toContain("crm tools 2027");
  });
});
