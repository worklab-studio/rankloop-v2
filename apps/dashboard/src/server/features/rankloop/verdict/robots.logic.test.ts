// The AI access card quotes the user's own robots.txt back at them with a
// line number. Every case below is one where a naive parser gets it wrong and
// the card would state a confident falsehood about a file the user can read.

import { describe, expect, it } from "vitest";
import {
  AI_AGENTS,
  aiAccessVerdicts,
  decideAccess,
  normalizePath,
  parseRobots,
  selectGroup,
  sitemapDeclared,
} from "./robots.logic";

const parse = parseRobots;

describe("parseRobots()", () => {
  it("groups consecutive user-agent lines into one group", () => {
    // The most common way a site blocks AI. A parser that starts a new group
    // per user-agent line gives CCBot an empty rule set and calls it allowed.
    const p = parse(`
User-agent: GPTBot
User-agent: CCBot
Disallow: /
`);
    expect(p.groups).toHaveLength(1);
    expect(p.groups[0]?.agents).toEqual(["gptbot", "ccbot"]);
    expect(p.groups[0]?.rules).toHaveLength(1);
  });

  it("starts a new group when a user-agent follows a rule", () => {
    const p = parse(`
User-agent: *
Disallow: /admin/
User-agent: GPTBot
Disallow: /
`);
    expect(p.groups).toHaveLength(2);
    expect(p.groups[1]?.agents).toEqual(["gptbot"]);
  });

  it("ignores an empty Disallow instead of blocking the site", () => {
    // `Disallow:` means "nothing is disallowed". Reading it as a rule with an
    // empty pattern is how a parser reports a wide-open site as fully blocked.
    const p = parse("User-agent: *\nDisallow:");
    expect(p.groups[0]?.rules).toHaveLength(0);
    expect(decideAccess(p, "GPTBot", "/").verdict).toBe("allowed");
  });

  it("strips trailing comments from values", () => {
    const p = parse("User-agent: *\nDisallow: /private/ # internal only");
    expect(p.groups[0]?.rules[0]?.pattern).toBe("/private/");
  });

  it("records 1-indexed line numbers so the UI can cite the user's editor", () => {
    const p = parse("User-agent: *\nDisallow: /x/");
    expect(p.groups[0]?.rules[0]?.line).toBe(2);
  });

  it("collects sitemaps as a global directive, not a group rule", () => {
    const p = parse(`
Sitemap: https://x.example/sitemap.xml
User-agent: *
Disallow: /admin/
`);
    expect(p.sitemaps).toEqual(["https://x.example/sitemap.xml"]);
    expect(p.groups[0]?.rules).toHaveLength(1);
    expect(sitemapDeclared(p)).toBe(true);
  });

  it("records directives it does not act on rather than dropping them", () => {
    const p = parse("User-agent: *\nCrawl-delay: 10");
    expect(p.unknownDirectives).toEqual([{ field: "crawl-delay", line: 2 }]);
  });

  it("drops rules that appear before any user-agent line", () => {
    const p = parse("Disallow: /orphan/\nUser-agent: *\nDisallow: /real/");
    expect(p.groups).toHaveLength(1);
    expect(p.groups[0]?.rules.map((r) => r.pattern)).toEqual(["/real/"]);
  });

  it("is case-insensitive on field names", () => {
    const p = parse("USER-AGENT: GPTBot\nDISALLOW: /");
    expect(p.groups[0]?.agents).toEqual(["gptbot"]);
    expect(p.groups[0]?.rules).toHaveLength(1);
  });
});

describe("selectGroup()", () => {
  it("prefers the most specific user-agent token", () => {
    const p = parse(`
User-agent: Claude
Disallow: /

User-agent: ClaudeBot
Allow: /
`);
    expect(selectGroup(p, "ClaudeBot")?.matchedAgent).toBe("claudebot");
  });

  it("lets a named group REPLACE the wildcard group, not extend it", () => {
    // The decisive case. `User-agent: *  Disallow: /` plus an explicit
    // `User-agent: GPTBot  Allow: /` is an open door for GPTBot. A parser
    // that merges the groups reports it blocked and sends the user chasing a
    // fix they do not need.
    const p = parse(`
User-agent: *
Disallow: /

User-agent: GPTBot
Allow: /
`);
    expect(decideAccess(p, "GPTBot", "/").verdict).toBe("allowed");
    expect(decideAccess(p, "CCBot", "/").verdict).toBe("blocked");
  });

  it("falls back to the wildcard group when no named group matches", () => {
    const p = parse("User-agent: *\nDisallow: /");
    expect(selectGroup(p, "PerplexityBot")?.matchedAgent).toBe("*");
  });

  it("merges several wildcard groups rather than honouring only the first", () => {
    const p = parse(`
User-agent: *
Disallow: /admin/

User-agent: *
Disallow: /private/
`);
    expect(decideAccess(p, "GPTBot", "/private/").verdict).toBe("blocked");
  });

  it("returns null when the file governs nobody", () => {
    expect(selectGroup(parse("Sitemap: https://x.example/s.xml"), "GPTBot")).toBeNull();
  });

  it("matches case-insensitively", () => {
    const p = parse("User-agent: gptbot\nDisallow: /");
    expect(decideAccess(p, "GPTBot", "/").verdict).toBe("blocked");
  });
});

