import { describe, expect, it } from "vitest";
import {
  evidenceLine,
  linkGapStamp,
  matchReasonLine,
  OUTREACH_STALE_LABEL,
  OUTREACH_STATUS_OPTIONS,
  shortUrl,
  staleChipTitle,
} from "./outreachDisplay.logic";

describe("shortUrl", () => {
  it("drops the protocol and the www prefix", () => {
    expect(shortUrl("https://www.rival.example/guides/x")).toBe(
      "rival.example/guides/x",
    );
  });

  it("renders a bare host without a trailing slash", () => {
    expect(shortUrl("https://rival.example/")).toBe("rival.example");
  });

  it("returns an unparseable value whole rather than dropping it", () => {
    expect(shortUrl("rival.example/guides/x")).toBe("rival.example/guides/x");
  });
});

describe("evidenceLine", () => {
  // What every S4b row looks like: referring domains are counted per linking
  // domain, so there is no page to name.
  it("names the competitor and the link count when only domain-level evidence exists", () => {
    expect(
      evidenceLine({
        competitorId: "c1",
        competitorDomain: "rival.example",
        backlinks: 3,
        targetUrl: null,
        anchor: null,
      }),
    ).toBe("links to rival.example · 3 links");
  });

  it("names the page once a per-link source fills targetUrl", () => {
    expect(
      evidenceLine({
        competitorId: "c1",
        competitorDomain: "rival.example",
        backlinks: null,
        targetUrl: "https://rival.example/guides/x",
        anchor: null,
      }),
    ).toBe("links to rival.example/guides/x");
  });

  it("pluralizes a single link and tails the anchor when there is one", () => {
    expect(
      evidenceLine({
        competitorId: "c1",
        competitorDomain: "rival.example",
        backlinks: 1,
        targetUrl: null,
        anchor: "widget benchmarks",
      }),
    ).toBe("links to rival.example · 1 link · “widget benchmarks”");
  });
});

describe("matchReasonLine", () => {
  it("names the overlapping tokens so the match can be argued with", () => {
    expect(
      matchReasonLine({
        reason: "linked_url_tokens",
        shape: "data",
        tokens: ["widget", "benchmark"],
      }),
    ).toBe("Matched on the competitor pages it links to: widget, benchmark.");
  });

  it("still names the source when no tokens were recorded", () => {
    expect(
      matchReasonLine({ reason: "domain_tokens", shape: "guide", tokens: [] }),
    ).toBe("Matched on the linking domain's own name.");
  });

  it("returns null for a target with no matched asset", () => {
    expect(matchReasonLine(null)).toBeNull();
  });
});

describe("linkGapStamp", () => {
  it("pluralizes the tracked competitor count", () => {
    expect(linkGapStamp(1)).toBe(
      "link gap from 1 tracked competitor · refreshed with each monthly study",
    );
    expect(linkGapStamp(4)).toBe(
      "link gap from 4 tracked competitors · refreshed with each monthly study",
    );
  });
});

describe("staleChipTitle", () => {
  it("reads the stamp as a UTC day, not the viewer's", () => {
    // 01:00 UTC on the 5th is still the 4th in New York; the day the domain
    // left the gap is a property of the recompute, not of who is looking.
    expect(staleChipTitle("2026-03-05T01:00:00.000Z")).toBe(
      "Left the gap on Mar 5, 2026. These numbers are from the last refresh that still saw this domain.",
    );
  });

  it("still explains the chip when the stamp is unreadable", () => {
    expect(staleChipTitle("not a date")).toBe(
      "These numbers are from the last refresh that still saw this domain.",
    );
  });

  it("says what happened rather than what to do", () => {
    expect(OUTREACH_STALE_LABEL).toBe("no longer in the gap");
  });
});

describe("OUTREACH_STATUS_OPTIONS", () => {
  it("covers the five stored statuses in the order the work happens", () => {
    expect(OUTREACH_STATUS_OPTIONS.map((option) => option.value)).toEqual([
      "to_contact",
      "sent",
      "replied",
      "linked",
      "declined",
    ]);
  });
});
