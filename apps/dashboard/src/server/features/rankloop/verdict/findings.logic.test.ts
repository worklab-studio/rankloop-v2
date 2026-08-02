// The wording and the severity rules ARE the product on this card, so they
// are asserted here rather than discovered in a screenshot.

import { describe, expect, it } from "vitest";
import { aiAccessFindings, renderLlmsTxt, type FindingsInput } from "./findings.logic";
import { aiAccessVerdicts, parseRobots } from "./robots.logic";
import type { AiAccessProbe } from "./aiAccess";

function probe(overrides: Partial<AiAccessProbe> = {}): AiAccessProbe {
  const robotsText = "User-agent: *\nAllow: /";
  return {
    enteredUrl: "https://x.example/",
    canonicalOrigin: "https://x.example",
    redirected: false,
    reachable: true,
    robots: { state: "ok", url: "https://x.example/robots.txt", text: robotsText },
    parsedRobots: parseRobots(robotsText),
    agents: aiAccessVerdicts(robotsText, "/blog/"),
    llmsFiles: [
      { path: "/llms.txt", present: true, status: 200 },
      { path: "/llms-full.txt", present: true, status: 200 },
    ],
    edge: [
      { agent: "ClaudeBot", botStatus: 200, browserStatus: 200, botBytes: 100, browserBytes: 100, blocked: false, reason: null },
    ],
    jsGating: { url: "https://x.example/", words: 900, contentInHtml: true },
    ...overrides,
  };
}

function input(overrides: Partial<FindingsInput> = {}): FindingsInput {
  return { probe: probe(), siteName: "Example", blogPath: "/blog/", corpus: [], ...overrides };
}

/** Build a probe whose robots.txt is the given text. */
function withRobots(text: string): Partial<AiAccessProbe> {
  return {
    robots: { state: "ok", url: "https://x.example/robots.txt", text },
    parsedRobots: parseRobots(text),
    agents: aiAccessVerdicts(text, "/blog/"),
  };
}

describe("a healthy site", () => {
  it("produces no findings at all", () => {
    // productlaunchos.com's real state. Manufacturing work here is how a card
    // teaches its user to stop reading it.
    const found = aiAccessFindings(
      input({
        probe: probe({
          ...withRobots("User-agent: *\nAllow: /\n\nSitemap: https://x.example/sitemap.xml"),
        }),
      }),
    );
    expect(found).toEqual([]);
  });
});

describe("every finding carries an artifact", () => {
  it("holds across a site where everything is wrong at once", () => {
    // The contract from spec 0027: a finding that cannot say what to do about
    // itself is not allowed to exist.
    const found = aiAccessFindings(
      input({
        probe: probe({
          ...withRobots("User-agent: *\nDisallow: /"),
          llmsFiles: [
            { path: "/llms.txt", present: false, status: 404 },
            { path: "/llms-full.txt", present: false, status: 404 },
          ],
          edge: [
            { agent: "GPTBot", botStatus: 403, browserStatus: 200, botBytes: 0, browserBytes: 5000, blocked: true, reason: "HTTP 403 for the bot, 200 for a browser" },
          ],
          jsGating: { url: "https://x.example/", words: 4, contentInHtml: false },
        }),
      }),
    );
    expect(found.length).toBeGreaterThan(3);
    for (const f of found) {
      expect(f.fix, f.id).toBeDefined();
      if (f.fix.kind === "patch") expect(f.fix.content.length).toBeGreaterThan(0);
      if (f.fix.kind === "manual") expect(f.fix.steps.length).toBeGreaterThan(0);
      if (f.fix.kind === "list") expect(f.fix.items.length).toBeGreaterThan(0);
    }
  });
});

describe("blocking training is treated as a choice, not a mistake", () => {
  const blockTraining = withRobots(
    "User-agent: GPTBot\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: CCBot\nDisallow: /",
  );

  it("files training blocks as a warning, not a critical", () => {
    // Plenty of people block training deliberately. Calling that an error
    // teaches them the card is noise.
    const found = aiAccessFindings(input({ probe: probe(blockTraining) }));
    const training = found.find((f) => f.id === "ai-training-blocked");
    expect(training?.severity).toBe("warning");
  });

  it("says out loud that it may have been intentional", () => {
    const found = aiAccessFindings(input({ probe: probe(blockTraining) }));
    expect(found.find((f) => f.id === "ai-training-blocked")?.detail).toContain(
      "on purpose",
    );
  });

  it("escalates when a crawler that answers questions is blocked", () => {
    // Blocking retrieval costs citations, which is a different decision from
    // opting out of training, and gets a different severity.
    const found = aiAccessFindings(
      input({ probe: probe(withRobots("User-agent: PerplexityBot\nDisallow: /")) }),
    );
    const retrieval = found.find((f) => f.id === "ai-retrieval-blocked");
    expect(retrieval?.severity).toBe("critical");
    expect(retrieval?.detail).toContain("PerplexityBot");
  });
});

