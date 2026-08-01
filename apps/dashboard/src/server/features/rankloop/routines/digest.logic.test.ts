import { describe, expect, it } from "vitest";
import {
  assembleDigest,
  measurementVerdict,
  positionDelta,
  type AwaitingProposal,
  type BlockedInput,
  type DigestInput,
  type MeasuredReceipt,
} from "./digest.logic";

const FOR_DATE = "2026-08-01";

const NOTHING_BLOCKED: BlockedInput = {
  throttle: null,
  gateFailures: [],
  adapterErrors: [],
  autopilotPause: null,
  spend: null,
};

function digest(input: Partial<DigestInput> = {}) {
  return assembleDigest({
    forDate: FOR_DATE,
    awaiting: [],
    shipped: [],
    measured: [],
    blocked: NOTHING_BLOCKED,
    ...input,
  });
}

function proposal(
  id: string,
  score: number,
  createdAt = "2026-07-30T09:00:00.000Z",
): AwaitingProposal {
  return {
    id,
    type: "retitle",
    target: `/${id}/`,
    title: `Title for ${id}`,
    score,
    createdAt,
    evidence: [`${id} ranks 11th for its own headline query`],
  };
}

function measured(overrides: Partial<MeasuredReceipt> = {}): MeasuredReceipt {
  return {
    receiptId: "r1",
    actionType: "retitle",
    target: "/pricing/",
    baselineClicks: 100,
    adjustedClicksDelta: 40,
    baselinePosition: 8.4,
    resultPosition: 5.1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Silence
// ---------------------------------------------------------------------------

describe("assembleDigest — the quiet day", () => {
  it("returns null when every section is empty, so nothing is stored or sent", () => {
    expect(digest()).toBeNull();
  });

  it("stays silent about spend that is nowhere near its ceiling", () => {
    expect(
      digest({
        blocked: {
          ...NOTHING_BLOCKED,
          spend: { label: "LLM spend", usedUsd: 4, ceilingUsd: 20 },
        },
      }),
    ).toBeNull();
  });

  it("speaks up once spend crosses four fifths of the ceiling", () => {
    const payload = digest({
      blocked: {
        ...NOTHING_BLOCKED,
        spend: { label: "LLM spend", usedUsd: 16, ceilingUsd: 20 },
      },
    });

    expect(payload?.blocked).toEqual([
      { kind: "spend", detail: "LLM spend: $16.00 of $20.00 spent" },
    ]);
  });

  it("does not divide by a ceiling of zero", () => {
    expect(
      digest({
        blocked: {
          ...NOTHING_BLOCKED,
          spend: { label: "LLM spend", usedUsd: 0, ceilingUsd: 0 },
        },
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Proposals awaiting a decision
// ---------------------------------------------------------------------------

describe("assembleDigest — awaiting a decision", () => {
  it("lists the five highest-scoring proposals and counts the rest", () => {
    const payload = digest({
      awaiting: [
        proposal("a", 1),
        proposal("b", 9),
        proposal("c", 4),
        proposal("d", 7),
        proposal("e", 2),
        proposal("f", 8),
        proposal("g", 3),
      ],
    });

    expect(payload?.awaiting.total).toBe(7);
    expect(payload?.awaiting.top.map((line) => line.id)).toEqual([
      "b",
      "f",
      "d",
      "c",
      "g",
    ]);
  });

  it("carries the evidence with each proposal, not just the ask", () => {
    const payload = digest({ awaiting: [proposal("a", 1)] });

    expect(payload?.awaiting.top[0].evidence).toEqual([
      "a ranks 11th for its own headline query",
    ]);
  });

  it("breaks ties on the older proposal so two runs on the same data agree", () => {
    const payload = digest({
      awaiting: [
        proposal("newer", 5, "2026-07-31T09:00:00.000Z"),
        proposal("older", 5, "2026-07-29T09:00:00.000Z"),
      ],
    });

    expect(payload?.awaiting.top.map((line) => line.id)).toEqual([
      "older",
      "newer",
    ]);
  });
});

// ---------------------------------------------------------------------------
// What the receipts said
// ---------------------------------------------------------------------------

describe("measurementVerdict", () => {
  it("calls a clear gain a win", () => {
    expect(
      measurementVerdict({ baselineClicks: 100, adjustedClicksDelta: 40 }),
    ).toBe("win");
  });

  it("calls +3 clicks on a 400-click page nothing, because it is nothing", () => {
    expect(
      measurementVerdict({ baselineClicks: 400, adjustedClicksDelta: 3 }),
    ).toBe("no_change");
  });

  it("still needs a whole click from a page that started at zero", () => {
    expect(
      measurementVerdict({ baselineClicks: 0, adjustedClicksDelta: 0.4 }),
    ).toBe("no_change");
    expect(
      measurementVerdict({ baselineClicks: 0, adjustedClicksDelta: 1 }),
    ).toBe("win");
  });

  it("calls a symmetric drop a loss", () => {
    expect(
      measurementVerdict({ baselineClicks: 100, adjustedClicksDelta: -40 }),
    ).toBe("loss");
  });

  it("reports an unparseable baseline as no change rather than inventing one", () => {
    expect(
      measurementVerdict({ baselineClicks: 100, adjustedClicksDelta: null }),
    ).toBe("no_change");
  });
});

describe("positionDelta", () => {
  it("is positive when the page moved up the results", () => {
    expect(positionDelta(8.4, 5.1)).toBe(3.3);
  });

  it("is null when a window had no impressions, not zero", () => {
    expect(positionDelta(null, 5.1)).toBeNull();
    expect(positionDelta(8.4, null)).toBeNull();
  });
});

describe("assembleDigest — measured receipts", () => {
  it("reports the wins and the honest nulls side by side", () => {
    const payload = digest({
      measured: [
        measured({ receiptId: "win", adjustedClicksDelta: 40 }),
        measured({ receiptId: "flat", adjustedClicksDelta: 1 }),
        measured({ receiptId: "down", adjustedClicksDelta: -60 }),
      ],
    });

    expect(payload?.measured.map((line) => line.verdict)).toEqual([
      "win",
      "no_change",
      "loss",
    ]);
  });
});

// ---------------------------------------------------------------------------
// What is stuck
// ---------------------------------------------------------------------------

describe("assembleDigest — blocked", () => {
  it("puts a paused autopilot and a rejected credential above a throttle", () => {
    const payload = digest({
      blocked: {
        throttle: {
          cap: 1,
          reason: "quota held at 1 — 52% of recent posts are indexed",
        },
        gateFailures: [
          { title: "Best CRM for plumbers", attempts: 1, failedLaws: ["faq"] },
        ],
        adapterErrors: [
          { adapter: "wordpress", detail: "returned 401 for /wp-json" },
        ],
        autopilotPause: {
          reason: "autopilot paused — 3 drafts in a row failed the gate",
          since: "2026-07-30T09:00:00.000Z",
        },
        spend: null,
      },
    });

    expect(payload?.blocked.map((line) => line.kind)).toEqual([
      "autopilot_paused",
      "adapter",
      "throttle",
      "gate",
    ]);
  });

  it("hand-pluralizes the gate attempt count and names the laws", () => {
    const payload = digest({
      blocked: {
        ...NOTHING_BLOCKED,
        gateFailures: [
          {
            title: "Best CRM for plumbers",
            attempts: 3,
            failedLaws: ["faq", "internal-links"],
          },
          { title: "Cheapest CRM", attempts: 1, failedLaws: [] },
        ],
      },
    });

    expect(payload?.blocked.map((line) => line.detail)).toEqual([
      '"Best CRM for plumbers" failed the gate 3 times — faq, internal-links',
      '"Cheapest CRM" failed the gate 1 time — no law named',
    ]);
  });

  it("puts the pause in the digest with the day it started", () => {
    const payload = digest({
      blocked: {
        ...NOTHING_BLOCKED,
        autopilotPause: {
          reason: "autopilot paused — wordpress rejected our credentials",
          since: "2026-07-30T09:00:00.000Z",
        },
      },
    });

    expect(payload?.blocked[0].detail).toBe(
      "autopilot paused — wordpress rejected our credentials (since 2026-07-30T09:00:00.000Z)",
    );
  });
});

// ---------------------------------------------------------------------------
// The headline
// ---------------------------------------------------------------------------

describe("assembleDigest — the headline", () => {
  it("names every populated section and omits the empty ones", () => {
    const payload = digest({
      awaiting: [proposal("a", 1), proposal("b", 2)],
      shipped: [
        {
          articleId: "x",
          title: "Best CRM",
          url: "https://acme.com/best-crm/",
        },
      ],
      measured: [measured()],
    });

    expect(payload?.headline).toBe(
      "2 decisions waiting · 1 shipped · 1 receipt in",
    );
  });

  it("says only what happened on a day whose sole news is one blocked thing", () => {
    const payload = digest({
      blocked: {
        ...NOTHING_BLOCKED,
        throttle: {
          cap: 0,
          reason: "net-new paused — 31% of recent posts are indexed",
        },
      },
    });

    expect(payload?.headline).toBe("1 thing blocked");
    expect(payload?.forDate).toBe(FOR_DATE);
  });

  it("carries an unconfirmed URL through as null rather than linking to a guess", () => {
    const payload = digest({
      shipped: [{ articleId: "x", title: "Best CRM", url: null }],
    });

    expect(payload?.shipped[0].url).toBeNull();
  });
});
