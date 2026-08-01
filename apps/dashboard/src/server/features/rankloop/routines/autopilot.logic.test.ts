import { describe, expect, it } from "vitest";
import {
  autopilotEligibility,
  autopilotGateStreak,
  autopilotKillSwitch,
  autopilotWriterStreak,
  resolveActionBehavior,
  type AutopilotEligibility,
  type GateOutcome,
  type SettledReceipt,
} from "./autopilot.logic";

const TODAY = "2026-08-01";

const gate = (at: string, passed: boolean): GateOutcome => ({ at, passed });

/** 90 days before TODAY is 2026-05-03, so this window has settled... */
const SETTLED = "2026-04-01";

/** ...and this one closed only two months ago. */
const UNSETTLED = "2026-06-01";

/** One receipt that moved a page from position `from` to position `to`. */
function receipt(
  actionType: string,
  from: number,
  to: number,
  windowEnd = SETTLED,
): SettledReceipt {
  return {
    actionType,
    windowEnd,
    baselinePosition: from,
    resultPosition: to,
  };
}

/** `n` retitle receipts that each improved by `improvedBy` positions. */
function improved(n: number, improvedBy: number): SettledReceipt[] {
  return Array.from({ length: n }, () =>
    receipt("retitle", 10, 10 - improvedBy),
  );
}

function eligibilityOf(receipts: SettledReceipt[], actionType = "retitle") {
  return autopilotEligibility({ actionType, receipts, today: TODAY });
}

// ---------------------------------------------------------------------------
// The cohort
// ---------------------------------------------------------------------------

describe("autopilotEligibility", () => {
  it("states the shortfall by number when there are fewer than five settled results", () => {
    const result = eligibilityOf(improved(2, 3));

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("needs 5 measured results, has 2");
    expect(result.measured).toBe(2);
    expect(result.medianPositionDelta).toBeNull();
  });

  it("ignores receipts whose windows closed inside the 90-day settling period", () => {
    const result = eligibilityOf([
      ...improved(3, 3),
      receipt("retitle", 10, 4, UNSETTLED),
      receipt("retitle", 10, 4, UNSETTLED),
      receipt("retitle", 10, 4, UNSETTLED),
    ]);

    expect(result.reason).toBe("needs 5 measured results, has 3");
  });

  it("counts a receipt on the settling boundary itself", () => {
    const onBoundary = Array.from({ length: 5 }, () =>
      receipt("retitle", 10, 7, "2026-05-03"),
    );

    expect(eligibilityOf(onBoundary).eligible).toBe(true);
  });

  it("drops receipts whose windows had no impressions to weight a position from", () => {
    const result = eligibilityOf([
      ...improved(4, 3),
      {
        actionType: "retitle",
        windowEnd: SETTLED,
        baselinePosition: null,
        resultPosition: 4,
      },
      {
        actionType: "retitle",
        windowEnd: SETTLED,
        baselinePosition: 9,
        resultPosition: null,
      },
    ]);

    expect(result.reason).toBe("needs 5 measured results, has 4");
  });

  // -------------------------------------------------------------------------
  // The verdict
  // -------------------------------------------------------------------------

  it("is eligible when the median improved and one in five came out worse", () => {
    const result = eligibilityOf([
      receipt("retitle", 10, 5),
      receipt("retitle", 10, 6),
      receipt("retitle", 10, 7),
      receipt("retitle", 10, 8),
      receipt("retitle", 10, 11),
    ]);

    expect(result.eligible).toBe(true);
    expect(result.worse).toBe(1);
    expect(result.medianPositionDelta).toBe(3);
    expect(result.reason).toBe("eligible (5 measured, median +3.0 positions)");
  });

  it("refuses when the median did not improve, and prints the median it refused on", () => {
    const result = eligibilityOf([
      receipt("retitle", 10, 12),
      receipt("retitle", 10, 11),
      receipt("retitle", 10, 10),
      receipt("retitle", 10, 9),
      receipt("retitle", 10, 8),
    ]);

    expect(result.eligible).toBe(false);
    expect(result.medianPositionDelta).toBe(0);
    expect(result.reason).toBe(
      "median result is ±0.0 positions across 5 measured — autopilot needs an improvement",
    );
  });

  it("refuses a strong median when two of five came out worse", () => {
    const result = eligibilityOf([
      receipt("retitle", 10, 2),
      receipt("retitle", 10, 3),
      receipt("retitle", 10, 4),
      receipt("retitle", 10, 11),
      receipt("retitle", 10, 12),
    ]);

    expect(result.medianPositionDelta).toBe(6);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe(
      "2 of 5 measured results came out worse than baseline",
    );
  });

  it("allows two worse once the cohort reaches ten", () => {
    const result = eligibilityOf([
      ...improved(8, 3),
      receipt("retitle", 10, 11),
      receipt("retitle", 10, 12),
    ]);

    expect(result.worse).toBe(2);
    expect(result.eligible).toBe(true);
  });

  // -------------------------------------------------------------------------
  // The control cohort
  // -------------------------------------------------------------------------

  it("subtracts the drift the project's other action types saw over the same period", () => {
    const result = eligibilityOf([
      // Every retitle gained 3 positions...
      ...improved(5, 3),
      // ...but so did everything else the project did, so the site moved, not
      // the retitles.
      receipt("push", 20, 17),
      receipt("push", 20, 17),
      receipt("refresh", 30, 27),
    ]);

    expect(result.medianPositionDelta).toBe(0);
    expect(result.eligible).toBe(false);
  });

  it("removes no drift from a project that only runs one action type", () => {
    const result = eligibilityOf([
      ...improved(5, 3),
      // Two controls is two numbers, not a trend.
      receipt("push", 20, 17),
      receipt("push", 20, 17),
    ]);

    expect(result.medianPositionDelta).toBe(3);
    expect(result.eligible).toBe(true);
  });

  // -------------------------------------------------------------------------
  // The two that never earn it
  // -------------------------------------------------------------------------

  it.each(["merge", "prune"])(
    "never makes %s eligible, however good its receipts are",
    (actionType) => {
      const perfect = Array.from({ length: 20 }, () =>
        receipt(actionType, 30, 2),
      );

      const result = eligibilityOf(perfect, actionType);

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe(
        "never unattended — this action removes a page that exists",
      );
      // The count is still reported: the answer is "no", not "no data".
      expect(result.measured).toBe(20);
    },
  );
});