describe("decideAccess() precedence", () => {
  it("lets the longest matching pattern win", () => {
    const p = parse(`
User-agent: *
Disallow: /
Allow: /blog/
`);
    expect(decideAccess(p, "GPTBot", "/blog/").verdict).toBe("allowed");
    expect(decideAccess(p, "GPTBot", "/pricing/").verdict).toBe("blocked");
  });

  it("breaks an equal-length tie in favour of Allow", () => {
    // RFC 9309. Without this, rule order silently decides, and the rule the
    // card quotes is whichever was written first.
    const p = parse(`
User-agent: *
Disallow: /blog/
Allow: /blog/
`);
    const d = decideAccess(p, "GPTBot", "/blog/");
    expect(d.verdict).toBe("allowed");
    expect(d.rule?.type).toBe("allow");
  });

  it("defaults to allowed with a null rule when nothing matches", () => {
    // The UI must phrase "no rule mentions you" differently from an explicit
    // Allow, so the absence has to survive as data.
    const d = decideAccess(parse("User-agent: *\nDisallow: /admin/"), "GPTBot", "/");
    expect(d.verdict).toBe("allowed");
    expect(d.rule).toBeNull();
  });

  it("names the rule that decided, so the user can check us", () => {
    const d = decideAccess(parse("User-agent: GPTBot\nDisallow: /"), "GPTBot", "/");
    expect(d.rule).toMatchObject({ type: "disallow", pattern: "/", line: 2 });
    expect(d.matchedAgent).toBe("gptbot");
  });
});

describe("decideAccess() wildcards", () => {
  it("expands * to any run of characters", () => {
    const p = parse("User-agent: *\nDisallow: /*.pdf");
    expect(decideAccess(p, "GPTBot", "/docs/manual.pdf").verdict).toBe("blocked");
    expect(decideAccess(p, "GPTBot", "/docs/manual.html").verdict).toBe("allowed");
  });

  it("anchors a trailing $ to end of path", () => {
    const p = parse("User-agent: *\nDisallow: /*.php$");
    expect(decideAccess(p, "GPTBot", "/index.php").verdict).toBe("blocked");
    expect(decideAccess(p, "GPTBot", "/index.php?id=1").verdict).toBe("allowed");
  });

  it("treats a mid-pattern $ as a literal", () => {
    // `$` is only an anchor as the final character. Reading a query-string
    // dollar as an anchor would un-block a URL the site meant to block.
    const p = parse("User-agent: *\nDisallow: /a$b");
    expect(decideAccess(p, "GPTBot", "/a$b/c").verdict).toBe("blocked");
  });

  it("does not let regex metacharacters in a path escape the matcher", () => {
    const p = parse("User-agent: *\nDisallow: /a+b(c)/");
    expect(decideAccess(p, "GPTBot", "/a+b(c)/").verdict).toBe("blocked");
    expect(decideAccess(p, "GPTBot", "/aab/").verdict).toBe("allowed");
  });

  it("keeps prefix matching, surprising as it is", () => {
    // `/blog` really does cover `/blogging` under the standard. Adding a
    // boundary would make us disagree with the crawler we are describing.
    const p = parse("User-agent: *\nDisallow: /blog");
    expect(decideAccess(p, "GPTBot", "/blogging/").verdict).toBe("blocked");
  });
});

describe("aiAccessVerdicts()", () => {
  it("treats an absent robots.txt as everything allowed", () => {
    const v = aiAccessVerdicts(null, "/blog/");
    expect(v).toHaveLength(AI_AGENTS.length);
    expect(v.every((a) => !a.blocked)).toBe(true);
    expect(v[0]?.root.rule).toBeNull();
  });

  it("catches a site that allows / but blocks the blog", () => {
    // Invisible exactly where rankloop publishes. A root-only check calls
    // this site healthy.
    const v = aiAccessVerdicts(
      "User-agent: *\nDisallow: /blog/",
      "/blog/",
    );
    const gpt = v.find((a) => a.agent.name === "GPTBot");
    expect(gpt?.root.verdict).toBe("allowed");
    expect(gpt?.blog.verdict).toBe("blocked");
  });

  it("separates training crawlers from retrieval crawlers", () => {
    // Blocking training is a defensible choice; blocking search costs
    // citations. The card must be able to say which one happened.
    const v = aiAccessVerdicts(
      "User-agent: GPTBot\nDisallow: /\n\nUser-agent: OAI-SearchBot\nAllow: /",
      "/blog/",
    );
    expect(v.find((a) => a.agent.name === "GPTBot")?.blocked).toBe(true);
    expect(v.find((a) => a.agent.name === "OAI-SearchBot")?.blocked).toBe(false);
  });

  it("reports blocked only when BOTH root and blog are unreachable", () => {
    const v = aiAccessVerdicts("User-agent: *\nDisallow: /", "/blog/");
    expect(v.every((a) => a.blocked)).toBe(true);
  });
});

describe("normalizePath()", () => {
  it("normalizes every spelling of a blog path", () => {
    for (const input of ["blog", "/blog", "blog/", "/blog/", "  /blog  "]) {
      expect(normalizePath(input)).toBe("/blog/");
    }
  });

  it("leaves the root alone", () => {
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("")).toBe("/");
  });
});
