import { describe, expect, it } from "vitest";
import {
  digestDayLabel,
  measuredResultLine,
  measuredResultTone,
} from "./digestDisplay.logic";

describe("digestDayLabel", () => {
  it("names the day the routine wrote, not the browser's reading of it", () => {
    // A bare ISO day parses as UTC midnight, so anywhere west of Greenwich a
    // local formatter renders the day before — which on a list of consecutive
    // days shows up as two rows claiming the same date.
    expect(digestDayLabel("2026-08-01")).toBe("Aug 1");
    expect(digestDayLabel("2026-01-31")).toBe("Jan 31");
  });

  it("echoes anything that isn't an ISO day rather than printing Invalid Date", () => {
    expect(digestDayLabel("yesterday")).toBe("yesterday");
  });
});

describe("measuredResultLine", () => {
  it("states both movements when the server called it a win", () => {
    expect(
      measuredResultLine({
        verdict: "win",
        adjustedClicksDelta: 41,
        positionDelta: 3.14,
      }),
    ).toBe("+41 clicks · +3.1 positions");
  });

  it("keeps a loss signed rather than dressing it as a magnitude", () => {
    expect(
      measuredResultLine({
        verdict: "loss",
        adjustedClicksDelta: -6,
        positionDelta: null,
      }),
    ).toBe("-6 clicks");
  });

  it("defers to the server's null band instead of grading the number again", () => {
    // +2 clicks on a page that was getting 400 is the case the band exists
    // for: the delta is positive and the honest answer is still "nothing".
    expect(
      measuredResultLine({
        verdict: "no_change",
        adjustedClicksDelta: 2,
        positionDelta: 0.1,
      }),
    ).toBe("no measurable change");
  });

  it("separates a flat result from one that could not be anchored", () => {
    expect(
      measuredResultLine({
        verdict: "no_change",
        adjustedClicksDelta: null,
        positionDelta: null,
      }),
    ).toBe("measured, but the baseline can't anchor a delta");
  });
});

describe("measuredResultTone", () => {
  it("colours wins and losses, and leaves the honest flats neutral", () => {
    const line = { adjustedClicksDelta: 1, positionDelta: 1 };
    expect(measuredResultTone({ ...line, verdict: "win" })).toBe(
      "text-success",
    );
    expect(measuredResultTone({ ...line, verdict: "loss" })).toBe("text-error");
    expect(measuredResultTone({ ...line, verdict: "no_change" })).toBe(
      "text-base-content/60",
    );
  });
});
