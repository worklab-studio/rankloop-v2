import { describe, expect, it } from "vitest";
import {
  groupByOperator,
  headlineFor,
  purposeLabel,
  redirectNote,
  severityLabel,
} from "./aiAccessDisplay.logic";
import type { AiAccessCard } from "@/server/features/rankloop/verdict/services/AiAccessService";

function card(overrides: Partial<AiAccessCard> = {}): AiAccessCard {
  return {
    state: "ready",
    checkedAt: "2026-08-02T10:00:00.000Z",
    canonicalOrigin: "https://x.example",
    redirected: false,
    reachable: true,
    agents: [
      { name: "GPTBot", operator: "OpenAI", purpose: "training", allowed: true, rule: null },
      { name: "OAI-SearchBot", operator: "OpenAI", purpose: "search", allowed: true, rule: null },
      { name: "ClaudeBot", operator: "Anthropic", purpose: "training", allowed: true, rule: null },
    ],
    llmsTxtPresent: true,
    llmsFullPresent: true,
    htmlWords: 2293,
    findings: [],
    ...overrides,
  };
}

describe("headlineFor()", () => {
  it("says a clean site is clean, in words that mean it", () => {
    // If passing reads the same as failing, the card is decoration.
    const h = headlineFor(card());
    expect(h.tone).toBe("good");
    expect(h.title).toContain("All 3 AI crawlers can read your site");
  });

  it("counts criticals, not findings", () => {
    const h = headlineFor(
      card({
        findings: [
          { id: "a", severity: "critical", title: "", detail: "", fix: { kind: "manual", steps: ["x"] } },
          { id: "b", severity: "warning", title: "", detail: "", fix: { kind: "manual", steps: ["x"] } },
        ],
      }),
    );
    expect(h.tone).toBe("critical");
    expect(h.title).toBe("1 thing needs attention");
  });

  it("does not call a warning-only site broken", () => {
    // A missing llms.txt is worth surfacing and is not an emergency.
    const h = headlineFor(
      card({
        findings: [
          { id: "b", severity: "warning", title: "", detail: "", fix: { kind: "manual", steps: ["x"] } },
        ],
      }),
    );
    expect(h.tone).toBe("warning");
    expect(h.detail).toContain("All 3 AI crawlers");
  });

  it("names how many crawlers are blocked when any are", () => {
    const h = headlineFor(
      card({
        agents: [
          { name: "GPTBot", operator: "OpenAI", purpose: "training", allowed: false, rule: { type: "disallow" as const, pattern: "/", line: 2 } },
          { name: "OAI-SearchBot", operator: "OpenAI", purpose: "search", allowed: true, rule: null },
          { name: "ClaudeBot", operator: "Anthropic", purpose: "training", allowed: true, rule: null },
        ],
        findings: [
          { id: "a", severity: "critical", title: "", detail: "", fix: { kind: "manual", steps: ["x"] } },
        ],
      }),
    );
    expect(h.detail).toBe("1 of 3 AI crawlers cannot read your site.");
  });

  it("says the problem is elsewhere when robots.txt is not the cause", () => {
    // Edge blocking with a perfectly open robots.txt. Pointing at robots.txt
    // here would send the user to edit a file that is already correct.
    const h = headlineFor(
      card({
        findings: [
          { id: "edge-blocked", severity: "critical", title: "", detail: "", fix: { kind: "manual", steps: ["x"] } },
        ],
      }),
    );
    expect(h.detail).toContain("problem is elsewhere");
  });

  it("distinguishes never-run from unreadable", () => {
    // Both show the same button, but claiming nothing ever ran when a
    // snapshot exists is false.
    expect(headlineFor(card({ state: "never-run" })).title).toBe("Not checked yet");
    expect(headlineFor(card({ state: "unreadable" })).title).toContain("cannot be read");
  });

  it("short-circuits on an unreachable site", () => {
    const h = headlineFor(card({ reachable: false }));
    expect(h.tone).toBe("critical");
    expect(h.detail).toContain("Nothing below could run");
  });
});

describe("groupByOperator()", () => {
  it("groups crawlers under the company that runs them", () => {
    // People allow or block an operator, not a user-agent string.
    const groups = groupByOperator(card().agents);
    expect(groups.map((g) => g.operator)).toEqual(["OpenAI", "Anthropic"]);
    expect(groups[0]?.agents).toHaveLength(2);
  });

  it("counts blocked crawlers per operator", () => {
    const groups = groupByOperator([
      { name: "GPTBot", operator: "OpenAI", purpose: "training", allowed: false, rule: null },
      { name: "OAI-SearchBot", operator: "OpenAI", purpose: "search", allowed: true, rule: null },
    ]);
    expect(groups[0]?.blocked).toBe(1);
  });
});

describe("purposeLabel()", () => {
  it("describes what the crawl is for, not the protocol", () => {
    expect(purposeLabel("search")).toBe("answers questions");
    expect(purposeLabel("user-fetch")).toBe("fetches when asked");
    expect(purposeLabel("training")).toBe("model training");
  });
});

describe("severityLabel()", () => {
  it("avoids calling a suggestion an error", () => {
    expect(severityLabel("critical")).toBe("Needs attention");
    expect(severityLabel("warning")).toBe("Suggested");
  });
});

describe("redirectNote()", () => {
  it("explains where we actually read the files", () => {
    // The apex-to-www case. Usually fine, occasionally the whole bug.
    expect(redirectNote(card({ redirected: true }))).toContain("https://x.example");
  });

  it("stays quiet when nothing redirects", () => {
    expect(redirectNote(card())).toBeNull();
  });
});