describe("findings quote the user's own file", () => {
  it("cites the line number that decided", () => {
    // The user has to be able to check us. A claim with no citation is a
    // claim they have to take on faith about a file they can read.
    const found = aiAccessFindings(
      input({ probe: probe(withRobots("# hi\nUser-agent: PerplexityBot\nDisallow: /")) }),
    );
    expect(found.find((f) => f.id === "ai-retrieval-blocked")?.detail).toContain("line 3");
  });

  it("names the preserved restrictions in the fix note", () => {
    const found = aiAccessFindings(
      input({
        probe: probe(withRobots("User-agent: *\nDisallow: /\nDisallow: /admin/")),
      }),
    );
    const fix = found.find((f) => f.id === "ai-retrieval-blocked")?.fix;
    expect(fix?.kind).toBe("patch");
    if (fix?.kind === "patch") expect(fix.note).toContain("Disallow: /admin/");
  });
});

describe("a robots.txt that fails is not a robots.txt that is missing", () => {
  it("raises a critical for a 5xx", () => {
    const found = aiAccessFindings(
      input({
        probe: probe({
          robots: { state: "unavailable", url: "https://x.example/robots.txt", status: 503, detail: "robots.txt returned 503" },
          parsedRobots: parseRobots(""),
          agents: aiAccessVerdicts(null, "/blog/"),
        }),
      }),
    );
    const f = found.find((x) => x.id === "robots-unavailable");
    expect(f?.severity).toBe("critical");
    expect(f?.detail).toContain("404 here would be harmless");
  });

  it("raises nothing for a 404", () => {
    // Absent means everything is permitted. There is no problem.
    const found = aiAccessFindings(
      input({
        probe: probe({
          robots: { state: "absent", url: "https://x.example/robots.txt", status: 404 },
          parsedRobots: parseRobots(""),
          agents: aiAccessVerdicts(null, "/blog/"),
        }),
      }),
    );
    expect(found.find((x) => x.id === "robots-unavailable")).toBeUndefined();
    expect(found.find((x) => x.id === "ai-retrieval-blocked")).toBeUndefined();
  });
});

describe("the JavaScript finding never claims more than it measured", () => {
  it("says what it counted and admits it did not render", () => {
    // We do not execute JavaScript. Wording that implied otherwise would be
    // the same species of fabrication the publish laws exist to stop.
    const found = aiAccessFindings(
      input({
        probe: probe({ jsGating: { url: "https://x.example/", words: 4, contentInHtml: false } }),
      }),
    );
    const f = found.find((x) => x.id === "content-not-in-html");
    expect(f?.detail).toContain("4 words");
    expect(f?.detail).toContain("do not run JavaScript");
  });

  it("stays quiet on a text-heavy page inside enormous markup", () => {
    // The productlaunchos.com case: 2,293 words in 657 KB. Judged on the
    // absolute count this is a real page; judged as a ratio it is not.
    const found = aiAccessFindings(
      input({ probe: probe({ jsGating: { url: "https://x.example/", words: 2293, contentInHtml: true } }) }),
    );
    expect(found.find((x) => x.id === "content-not-in-html")).toBeUndefined();
  });
});

describe("unreachable short-circuits", () => {
  it("returns one finding and does not pretend the rest ran", () => {
    const found = aiAccessFindings(input({ probe: probe({ reachable: false }) }));
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe("unreachable");
  });
});

describe("renderLlmsTxt()", () => {
  it("lists crawled pages", () => {
    const out = renderLlmsTxt({
      siteName: "Example",
      origin: "https://x.example",
      pages: [{ url: "https://x.example/a", title: "A", description: "About a" }],
    });
    expect(out).toContain("# Example");
    expect(out).toContain("- [A](https://x.example/a): About a");
  });

  it("still produces a valid file when nothing has been crawled", () => {
    // The fix must be an artifact even before a site study has run, or the
    // finding would be advice wearing a patch's clothes.
    const out = renderLlmsTxt({ siteName: "Example", origin: "https://x.example", pages: [] });
    expect(out.startsWith("# Example")).toBe(true);
    expect(out).toContain("https://x.example");
  });

  it("falls back to the URL when a page has no title", () => {
    const out = renderLlmsTxt({
      siteName: "Example",
      origin: "https://x.example",
      pages: [{ url: "https://x.example/b", title: null, description: null }],
    });
    expect(out).toContain("- [https://x.example/b](https://x.example/b)");
  });
});

describe("the llms.txt fix", () => {
  it("ships file content and a diff, not instructions", () => {
    const found = aiAccessFindings(
      input({
        probe: probe({
          llmsFiles: [
            { path: "/llms.txt", present: false, status: 404 },
            { path: "/llms-full.txt", present: false, status: 404 },
          ],
        }),
        corpus: [{ url: "https://x.example/a", title: "A", description: null }],
      }),
    );
    const fix = found.find((f) => f.id === "llms-txt-missing")?.fix;
    expect(fix?.kind).toBe("patch");
    if (fix?.kind === "patch") {
      expect(fix.content).toContain("- [A](https://x.example/a)");
      expect(fix.diff).toContain("+# Example");
    }
  });
});
