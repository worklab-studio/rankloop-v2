import { describe, expect, it } from "vitest";
import type { RecentDecision } from "./suppression.logic";
import { suppressedTargets } from "./suppression.logic";

const NOW = "2026-07-31T00:00:00.000Z";

function decision(overrides: Partial<RecentDecision>): RecentDecision {
  return {
    type: "push",
    target: "/a",
    decidedAt: null,
    executedAt: null,
    ...overrides,
  };
}

describe("suppressedTargets", () => {
  it("holds an executed target for the receipt's whole 42-day window", () => {
    const at41 = suppressedTargets(
      {
        recentDecisions: [decision({ executedAt: "2026-06-20T00:00:00.000Z" })],
        now: NOW,
      },
      "push",
    );
    expect(at41.has("/a")).toBe(true);
    // Day 43: the receipt closed, so acting again can no longer contaminate it.
    const at43 = suppressedTargets(
      {
        recentDecisions: [decision({ executedAt: "2026-06-18T00:00:00.000Z" })],
        now: NOW,
      },
      "push",
    );
    expect(at43.has("/a")).toBe(false);
  });

  it("anchors on executedAt over decidedAt — approval and execution can be weeks apart", () => {
    const lateExecution = suppressedTargets(
      {
        recentDecisions: [
          decision({
            // 70 days ago: past the decision window on its own.
            decidedAt: "2026-05-22T00:00:00.000Z",
            executedAt: "2026-07-26T00:00:00.000Z",
          }),
        ],
        now: NOW,
      },
      "push",
    );
    expect(lateExecution.has("/a")).toBe(true);
  });

  it("holds a decided-but-unexecuted target for the 60-day decision window", () => {
    // A decline has no executedAt and no receipt; only decidedAt holds it.
    const declined = suppressedTargets(
      {
        recentDecisions: [decision({ decidedAt: "2026-07-21T00:00:00.000Z" })],
        now: NOW,
      },
      "push",
    );
    expect(declined.has("/a")).toBe(true);
    const at61 = suppressedTargets(
      {
        recentDecisions: [decision({ decidedAt: "2026-05-31T00:00:00.000Z" })],
        now: NOW,
      },
      "push",
    );
    expect(at61.has("/a")).toBe(false);
  });

  it("scopes by type — a retitle decision says nothing about a push", () => {
    const input = {
      recentDecisions: [
        decision({ type: "retitle", executedAt: "2026-07-30T00:00:00.000Z" }),
      ],
      now: NOW,
    };
    expect(suppressedTargets(input, "push").has("/a")).toBe(false);
    expect(suppressedTargets(input, "retitle").has("/a")).toBe(true);
  });

  it("ignores rows with neither stamp — an undecided proposal suppresses nothing", () => {
    const suppressed = suppressedTargets(
      { recentDecisions: [decision({})], now: NOW },
      "push",
    );
    expect(suppressed.size).toBe(0);
  });
});
