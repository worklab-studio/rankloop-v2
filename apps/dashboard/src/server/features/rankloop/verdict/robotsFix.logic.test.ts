// The fix has to be safe before it is helpful. The first block below is the
// one that matters: a patch that unblocks GPTBot must not hand it /admin/.

import { describe, expect, it } from "vitest";
import {
  BLOCK_END,
  BLOCK_START,
  planRobotsFix,
  unifiedDiff,
  upsertManagedBlock,
} from "./robotsFix.logic";
import { aiAccessVerdicts, decideAccess, parseRobots } from "./robots.logic";

const AGENTS = [
  { name: "GPTBot", operator: "OpenAI", purpose: "training" as const },
  { name: "ClaudeBot", operator: "Anthropic", purpose: "training" as const },
];

describe("the fix never widens access", () => {
  const robots = `User-agent: *
Disallow: /
Disallow: /admin/
Disallow: /checkout/`;

  it("carries the site's other restrictions into the generated group", () => {
    // A named group REPLACES the wildcard group for that agent. Emitting only
    // `Allow: /` would silently grant /admin/ and /checkout/ to the very
    // crawlers we just let in — an access change the user never approved,
    // shipped inside something labelled a fix.
    const plan = planRobotsFix({ robotsText: robots, blogPath: "/blog/", agents: AGENTS });
    expect(plan.preserved).toEqual(["Disallow: /admin/", "Disallow: /checkout/"]);
    expect(plan.nextContent).toContain("Disallow: /admin/");
  });

  it("proves it by re-parsing the patched file", () => {
    // The real assertion: run the result back through the parser and confirm
    // the crawler is allowed where it should be and still blocked where it
    // should be. Anything less is trusting our own string building.
    const plan = planRobotsFix({ robotsText: robots, blogPath: "/blog/", agents: AGENTS });
    const after = parseRobots(plan.nextContent ?? "");

    expect(decideAccess(after, "GPTBot", "/").verdict).toBe("allowed");
    expect(decideAccess(after, "GPTBot", "/blog/").verdict).toBe("allowed");
    expect(decideAccess(after, "GPTBot", "/admin/").verdict).toBe("blocked");
    expect(decideAccess(after, "GPTBot", "/checkout/").verdict).toBe("blocked");
  });

  it("leaves human crawlers exactly as they were", () => {
    const plan = planRobotsFix({ robotsText: robots, blogPath: "/blog/", agents: AGENTS });
    const after = parseRobots(plan.nextContent ?? "");
    // Googlebot still falls through to the wildcard group, untouched.
    expect(decideAccess(after, "Googlebot", "/").verdict).toBe("blocked");
  });

  it("does not carry over the rule that was doing the blocking", () => {
    const plan = planRobotsFix({ robotsText: robots, blogPath: "/blog/", agents: AGENTS });
    expect(plan.preserved).not.toContain("Disallow: /");
  });

  it("drops a blog-specific disallow so the blog is actually reachable", () => {
    const plan = planRobotsFix({
      robotsText: "User-agent: *\nDisallow: /blog/\nDisallow: /admin/",
      blogPath: "/blog/",
      agents: AGENTS,
    });
    const after = parseRobots(plan.nextContent ?? "");
    expect(decideAccess(after, "GPTBot", "/blog/").verdict).toBe("allowed");
    expect(decideAccess(after, "GPTBot", "/admin/").verdict).toBe("blocked");
  });
});

describe("what the fix refuses to do", () => {
  it("will not paper over a named group that blocks the agent", () => {
    // Appending cannot beat a named group — it IS the group that wins. A tool
    // that appended anyway would report success and change nothing.
    const plan = planRobotsFix({
      robotsText: "User-agent: GPTBot\nDisallow: /",
      blogPath: "/blog/",
      agents: AGENTS,
    });
    expect(plan.additiveAgents).not.toContain("GPTBot");
    expect(plan.manual).toHaveLength(1);
    expect(plan.manual[0]).toMatchObject({
      agent: "GPTBot",
      line: 2,
      current: "Disallow: /",
      replacement: "Allow: /",
    });
  });

  it("handles one agent needing a manual edit and another an append", () => {
    const plan = planRobotsFix({
      robotsText: "User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /",
      blogPath: "/blog/",
      agents: AGENTS,
    });
    expect(plan.manual.map((m) => m.agent)).toEqual(["GPTBot"]);
    expect(plan.additiveAgents).toEqual(["ClaudeBot"]);
  });

  it("proposes nothing when every agent is already allowed", () => {
    // productlaunchos.com's actual file. A tool that manufactures work here
    // teaches the user to ignore it.
    const plan = planRobotsFix({
      robotsText: "User-agent: *\nAllow: /\n\nSitemap: https://x.example/sitemap.xml",
      blogPath: "/blog/",
      sitemapUrl: "https://x.example/sitemap.xml",
      agents: AGENTS,
    });
    expect(plan.nextContent).toBeNull();
    expect(plan.diff).toBeNull();
    expect(plan.manual).toHaveLength(0);
  });

  it("proposes nothing when there is no robots.txt at all", () => {
    // Absent means everything is allowed. There is no problem to fix.
    const plan = planRobotsFix({ robotsText: null, blogPath: "/blog/", agents: AGENTS });
    expect(plan.nextContent).toBeNull();
  });
});

