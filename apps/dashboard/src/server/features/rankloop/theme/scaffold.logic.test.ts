// A scaffold PR that does not build is worse than no scaffold: it costs the
// user a review, a failed CI run, and their confidence in the feature. These
// tests are the ways a plausible template fails to build.

import { describe, expect, it } from "vitest";
import { buildScaffold, detectRenderer } from "./scaffold.logic";
import { extractTheme } from "./theme.logic";

const THEME = extractTheme([
  `${"color: rgb(0, 153, 255);".repeat(30)}${"background: rgb(255,255,255);".repeat(30)}`,
]);

const plan = (over: Partial<Parameters<typeof buildScaffold>[0]> = {}) =>
  buildScaffold({ stack: "next-app", blogPath: "blog", theme: THEME, packageJson: null, ...over });

describe("detectRenderer()", () => {
  it("finds a renderer the repo already has", () => {
    expect(detectRenderer('{"dependencies":{"marked":"^12.0.0"}}')).toBe("marked");
    expect(detectRenderer('{"dependencies":{"markdown-it":"^14.0.0"}}')).toBe("markdown-it");
  });

  it("returns null when there is none", () => {
    expect(detectRenderer('{"dependencies":{"react":"^19.0.0"}}')).toBeNull();
    expect(detectRenderer(null)).toBeNull();
  });
});

describe("the dependency it asks for", () => {
  it("asks for one renderer on Next, which has none built in", () => {
    expect(plan().requiredDependency).toBe("marked");
  });

  it("asks for nothing when the repo already has a renderer", () => {
    // An install request the user does not need is noise that makes them
    // distrust the ones they do need.
    expect(plan({ packageJson: '{"dependencies":{"marked":"^12"}}' }).requiredDependency).toBeNull();
  });

  it("uses the renderer the repo already has rather than adding a second", () => {
    const files = plan({ packageJson: '{"dependencies":{"markdown-it":"^14"}}' }).files;
    expect(files.find((f) => f.path.includes("[slug]"))?.content).toContain(
      'from "markdown-it"',
    );
  });

  it("asks for nothing on Astro, which renders markdown itself", () => {
    // Saying so is the difference between a PR that merges and one that
    // stalls on a question.
    expect(plan({ stack: "astro" }).requiredDependency).toBeNull();
  });

  it("asks for nothing on a static site", () => {
    expect(plan({ stack: "static" }).requiredDependency).toBeNull();
  });
});

describe("what the templates read", () => {
  it("reads the exact path the publisher writes to", () => {
    // The GitHub adapter writes content/<blogPath>/<slug>.md via
    // repoPathFor. A scaffold that reads anywhere else renders an empty
    // blog forever and nobody can see why.
    const index = plan().files.find((f) => f.path.endsWith("page.tsx"));
    expect(index?.content).toContain('path.join(process.cwd(), "content", "blog")');
  });

  it("honours a custom blog root on both sides", () => {
    const files = plan({ blogPath: "/guides/" }).files;
    expect(files[0]?.path).toBe("app/guides/page.tsx");
    expect(files[0]?.content).toContain('"content", "guides"');
  });

  it("skips index.md, which is the hub not a post", () => {
    expect(plan().files[0]?.content).toContain('f !== "index.md"');
  });
});

describe("templates carry their own frontmatter parsing", () => {
  it("inlines it rather than adding a dependency for twelve lines", () => {
    // A build that fails because the user did not read a README is worse
    // than no scaffold at all.
    for (const file of plan().files.filter((f) => f.path.endsWith(".tsx"))) {
      expect(file.content, file.path).toContain("function parseFrontmatter");
    }
  });

  it("does not import gray-matter anywhere", () => {
    for (const file of plan().files) {
      expect(file.content).not.toContain("gray-matter");
    }
  });
});

describe("the post page", () => {
  it("emits Article schema", () => {
    const post = plan().files.find((f) => f.path.includes("[slug]"));
    expect(post?.content).toContain("application/ld+json");
    expect(post?.content).toContain('"@type": "Article"');
  });

  it("exports metadata so the title and description reach the head", () => {
    expect(plan().files.find((f) => f.path.includes("[slug]"))?.content).toContain(
      "export async function generateMetadata",
    );
  });

  it("pre-renders every post rather than rendering on request", () => {
    expect(plan().files.find((f) => f.path.includes("[slug]"))?.content).toContain(
      "generateStaticParams",
    );
  });

  it("awaits params, as Next 15+ requires", () => {
    // `params` became a promise. A template written against the old
    // signature type-errors on every current Next install.
    const post = plan().files.find((f) => f.path.includes("[slug]"))?.content ?? "";
    expect(post).toContain("params: Promise<{ slug: string }>");
    expect(post).toContain("const { slug } = await params;");
  });

  it("handles a missing post instead of throwing", () => {
    expect(plan().files.find((f) => f.path.includes("[slug]"))?.content).toContain(
      "Not found",
    );
  });
});

describe("the theme stylesheet", () => {
  it("carries the extracted tokens", () => {
    const css = plan().files.find((f) => f.path.endsWith(".css"));
    expect(css?.content).toContain("--rl-accent: #0099ff;");
  });

  it("uses the variables rather than hard-coding them again", () => {
    // Hard-coded values in the rules would mean editing the token changes
    // nothing, which is the most confusing possible outcome.
    const css = plan().files.find((f) => f.path.endsWith(".css"))?.content ?? "";
    expect(css).toContain("color: var(--rl-fg)");
    expect(css).toContain("max-width: var(--rl-container)");
  });
});

describe("the static template", () => {
  it("fences the region rankloop owns", () => {
    // "rankloop only edits a block it created" — with no framework to
    // regenerate the page, the markers are what make that true.
    const index = plan({ stack: "static" }).files.find((f) => f.path.endsWith("index.html"));
    expect(index?.content).toContain("rankloop:posts:start");
    expect(index?.content).toContain("rankloop:posts:end");
  });

  it("says outside the markers is the user's", () => {
    expect(
      plan({ stack: "static" }).files.find((f) => f.path.endsWith("index.html"))?.content,
    ).toContain("anything outside is yours");
  });
});

describe("an unrecognised stack", () => {
  it("produces no files rather than a best guess", () => {
    // scaffoldPaths already refuses to name paths for a framework it cannot
    // identify. Inventing them here would route around that refusal.
    const p = plan({ stack: "unknown" });
    expect(p.files).toHaveLength(0);
    expect(p.requiredDependency).toBeNull();
  });
});

describe("every stack that produces files", () => {
  it("produces exactly an index, a post and a stylesheet", () => {
    for (const stack of ["next-app", "next-pages", "astro", "static"] as const) {
      const files = plan({ stack }).files;
      expect(files, stack).toHaveLength(3);
      expect(files.filter((f) => f.path.endsWith(".css")), stack).toHaveLength(1);
    }
  });

  it("explains every file for the PR body", () => {
    for (const stack of ["next-app", "astro", "static"] as const) {
      for (const file of plan({ stack }).files) {
        expect(file.purpose.length, `${stack} ${file.path}`).toBeGreaterThan(10);
      }
    }
  });
});
