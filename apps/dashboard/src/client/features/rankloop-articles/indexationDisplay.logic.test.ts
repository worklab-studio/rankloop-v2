import { describe, expect, it } from "vitest";
import {
  indexationRateLabel,
  indexationStamp,
  indexationThrottleChip,
  indexationUnknownCopy,
  indexationVerdictLine,
  isIndexationFailure,
} from "@/client/features/rankloop-articles/indexationDisplay.logic";

describe("indexationRateLabel", () => {
  it("rounds to a whole percent, because a tenth of a post is not a thing", () => {
    expect(indexationRateLabel(0.5238)).toBe("52%");
    expect(indexationRateLabel(1)).toBe("100%");
  });

  it("renders the em dash for a null rate rather than an encouraging 100%", () => {
    expect(indexationRateLabel(null)).toBe("—");
  });
});

describe("indexationStamp", () => {
  it("names the cohort and the window the rate is about", () => {
    expect(
      indexationStamp({
        rate: 0.82,
        indexed: 28,
        cohort: 34,
        minimumCohort: 5,
      }),
    ).toBe(
      "28 of 34 posts published 7–45 days ago are indexed · checked daily",
    );
  });

  it("says post, not posts, for a cohort of one", () => {
    expect(
      indexationStamp({ rate: null, indexed: 1, cohort: 1, minimumCohort: 5 }),
    ).toBe("1 of 1 post published 7–45 days ago are indexed · checked daily");
  });
});

describe("indexationUnknownCopy", () => {
  it("says how many posts it needs, so the wait has an end", () => {
    expect(indexationUnknownCopy({ connected: true, minimumCohort: 5 })).toBe(
      "not enough published posts yet to judge — needs 5",
    );
  });

  it("blames the missing connection rather than implying the site has a problem", () => {
    expect(indexationUnknownCopy({ connected: false, minimumCohort: 5 })).toBe(
      "Search Console isn't connected, so nothing has been checked yet.",
    );
  });
});

describe("indexationThrottleChip", () => {
  it("is absent while indexation is healthy", () => {
    expect(indexationThrottleChip(null)).toBeNull();
  });

  it("holds the quota in amber, naming the cap the run obeyed", () => {
    expect(
      indexationThrottleChip({
        cap: 1,
        reason: "quota held at 1 — 52% of recent posts are indexed",
      }),
    ).toEqual({ label: "quota held at 1", color: "amber" });
  });

  it("turns rose at a full stop, because a pause is not a smaller quota", () => {
    expect(
      indexationThrottleChip({
        cap: 0,
        reason: "net-new paused — 30% of recent posts are indexed",
      }),
    ).toEqual({ label: "net-new paused", color: "rose" });
  });
});

describe("indexationVerdictLine", () => {
  const now = Date.parse("2026-08-01T12:00:00Z");

  it("says indexed on a passing verdict", () => {
    expect(
      indexationVerdictLine(
        {
          verdict: "PASS",
          coverageState: "Submitted and indexed",
          checkedAt: "2026-07-30T09:00:00Z",
        },
        now,
      ),
    ).toBe("indexed · checked 2 days ago");
  });

  it("says crawled, not indexed — the state the whole throttle exists for", () => {
    expect(
      indexationVerdictLine(
        {
          verdict: "FAIL",
          coverageState: "Crawled - currently not indexed",
          checkedAt: "2026-07-31T09:00:00Z",
        },
        now,
      ),
    ).toBe("crawled, not indexed · checked yesterday");
  });

  it("keeps Google's own wording for a state it has no phrase for", () => {
    expect(
      indexationVerdictLine(
        {
          verdict: "NEUTRAL",
          coverageState: "Soft 404",
          checkedAt: "2026-08-01T09:00:00Z",
        },
        now,
      ),
    ).toBe("Soft 404 · checked today");
  });

  it("reads the SQLite timestamp shape as UTC, not as the viewer's local time", () => {
    expect(
      indexationVerdictLine(
        {
          verdict: "FAIL",
          coverageState: null,
          checkedAt: "2026-07-30 09:00:00",
        },
        now,
      ),
    ).toBe("not indexed · checked 2 days ago");
  });
});

describe("isIndexationFailure", () => {
  it("is true for everything Google did not pass", () => {
    const checkedAt = "2026-08-01T09:00:00Z";
    expect(
      isIndexationFailure({ verdict: "PASS", coverageState: null, checkedAt }),
    ).toBe(false);
    expect(
      isIndexationFailure({
        verdict: "PARTIAL",
        coverageState: null,
        checkedAt,
      }),
    ).toBe(true);
  });
});