describe("the sitemap line", () => {
  it("is added when robots.txt declares none", () => {
    const plan = planRobotsFix({
      robotsText: "User-agent: *\nAllow: /",
      blogPath: "/blog/",
      sitemapUrl: "https://x.example/sitemap.xml",
      agents: AGENTS,
    });
    expect(plan.nextContent).toContain("Sitemap: https://x.example/sitemap.xml");
  });

  it("is not duplicated when one already exists", () => {
    const plan = planRobotsFix({
      robotsText: "User-agent: *\nAllow: /\nSitemap: https://x.example/a.xml",
      blogPath: "/blog/",
      sitemapUrl: "https://x.example/a.xml",
      agents: AGENTS,
    });
    expect(plan.nextContent).toBeNull();
  });
});

describe("upsertManagedBlock()", () => {
  it("appends when no block exists", () => {
    const out = upsertManagedBlock("User-agent: *\nAllow: /\n", `${BLOCK_START}\nx\n${BLOCK_END}`);
    expect(out).toContain("User-agent: *");
    expect(out).toContain(BLOCK_START);
  });

  it("replaces a previous block instead of stacking a second one", () => {
    // Re-running the fix must be a no-op, not an accumulation. This is what
    // makes it safe to offer as a button.
    const first = upsertManagedBlock("User-agent: *\nAllow: /\n", `${BLOCK_START}\nold\n${BLOCK_END}`);
    const second = upsertManagedBlock(first, `${BLOCK_START}\nnew\n${BLOCK_END}`);
    expect(second.match(new RegExp(BLOCK_START, "g"))).toHaveLength(1);
    expect(second).toContain("new");
    expect(second).not.toContain("old");
  });

  it("never disturbs the user's own lines", () => {
    const mine = "User-agent: *\nDisallow: /admin/\n";
    const out = upsertManagedBlock(mine, `${BLOCK_START}\nx\n${BLOCK_END}`);
    expect(out.startsWith(mine)).toBe(true);
  });

  it("handles an empty file", () => {
    expect(upsertManagedBlock("", `${BLOCK_START}\nx\n${BLOCK_END}`)).toBe(
      `${BLOCK_START}\nx\n${BLOCK_END}\n`,
    );
  });

  it("is idempotent through a full plan → apply → plan cycle", () => {
    const original = "User-agent: *\nDisallow: /\nDisallow: /admin/";
    const first = planRobotsFix({ robotsText: original, blogPath: "/blog/", agents: AGENTS });
    const applied = first.nextContent ?? "";
    const second = planRobotsFix({ robotsText: applied, blogPath: "/blog/", agents: AGENTS });
    // Nothing left to do — the first patch actually worked.
    expect(second.nextContent).toBeNull();
    expect(aiAccessVerdicts(applied, "/blog/", AGENTS).every((a) => !a.blocked)).toBe(true);
  });
});

describe("unifiedDiff()", () => {
  it("returns null for no change", () => {
    expect(unifiedDiff("a\nb", "a\nb", "robots.txt")).toBeNull();
  });

  it("emits a header and the added lines", () => {
    const d = unifiedDiff("a\nb", "a\nb\nc", "robots.txt") ?? "";
    expect(d).toContain("--- a/robots.txt");
    expect(d).toContain("+++ b/robots.txt");
    expect(d).toContain("+c");
  });

  it("counts hunk lines correctly for an append", () => {
    // A wrong count makes the patch unappliable and, worse, looks fine.
    const d = unifiedDiff("a\nb", "a\nb\nc", "robots.txt") ?? "";
    expect(d).toContain("@@ -1,2 +1,3 @@");
  });

  it("shows a replacement as removal plus addition", () => {
    const d = unifiedDiff("a\nold\nz", "a\nnew\nz", "robots.txt") ?? "";
    expect(d).toContain("-old");
    expect(d).toContain("+new");
    expect(d).toContain("@@ -1,3 +1,3 @@");
  });

  it("handles an empty original", () => {
    const d = unifiedDiff("", "a\nb", "robots.txt") ?? "";
    expect(d).toContain("@@ -1,0 +1,2 @@");
  });
});
