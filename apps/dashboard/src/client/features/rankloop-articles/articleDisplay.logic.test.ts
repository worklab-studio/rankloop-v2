import { describe, expect, it } from "vitest";
import {
  articleStampLine,
  articleStepLabel,
  articleTab,
  failedLaws,
  isArticleRunning,
  writeCostLine,
} from "@/client/features/rankloop-articles/articleDisplay.logic";

describe("articleTab", () => {
  it("keeps every in-flight status on one tab, so a running article never disappears mid-step", () => {
    expect(articleTab("briefing")).toBe("writing");
    expect(articleTab("writing")).toBe("writing");
    expect(articleTab("gate")).toBe("writing");
    expect(articleTab("fixing")).toBe("writing");
  });

  it("files an auto-approved draft with the ones awaiting review", () => {
    expect(articleTab("review")).toBe("review");
    expect(articleTab("approved")).toBe("review");
  });

  it("gives published articles no tab — a shipped post is a receipt", () => {
    expect(articleTab("published")).toBeNull();
    expect(articleTab("publishing")).toBeNull();
  });
});

describe("isArticleRunning", () => {
  it("is true exactly while a workflow owns the row", () => {
    expect(isArticleRunning("gate")).toBe(true);
    expect(isArticleRunning("publishing")).toBe(true);
    expect(isArticleRunning("review")).toBe(false);
    expect(isArticleRunning("failed")).toBe(false);
  });
});

describe("articleStepLabel", () => {
  it("names the workflow step as a gerund", () => {
    expect(articleStepLabel("writing", null)).toBe("Drafting…");
    expect(articleStepLabel("gate", null)).toBe("Checking laws…");
  });

  it("counts the violations the repair pass was handed", () => {
    const report = [
      { law: "em dash", passed: false },
      { law: "word count >= 850", passed: true },
      { law: "internal links >= 2", passed: false },
    ];
    expect(articleStepLabel("fixing", report)).toBe("Fixing 2 violations…");
  });

  it("says less rather than '0' when the gate has not stored its verdict yet", () => {
    expect(articleStepLabel("fixing", null)).toBe("Fixing violations…");
    expect(articleStepLabel("fixing", [])).toBe("Fixing violations…");
  });

  it("pluralizes a single violation by hand", () => {
    expect(
      articleStepLabel("fixing", [{ law: "em dash", passed: false }]),
    ).toBe("Fixing 1 violation…");
  });

  it("has nothing to narrate once the row is terminal", () => {
    expect(articleStepLabel("review", null)).toBeNull();
    expect(articleStepLabel("failed", null)).toBeNull();
  });
});

describe("failedLaws", () => {
  it("keeps only the violations, preserving the law table's order", () => {
    const report = [
      { law: "em dash", passed: false },
      { law: "date parses", passed: true },
      { law: "no filler AI phrases", passed: false },
    ];
    expect(failedLaws(report).map((entry) => entry.law)).toEqual([
      "em dash",
      "no filler AI phrases",
    ]);
  });

  it("treats a missing report as no failures", () => {
    expect(failedLaws(null)).toEqual([]);
  });
});

describe("articleStampLine", () => {
  it("reads as the spec's receipt", () => {
    expect(
      articleStampLine({
        attempts: 2,
        costUsd: 0.31,
        model: "claude-sonnet-4-6",
      }),
    ).toBe("2 attempts · ~$0.31 · claude-sonnet-4-6 via OpenRouter");
  });

  it("drops the dollar fragment in agent mode rather than claiming $0.00", () => {
    expect(articleStampLine({ attempts: 1, costUsd: null, model: null })).toBe(
      "1 attempt",
    );
  });
});

describe("writeCostLine", () => {
  it("spells out the ceiling, not the happy path", () => {
    expect(writeCostLine(0.11, 3)).toBe(
      "~$0.11 per attempt × up to 3 attempts = ~$0.33 at most",
    );
  });
});
