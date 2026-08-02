import { describe, expect, it } from "vitest";
import {
  detectStack,
  safeBlogRoot,
  planWrites,
  pullRequestBody,
  scaffoldPaths,
  stackLabel,
  type RepoProbe,
  type ScaffoldFile,
} from "./stack.logic";

const probe = (...paths: string[]): RepoProbe =>
  Object.fromEntries(paths.map((p) => [p, true]));

describe("detectStack()", () => {
  it("recognises a Next.js app router repo", () => {
    const d = detectStack(probe("next.config.mjs", "app/layout.tsx"));
    expect(d.stack).toBe("next-app");
    expect(d.confidence).toBe("high");
    expect(d.evidence).toContain("app/layout.tsx");
  });

  it("recognises the pages router", () => {
    expect(detectStack(probe("next.config.js", "pages/_app.tsx")).stack).toBe("next-pages");
  });

  it("prefers the app directory in a repo mid-migration", () => {
    // Both routers present. New routes go in app/, so a blog belongs there.
    expect(
      detectStack(probe("next.config.js", "app/layout.tsx", "pages/index.tsx")).stack,
    ).toBe("next-app");
  });

  it("recognises Astro before Next, since a config file is decisive", () => {
    expect(detectStack(probe("astro.config.mjs")).stack).toBe("astro");
  });

  it("recognises a static site", () => {
    expect(detectStack(probe("index.html")).stack).toBe("static");
  });

  it("refuses to guess a router it cannot see", () => {
    // We know it is Next.js and not which router. Guessing is exactly the
    // guess that produces a PR nobody can merge.
    const d = detectStack(probe("next.config.js", "package.json"));
    expect(d.stack).toBe("unknown");
    expect(d.evidence).toContain("next.config.js");
  });

  it("reports an unrecognised repo as unrecognised", () => {
    // An Eleventy or Hugo site. Scaffolding Next.js into it would be a
    // worse first impression than saying we could not tell.
    const d = detectStack(probe("package.json", "README.md"));
    expect(d.stack).toBe("unknown");
    expect(d.confidence).toBe("low");
  });

  it("handles a completely empty probe", () => {
    expect(detectStack({}).stack).toBe("unknown");
  });
});

describe("scaffoldPaths()", () => {
  it("puts the blog where each framework expects it", () => {
    expect(scaffoldPaths("next-app", "blog")?.post).toBe("app/blog/[slug]/page.tsx");
    expect(scaffoldPaths("next-pages", "blog")?.post).toBe("pages/blog/[slug].tsx");
    expect(scaffoldPaths("astro", "blog")?.post).toBe("src/pages/blog/[slug].astro");
    expect(scaffoldPaths("static", "blog")?.index).toBe("blog/index.html");
  });

  it("honours a custom blog root", () => {
    expect(scaffoldPaths("next-app", "/guides/")?.index).toBe("app/guides/page.tsx");
  });

  it("falls back to blog for an empty root", () => {
    expect(scaffoldPaths("next-app", "")?.index).toBe("app/blog/page.tsx");
  });

  it("has no opinion about a framework it cannot name", () => {
    expect(scaffoldPaths("unknown", "blog")).toBeNull();
  });
});

describe("safeBlogRoot()", () => {
  it("strips characters that would break generated source", () => {
    // The root is interpolated into string literals in the templates. A
    // quote closes one early and ships a PR that does not parse — caught by
    // the compile test, fixed here.
    expect(safeBlogRoot('we"ird')).toBe("we-ird");
    expect(safeBlogRoot("back`tick")).toBe("back-tick");
    expect(safeBlogRoot("${injected}")).toBe("injected");
  });

  it("refuses to escape the blog directory", () => {
    // blogPath comes from a page type's URL pattern, which is user data.
    // `../../` in it would write files anywhere in the repo.
    expect(safeBlogRoot("../../etc")).toBe("etc");
    expect(safeBlogRoot("./blog")).toBe("blog");
    expect(safeBlogRoot("..")).toBe("blog");
  });

  it("keeps a legitimate nested root", () => {
    expect(safeBlogRoot("/resources/guides/")).toBe("resources/guides");
  });

  it("normalises case and trims separators", () => {
    expect(safeBlogRoot("/Blog/")).toBe("blog");
    expect(safeBlogRoot("")).toBe("blog");
    expect(safeBlogRoot("   ")).toBe("blog");
  });
});

describe("planWrites()", () => {
  const files: ScaffoldFile[] = [
    { path: "app/blog/page.tsx", content: "x", purpose: "index" },
    { path: "app/blog/rankloop-theme.css", content: "y", purpose: "tokens" },
  ];

  it("never overwrites a file that already exists", () => {
    // A user's existing blog layout is not ours to replace, and a PR that
    // silently clobbers it is the worst thing this feature could do.
    const { write, skipped } = planWrites(files, new Set(["app/blog/page.tsx"]));
    expect(write.map((f) => f.path)).toEqual(["app/blog/rankloop-theme.css"]);
    expect(skipped.map((f) => f.path)).toEqual(["app/blog/page.tsx"]);
  });

  it("writes everything into an empty repo", () => {
    expect(planWrites(files, new Set()).write).toHaveLength(2);
  });

  it("writes nothing when everything exists", () => {
    const { write, skipped } = planWrites(
      files,
      new Set(files.map((f) => f.path)),
    );
    expect(write).toHaveLength(0);
    expect(skipped).toHaveLength(2);
  });
});

describe("pullRequestBody()", () => {
  const body = (over: Partial<Parameters<typeof pullRequestBody>[0]> = {}) =>
    pullRequestBody({
      stack: "next-app",
      written: [{ path: "app/blog/page.tsx", content: "", purpose: "the blog index" }],
      skipped: [],
      themeSummary: [{ name: "Accent", value: "#0099ff", confidence: "high" }],
      needsReview: [],
      ...over,
    });

  it("names the stack and every file, so review reads a description", () => {
    const text = body();
    expect(text).toContain("Next.js (app router)");
    expect(text).toContain("`app/blog/page.tsx` — the blog index");
  });

  it("shows the tokens it used with their confidence", () => {
    expect(body()).toContain("| Accent | `#0099ff` | high |");
  });

  it("says what it skipped rather than staying quiet", () => {
    const text = body({
      skipped: [{ path: "app/blog/page.tsx", content: "", purpose: "index" }],
    });
    expect(text).toContain("Files skipped");
    expect(text).toContain("did not touch");
  });

  it("warns about low-confidence tokens where the reviewer will see it", () => {
    // The reviewer is the person who can tell whether the font is right, and
    // the PR is the moment they are looking. Burying this in the dashboard
    // shows it to somebody who has already stopped checking.
    expect(body({ needsReview: ["Body font", "Corner radius"] })).toContain(
      "not confident about: Body font, Corner radius",
    );
  });

  it("says nothing is live until merge", () => {
    expect(body()).toContain("Nothing is live until you merge");
  });
});

describe("stackLabel()", () => {
  it("reads as English, including for the unknown case", () => {
    expect(stackLabel("next-app")).toBe("Next.js (app router)");
    expect(stackLabel("unknown")).toBe("Not recognised");
  });
});