// ---------------------------------------------------------------------------
// Kill switches
// ---------------------------------------------------------------------------

describe("autopilotKillSwitch", () => {
  it("pauses on three consecutive failed gates, dated to where the streak started", () => {
    const pause = autopilotKillSwitch({
      recentGateOutcomes: [
        gate("2026-08-01T09:00:00.000Z", false),
        gate("2026-07-31T09:00:00.000Z", false),
        gate("2026-07-30T09:00:00.000Z", false),
        gate("2026-07-29T09:00:00.000Z", true),
      ],
      adapterAuthError: null,
    });

    expect(pause).toEqual({
      reason: "autopilot paused — 3 drafts in a row failed the gate",
      since: "2026-07-30T09:00:00.000Z",
    });
  });

  it("does not pause on two failures", () => {
    const pause = autopilotKillSwitch({
      recentGateOutcomes: [
        gate("2026-08-01T09:00:00.000Z", false),
        gate("2026-07-31T09:00:00.000Z", false),
        gate("2026-07-30T09:00:00.000Z", true),
      ],
      adapterAuthError: null,
    });

    expect(pause).toBeNull();
  });

  it("counts consecutively, so a pass between failures clears the streak", () => {
    const pause = autopilotKillSwitch({
      recentGateOutcomes: [
        gate("2026-08-01T09:00:00.000Z", false),
        gate("2026-07-31T09:00:00.000Z", false),
        gate("2026-07-30T09:00:00.000Z", true),
        gate("2026-07-29T09:00:00.000Z", false),
        gate("2026-07-28T09:00:00.000Z", false),
      ],
      adapterAuthError: null,
    });

    expect(pause).toBeNull();
  });

  it("pauses on a single adapter auth failure, ahead of any gate counting", () => {
    const pause = autopilotKillSwitch({
      recentGateOutcomes: [gate("2026-08-01T09:00:00.000Z", true)],
      adapterAuthError: {
        adapter: "wordpress",
        at: "2026-08-01T06:12:00.000Z",
      },
    });

    expect(pause).toEqual({
      reason: "autopilot paused — wordpress rejected our credentials",
      since: "2026-08-01T06:12:00.000Z",
    });
  });

  it("is silent when nothing has gone wrong", () => {
    expect(
      autopilotKillSwitch({
        recentGateOutcomes: [gate("2026-08-01T09:00:00.000Z", true)],
        adapterAuthError: null,
      }),
    ).toBeNull();
  });
});

