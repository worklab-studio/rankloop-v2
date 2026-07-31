import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageQueryAggregate } from "@/server/features/rankloop/proposals/signals.logic";

const mocks = vi.hoisted(() => ({
  repo: {
    getContentPageKeywords: vi.fn(),
    getBacklogKeywordNotes: vi.fn(),
  },
  read28DayWindow: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock(
  "@/server/features/rankloop/universe/repositories/UniverseRepository",
  () => ({ UniverseRepository: mocks.repo }),
);
vi.mock("@/server/features/rankloop/universe/services/gscWindow", () => ({
  read28DayWindow: mocks.read28DayWindow,
}));

const { collectUnservedCandidates } = await import("./unservedQueries");

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function agg(
  query: string,
  impressions: number,
  weightedPosition: number,
): PageQueryAggregate {
  return {
    pageUrl: "https://acme.com/a/",
    query,
    clicks: 0,
    impressions,
    weightedPosition,
  };
}

beforeEach(() => {
  mocks.repo.getContentPageKeywords.mockResolvedValue([]);
  mocks.repo.getBacklogKeywordNotes.mockResolvedValue([]);
  mocks.read28DayWindow.mockResolvedValue([]);
});

describe("collectUnservedCandidates", () => {
  it("hands the admission path GSC candidates carrying their own evidence", async () => {
    mocks.read28DayWindow.mockResolvedValue([
      agg("how to descale a breville", 12, 30.44),
      agg("descale breville how", 5, 41),
    ]);

    const [candidate] = await collectUnservedCandidates(PROJECT_ID);

    expect(candidate).toEqual({
      keyword: "how to descale a breville",
      source: "gsc",
      impressions28: 17,
      clusterKey: "breville descale",
      notes: {
        variants: ["descale breville how"],
        // Rounded to a tenth: a weighted position carried to twelve decimals
        // claims a precision Search Console never had.
        bestPosition: 30.4,
      },
    });
  });

  it("returns nothing for a project whose memory has not been synced", async () => {
    // Not an error — a project can reach this step before its backfill runs,
    // and the run reports zero seen rather than a failure.
    expect(await collectUnservedCandidates(PROJECT_ID)).toEqual([]);
  });
});
