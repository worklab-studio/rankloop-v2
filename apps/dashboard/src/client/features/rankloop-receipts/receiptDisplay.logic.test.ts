import { describe, expect, it } from "vitest";
import {
  decidedByLabel,
  formatClicksDelta,
  formatReceiptPosition,
  receiptClicksDelta,
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