describe("autopilotGateStreak", () => {
  it("carries the stored count forward when the whole window failed", () => {
    const streak = autopilotGateStreak({
      priorFailures: 2,
      recentGateOutcomes: [gate("2026-08-01T09:00:00.000Z", false)],
    });

    expect(streak.consecutiveGateFailures).toBe(3);
    expect(streak.pause).toEqual({
      reason: "autopilot paused — 3 drafts in a row failed the gate",
      since: "2026-08-01T09:00:00.000Z",
    });
  });

  it("drops the stored count the moment a gate passes", () => {
    const streak = autopilotGateStreak({
      priorFailures: 2,
      recentGateOutcomes: [
        gate("2026-08-01T09:00:00.000Z", false),
        gate("2026-08-01T08:00:00.000Z", true),
      ],
    });

    expect(streak.consecutiveGateFailures).toBe(1);
    expect(streak.pause).toBeNull();
  });

  it("counts a whole window of failures on its own", () => {
    const streak = autopilotGateStreak({
      priorFailures: 0,
      recentGateOutcomes: [
        gate("2026-08-01T09:00:00.000Z", false),
        gate("2026-07-31T09:00:00.000Z", false),
        gate("2026-07-30T09:00:00.000Z", false),
      ],
    });

    expect(streak.consecutiveGateFailures).toBe(3);
    expect(streak.pause?.since).toBe("2026-07-30T09:00:00.000Z");
  });

  it("raises no new pause on an empty window, whatever the stored count", () => {
    const streak = autopilotGateStreak({
      priorFailures: 3,
      recentGateOutcomes: [],
    });

    // The count stands; the pause it caused is already on the row, and
    // re-raising it here would re-date it on every run.
    expect(streak.consecutiveGateFailures).toBe(3);
    expect(streak.pause).toBeNull();
  });
});

describe("autopilotWriterStreak", () => {
  it("pauses on three drafts that never reached a law, in its own words", () => {
    const streak = autopilotWriterStreak({
      priorFailures: 0,
      recentWriterOutcomes: [
        gate("2026-08-01T09:00:00.000Z", false),
        gate("2026-07-31T09:00:00.000Z", false),
        gate("2026-07-30T09:00:00.000Z", false),
      ],
    });

    expect(streak.consecutiveWriterFailures).toBe(3);
    expect(streak.pause).toEqual({
      reason: "autopilot paused — 3 drafts in a row never reached the gate",
      since: "2026-07-30T09:00:00.000Z",
    });
  });

  it("counts a graded draft as the streak ending, whatever the gate said", () => {
    // `passed` here means the draft reached a law. A writer whose output the
    // laws reject is a working writer, and the gate's own streak is what
    // judges that.
    const streak = autopilotWriterStreak({
      priorFailures: 2,
      recentWriterOutcomes: [
        gate("2026-08-01T09:00:00.000Z", false),
        gate("2026-08-01T08:00:00.000Z", true),
      ],
    });

    expect(streak.consecutiveWriterFailures).toBe(1);
    expect(streak.pause).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Honoring the dial
// ---------------------------------------------------------------------------

describe("resolveActionBehavior", () => {
  const eligible: AutopilotEligibility = {
    actionType: "retitle",
    eligible: true,
    reason: "eligible (7 measured, median +3.1 positions)",
    measured: 7,
    medianPositionDelta: 3.1,
    worse: 1,
  };
  const ineligible: AutopilotEligibility = {
    actionType: "write_new",
    eligible: false,
    reason: "needs 5 measured results, has 2",
    measured: 2,
    medianPositionDelta: null,
    worse: 0,
  };

  it.each(["titles", "drafts"] as const)(
    "leaves the %s dial alone — eligibility has no say over a human decision",
    (trustDial) => {
      expect(
        resolveActionBehavior({
          trustDial,
          eligibility: ineligible,
          pause: null,
        }),
      ).toEqual({ behavior: trustDial, fallbackReason: null });
    },
  );

  it("runs unattended only for an eligible type", () => {
    expect(
      resolveActionBehavior({
        trustDial: "autopilot",
        eligibility: eligible,
        pause: null,
      }),
    ).toEqual({ behavior: "autopilot", fallbackReason: null });
  });

  it("falls back to drafts with the eligibility reason attached", () => {
    expect(
      resolveActionBehavior({
        trustDial: "autopilot",
        eligibility: ineligible,
        pause: null,
      }),
    ).toEqual({
      behavior: "drafts",
      fallbackReason: "needs 5 measured results, has 2",
    });
  });

  it("lets a pause override an eligible type, and says the pause is why", () => {
    expect(
      resolveActionBehavior({
        trustDial: "autopilot",
        eligibility: eligible,
        pause: {
          reason: "autopilot paused — wordpress rejected our credentials",
          since: "2026-08-01T06:12:00.000Z",
        },
      }),
    ).toEqual({
      behavior: "drafts",
      fallbackReason: "autopilot paused — wordpress rejected our credentials",
    });
  });
});
