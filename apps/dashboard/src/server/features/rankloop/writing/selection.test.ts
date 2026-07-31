import { describe, expect, it } from "vitest";
import {
  buildNetNewProposal,
  computeNetNewSlots,
  dueProjectsForNetNew,
  NEEDS_DATA_SOURCE_REASON,
  partitionCandidates,
  renderTitle,
  selectNetNew,
  type NetNewCandidate,
  type QuotaSettings,
} from "./selection";

function candidate(overrides: Partial<NetNewCandidate> = {}): NetNewCandidate {
  return {
    backlogId: `kw_${overrides.keyword ?? "a"}`,
    keyword: "espresso grinder burr size",
    source: "expansion",
    score: 1,
    searchVolume: 320,
    keywordDifficulty: 24,
    impressions28: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    pageTypeId: "type_specs",
    pageTypeName: "Specs and data",
    pageTypeKind: "blog",
    dataSourceMode: null,
    ...overrides,
  };
}

function quota(overrides: Partial<Parameters<typeof computeNetNewSlots>[0]>) {
  return computeNetNewSlots({
    settings: { postsPerDay: 2, catchupCap: 6, quotaStartDate: "2026-08-01" },
    publishedDates: [],
    outstanding: 0,
    today: "2026-08-01",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// The quota
// ---------------------------------------------------------------------------

describe("computeNetNewSlots", () => {
  it("hands out nothing when no start date is set, and says the quota is off", () => {
    const result = quota({
      settings: { postsPerDay: 2, catchupCap: 6, quotaStartDate: null },
    });

    expect(result).toEqual({
      owed: null,
      outstanding: 0,
      slots: 0,
      reason: "quota off — propose manually",
      throttle: null,
    });
  });

  it("owes a missed day rather than skipping it", () => {
    // Started on the 1st at 2/day, nothing published, now the 3rd: three days
    // inclusive is six posts owed, not the two today would owe on its own.
    const result = quota({ today: "2026-08-03" });

    expect(result.owed).toBe(6);
    expect(result.slots).toBe(6);
  });

  it("caps the debt at catchupCap however long the site was left alone", () => {
    const result = quota({ today: "2026-09-01" });

    expect(result.owed).toBe(6);
  });

  it("counts the site's own published posts against the debt", () => {
    const result = quota({
      today: "2026-08-03",
      publishedDates: ["2026-08-01", "2026-08-02", "2026-08-02"],
    });

    expect(result.owed).toBe(3);
  });

  it("ignores posts published before the quota started", () => {
    const result = quota({
      today: "2026-08-01",
      publishedDates: ["2026-07-30", "2026-07-31"],
    });

    expect(result.owed).toBe(2);
  });

  it("subtracts proposals already in flight, so a second run in one day is a no-op", () => {
    const result = quota({ outstanding: 2 });

    expect(result).toEqual({
      owed: 2,
      outstanding: 2,
      slots: 0,
      reason: "today's quota is already in the queue",
      throttle: null,
    });
  });

  it("distinguishes a met quota from a full queue", () => {
    const result = quota({
      publishedDates: ["2026-08-01", "2026-08-01"],
    });

    expect(result.slots).toBe(0);
    expect(result.reason).toBe("nothing owed today — the quota is met");
  });

  it("honors a caller's limit below what the quota owes", () => {
    expect(quota({ today: "2026-08-03", limit: 2 }).slots).toBe(2);
    // The limit is a ceiling, never a floor — asking for ten when one is owed
    // still proposes one.
    expect(quota({ limit: 10 }).slots).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

describe("partitionCandidates", () => {
  it("holds back a pSEO type with no data source, and says why", () => {
    const { eligible, exclusions } = partitionCandidates([
      candidate({ keyword: "delonghi ec155 dimensions", pageTypeKind: "pseo" }),
      candidate({ keyword: "gaggia classic dimensions", pageTypeKind: "pseo" }),
    ]);

    expect(eligible).toEqual([]);
    expect(exclusions).toEqual([
      {
        pageTypeId: "type_specs",
        pageTypeName: "Specs and data",
        keywordCount: 2,
        reason: NEEDS_DATA_SOURCE_REASON,
      },
    ]);
  });

  it("admits a pSEO type once it has a data source", () => {
    const { eligible, exclusions } = partitionCandidates([
      candidate({ pageTypeKind: "pseo", dataSourceMode: "dataset" }),
    ]);

    expect(eligible).toHaveLength(1);
    expect(exclusions).toEqual([]);
  });

  it("never asks a blog type for a dataset — its grounding is the SERP", () => {
    const { eligible, exclusions } = partitionCandidates([
      candidate({ pageTypeKind: "blog", dataSourceMode: null }),
    ]);

    expect(eligible).toHaveLength(1);
    expect(exclusions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The pick
// ---------------------------------------------------------------------------

const noSuppression = { recentDecisions: [], now: "2026-08-01T12:00:00.000Z" };

describe("selectNetNew", () => {
  const scored = [
    candidate({ keyword: "top pick", score: 9 }),
    candidate({ keyword: "second pick", score: 8 }),
    candidate({ keyword: "third pick", score: 7 }),
  ];

  it("gives exactly one slot to the fresh-question pool, replacing the weakest bet", () => {
    const picks = selectNetNew({
      candidates: [
        ...scored,
        candidate({
          keyword: "why does my grinder clog",
          source: "harvest",
          score: 0.2,
          createdAt: "2026-07-28T00:00:00.000Z",
        }),
      ],
      n: 3,
      suppression: noSuppression,
    });

    expect(picks.map((p) => p.keyword)).toEqual([
      "top pick",
      "second pick",
      "why does my grinder clog",
    ]);
    expect(picks.map((p) => p.slot)).toEqual(["score", "score", "pool"]);
  });

  it("fills every slot from the score ranking when the pool is empty", () => {
    const picks = selectNetNew({
      candidates: scored,
      n: 3,
      suppression: noSuppression,
    });

    expect(picks.map((p) => p.keyword)).toEqual([
      "top pick",
      "second pick",
      "third pick",
    ]);
    expect(picks.every((p) => p.slot === "score")).toBe(true);
  });

  it("takes the newest harvested question for the pool slot", () => {
    const picks = selectNetNew({
      candidates: [
        ...scored,
        candidate({
          keyword: "old question",
          source: "harvest",
          score: 0.4,
          createdAt: "2026-03-02T00:00:00.000Z",
        }),
        candidate({
          keyword: "new question",
          source: "harvest",
          score: 0.1,
          createdAt: "2026-07-29T00:00:00.000Z",
        }),
      ],
      n: 3,
      suppression: noSuppression,
    });

    expect(picks[2].keyword).toBe("new question");
  });

  it("never spends the single-slot batch on the pool", () => {
    const picks = selectNetNew({
      candidates: [
        candidate({ keyword: "top pick", score: 9 }),
        candidate({ keyword: "a question", source: "harvest", score: 0.1 }),
      ],
      n: 1,
      suppression: noSuppression,
    });

    expect(picks.map((p) => p.keyword)).toEqual(["top pick"]);
  });

  it("drops keywords inside their decision-suppression window, pool included", () => {
    const picks = selectNetNew({
      candidates: [
        candidate({ keyword: "top pick", score: 9 }),
        candidate({ keyword: "second pick", score: 8 }),
        candidate({ keyword: "a question", source: "harvest", score: 0.1 }),
      ],
      n: 3,
      suppression: {
        now: "2026-08-01T12:00:00.000Z",
        recentDecisions: [
          {
            type: "write_new",
            target: "top pick",
            decidedAt: "2026-07-20T00:00:00.000Z",
            executedAt: null,
          },
          {
            type: "write_new",
            target: "a question",
            decidedAt: "2026-07-20T00:00:00.000Z",
            executedAt: null,
          },
        ],
      },
    });

    expect(picks.map((p) => p.keyword)).toEqual(["second pick"]);
  });

  it("leaves a decision on another proposal type alone", () => {
    const picks = selectNetNew({
      candidates: [candidate({ keyword: "top pick", score: 9 })],
      n: 1,
      suppression: {
        now: "2026-08-01T12:00:00.000Z",
        recentDecisions: [
          {
            type: "retitle",
            target: "top pick",
            decidedAt: "2026-07-20T00:00:00.000Z",
            executedAt: null,
          },
        ],
      },
    });

    expect(picks).toHaveLength(1);
  });

  it("returns the same batch twice over an unchanged backlog", () => {
    const rows = [
      candidate({ keyword: "beta", score: 5 }),
      candidate({ keyword: "alpha", score: 5 }),
    ];
    const first = selectNetNew({
      candidates: rows,
      n: 1,
      suppression: noSuppression,
    });
    const second = selectNetNew({
      candidates: rows.toReversed(),
      n: 1,
      suppression: noSuppression,
    });

    expect(first.map((p) => p.keyword)).toEqual(second.map((p) => p.keyword));
    expect(first[0].keyword).toBe("alpha");
  });
});

// ---------------------------------------------------------------------------
// What a pick says about itself
// ---------------------------------------------------------------------------

describe("renderTitle", () => {
  it("capitalizes the keyword and leaves the rest of it alone", () => {
    expect(renderTitle("how to descale a delonghi")).toBe(
      "How to descale a delonghi",
    );
  });

  it("fills the placeholder when a type carries its own pattern", () => {
    expect(renderTitle("burr size", "{keyword}: what the data says")).toBe(
      "Burr size: what the data says",
    );
  });
});

describe("buildNetNewProposal", () => {
  it("carries the pool-slot marker in the factors, not only in a chip", () => {
    const draft = buildNetNewProposal({
      ...candidate({ keyword: "why does my grinder clog", source: "harvest" }),
      slot: "pool",
    });

    expect(draft.factors).toContainEqual(
      expect.objectContaining({ name: "Slot", value: "fresh question" }),
    );
    expect(draft.evidence).toContain("fresh question");
  });

  it("marks a scored pick as scored", () => {
    const draft = buildNetNewProposal({ ...candidate(), slot: "score" });

    expect(draft.factors).toContainEqual(
      expect.objectContaining({ name: "Slot", value: "scored" }),
    );
    expect(draft.evidence).not.toContain("fresh question");
  });

  it("targets the keyword and names the page type in the evidence", () => {
    const draft = buildNetNewProposal({
      ...candidate({ keyword: "burr size" }),
      slot: "score",
    });

    expect(draft.target).toBe("burr size");
    expect(draft.title).toBe("Burr size");
    expect(draft.evidence[0]).toBe("Specs and data");
    expect(draft.evidence).toContain("paid expansion");
  });

  it("says a free-source row is not priced instead of showing it as zero", () => {
    const draft = buildNetNewProposal({
      ...candidate({ searchVolume: null, keywordDifficulty: null }),
      slot: "score",
    });

    expect(draft.factors).toContainEqual(
      expect.objectContaining({ name: "Volume", value: "not priced" }),
    );
    expect(draft.factors).toContainEqual(
      expect.objectContaining({ name: "Difficulty", value: "unmeasured" }),
    );
  });

  it("imputes volume from Search Console impressions when no vendor priced it", () => {
    const draft = buildNetNewProposal({
      ...candidate({ searchVolume: null, impressions28: 1420 }),
      slot: "score",
    });

    expect(draft.factors).toContainEqual(
      expect.objectContaining({ name: "Volume", value: "1,420" }),
    );
    expect(draft.evidence).toContain("1,420 impressions over 28 days");
  });
});

// ---------------------------------------------------------------------------
// The daily block's due set
// ---------------------------------------------------------------------------

function on(projectId: string): QuotaSettings & { projectId: string } {
  return {
    projectId,
    postsPerDay: 2,
    catchupCap: 6,
    quotaStartDate: "2026-08-01",
  };
}

function stat(projectId: string, outstanding: number, last: string | null) {
  return { projectId, outstanding, lastProposedAt: last };
}

function due(
  settings: ReturnType<typeof on>[],
  stats: ReturnType<typeof stat>[],
  limit = 10,
) {
  return dueProjectsForNetNew({
    settings,
    stats,
    cutoff: "2026-08-01T00:00:00.000Z",
    limit,
  });
}

describe("dueProjectsForNetNew", () => {
  it("skips a project whose quota is off", () => {
    expect(
      due([on("p_on"), { ...on("p_off"), quotaStartDate: null }], []),
    ).toEqual(["p_on"]);
  });

  it("skips a project already holding its whole catch-up cap", () => {
    expect(due([on("p_on")], [stat("p_on", 6, null)])).toEqual([]);
  });

  it("skips a project that already had its turn inside the window", () => {
    expect(
      due([on("p_on")], [stat("p_on", 1, "2026-08-01T06:00:00.000Z")]),
    ).toEqual([]);
  });

  it("serves the longest-waiting projects first, and never more than the cap", () => {
    const served = due(
      [on("p_a"), on("p_b"), on("p_c")],
      [
        stat("p_a", 0, "2026-07-30T00:00:00.000Z"),
        stat("p_b", 0, "2026-07-20T00:00:00.000Z"),
      ],
      2,
    );

    // p_c has never been proposed for at all, so it waits longest of the three.
    expect(served).toEqual(["p_c", "p_b"]);
  });
});
