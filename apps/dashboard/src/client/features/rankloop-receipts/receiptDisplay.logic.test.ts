import { describe, expect, it } from "vitest";
import {
  decidedByLabel,
  formatClicksDelta,
  formatReceiptPosition,
  receiptAdjustedClicksDelta,
  receiptClicksDelta,
  receiptClicksTone,
  receiptStatusDisplay,
} from "./receiptDisplay.logic";

describe("receiptStatusDisplay", () => {
  it("maps the four receipt statuses to their spec chips", () => {
    expect(receiptStatusDisplay("baseline")).toEqual({
      label: "waiting",
      color: "slate",
    });
    expect(receiptStatusDisplay("measuring")).toEqual({
      label: "measuring",
      color: "sky",
    });
    expect(receiptStatusDisplay("measured")).toEqual({
      label: "measured",
      color: "emerald",
    });
    expect(receiptStatusDisplay("contaminated")).toEqual({
      label: "contaminated",
      color: "amber",
    });
  });

  it("falls back to a neutral chip for statuses it has never heard of", () => {
    expect(receiptStatusDisplay("mystery")).toEqual({
      label: "mystery",
      color: "slate",
    });
  });
});

describe("decidedByLabel", () => {
  it("separates the machine's decisions from a person's", () => {
    expect(decidedByLabel("autopilot")).toBe("autopilot");
    expect(decidedByLabel("human")).toBe("human");
  });

  it("chips nothing for a receipt that predates the column", () => {
    expect(decidedByLabel(null)).toBeNull();
    expect(decidedByLabel("")).toBeNull();
  });
});

describe("formatReceiptPosition", () => {
  it("keeps one decimal, and em-dashes a missing measurement", () => {
    expect(formatReceiptPosition(12.44)).toBe("12.4");
    expect(formatReceiptPosition(null)).toBe("—");
  });
});

describe("receiptClicksDelta", () => {
  it("is null until both sides of the comparison exist", () => {
    expect(receiptClicksDelta(null, null)).toBeNull();
    expect(receiptClicksDelta({ clicks: 40 }, null)).toBeNull();
    expect(receiptClicksDelta({ clicks: 40 }, { clicks: 55 })).toBe(15);
  });
});

describe("formatClicksDelta", () => {
  it("signs non-zero deltas and em-dashes the unmeasured", () => {
    expect(formatClicksDelta(15)).toBe("+15");
    expect(formatClicksDelta(-3)).toBe("-3");
    expect(formatClicksDelta(0)).toBe("0");
    expect(formatClicksDelta(null)).toBe("—");
  });
});

describe("receiptAdjustedClicksDelta", () => {
  it("rounds the stored two-decimal float to whole clicks", () => {
    expect(receiptAdjustedClicksDelta({ adjustedClicksDelta: 13.44 })).toBe(13);
    expect(receiptAdjustedClicksDelta({ adjustedClicksDelta: -0.4 })).toBe(0);
    expect(
      formatClicksDelta(
        receiptAdjustedClicksDelta({
          adjustedClicksDelta: -0.4,
        }),
      ),
    ).toBe("0");
  });

  it("is null when there is no result, or no delta to adjust", () => {
    expect(receiptAdjustedClicksDelta(null)).toBeNull();
    expect(
      receiptAdjustedClicksDelta({ adjustedClicksDelta: null }),
    ).toBeNull();
  });
});

describe("receiptClicksTone", () => {
  // The defect this pins: a +80 raw delta in a window where the whole site
  // rose 80% is drift, not a win. The panel coloured that cell success green
  // off the raw sign while the digest, reading the same receipt's adjusted
  // delta, called it "no measurable change".
  it("refuses a win the trend adjustment took back", () => {
    expect(receiptClicksTone(80, 0)).toBe("");
  });

  it("calls a loss the adjustment uncovers under a flat raw delta", () => {
    expect(receiptClicksTone(0, -12)).toBe("text-error");
  });

  it("reads the adjusted delta, not the raw one, when they agree", () => {
    expect(receiptClicksTone(30, 24)).toBe("text-success");
    expect(receiptClicksTone(-9, -7)).toBe("text-error");
  });

  it("falls back to the raw sign only when nothing anchored an adjustment", () => {
    expect(receiptClicksTone(15, null)).toBe("text-success");
    expect(receiptClicksTone(-15, null)).toBe("text-error");
  });

  it("stays muted while the receipt has nothing to compare", () => {
    expect(receiptClicksTone(null, null)).toBe("text-base-content/40");
  });
});
