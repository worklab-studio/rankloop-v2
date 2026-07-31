import { describe, expect, it } from "vitest";
import { computeNetNewSlots } from "./selection";

// The indexation cap over the engine's answer (spec 0022), split out of
// selection.test.ts the way PublishService's step tests are split out of its
// own: one aspect, one file, both under the 400-line cap.

function quota(overrides: Partial<Parameters<typeof computeNetNewSlots>[0]>) {
  return computeNetNewSlots({
    settings: { postsPerDay: 2, catchupCap: 6, quotaStartDate: "2026-08-01" },
    publishedDates: [],
    outstanding: 0,
    today: "2026-08-01",
    ...overrides,
  });
}

describe("computeNetNewSlots under the indexation throttle", () => {
  const held = {
    cap: 1,
    reason: "quota held at 1 — 52% of recent posts are indexed",
  };
  const paused = {
    cap: 0,
    reason: "net-new paused — 30% of recent posts are indexed",
  };

  it("caps the finished quota rather than changing how the debt is counted", () => {
    // Three days of catch-up at 2/day owes six. The engine still says six —
    // the throttle is a ceiling over its answer, not an edit to its method.
    const result = quota({ today: "2026-08-03", throttle: held });

    expect(result.owed).toBe(6);
    expect(result.slots).toBe(1);
    expect(result.throttle).toEqual(held);
  });

  it("hands out nothing at all below 40%, and says why instead of blaming the queue", () => {
    const result = quota({ today: "2026-08-03", throttle: paused });

    expect(result.owed).toBe(6);
    expect(result.slots).toBe(0);
    expect(result.reason).toBe(paused.reason);
    expect(result.throttle).toEqual(paused);
  });

  it("leaves the quota alone when indexation is healthy or unknown", () => {
    const result = quota({
      today: "2026-08-03",
      throttle: null,
    });

    expect(result.slots).toBe(6);
    expect(result.throttle).toBeNull();
  });

  it("states the cap even on a day the cap is not what is binding", () => {
    // One owed, one already in the queue: the slots would be zero anyway. The
    // header still has to say the quota is being held, or the operator reads a
    // normal quiet day.
    const result = quota({ outstanding: 2, throttle: held });

    expect(result.slots).toBe(0);
    expect(result.reason).toBe("today's quota is already in the queue");
    expect(result.throttle).toEqual(held);
  });

  it("does not argue with a quota the user turned off", () => {
    const result = quota({
      settings: { postsPerDay: 2, catchupCap: 6, quotaStartDate: null },
      throttle: paused,
    });

    expect(result.reason).toBe("quota off — propose manually");
  });

  it("keeps the caller's own limit below the cap", () => {
    expect(quota({ today: "2026-08-03", limit: 0, throttle: held }).slots).toBe(
      0,
    );
  });
});
