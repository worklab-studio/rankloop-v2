/** `rankloop check`: the exit code CI reads, and the lines a human reads.
 *
 * The verdicts themselves are the engine's and are parity-tested there. What
 * is tested here is the wiring: that a real content tree on disk reaches the
 * laws, that a violation is reported at a path someone can open, and that the
 * process exit code is the one bit CI acts on. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCheck } from "../src/check.ts";
import { bufferIo } from "../src/io.ts";
import { cleanSite, markdownPost, writeSite } from "./site.ts";

/** Two clean neighbours plus one post that breaks exactly two laws: a banned
 * phrase, and an internal link pointing at a page that does not exist. */
function dirtySite() {
  return writeSite({
    posts: [
      { slug: "grinder-notes", links: ["burr-alignment", "bad-post"] },
      { slug: "burr-alignment", links: ["grinder-notes", "bad-post"] },
      { slug: "bad-post", links: ["ghost-page"], inject: "Let's explore the tradeoffs." },
    ],
  });
}

/** An html-mode site with one post at `blog/<slug>/index.html`. */
function htmlSite(html: string): { root: string } {
  const root = mkdtempSync(join(tmpdir(), "rankloop-html-"));
  writeFileSync(
    join(root, "rankloop.json"),
    JSON.stringify({
      site: {
        url: "https://example.com",
        name: "Example",
        blogPath: "blog",
        mode: "html",
      },
      contentDir: "blog",
      taxonomy: { Guides: "guides" },
    }),
    "utf8",
  );
  mkdirSync(join(root, "blog/a-post"), { recursive: true });
  writeFileSync(join(root, "blog/a-post/index.html"), html, "utf8");
  return { root };
}

describe("runCheck()", () => {
  it("exits 0 and counts the corpus when every law passes", () => {
    const io = bufferIo();
    expect(runCheck({ dir: cleanSite().root, format: "human" }, io)).toBe(0);
    expect(io.text).toBe("validated 3 posts: all laws pass");
    expect(io.errors).toEqual([]);
  });

  it("exits 1 and names every law the post broke, at its path", () => {
    const io = bufferIo();
    expect(runCheck({ dir: dirtySite().root, format: "human" }, io)).toBe(1);

    const violations = io.lines.filter((line) => line.includes("content/blog/"));
    expect(violations).toHaveLength(2);
    expect(violations.every((line) => line.startsWith("content/blog/bad-post.md:"))).toBe(true);
    expect(io.text).toContain("internal links >= 2");
    expect(io.text).toContain("no filler AI phrases");
    expect(io.text).toContain("2 violations in 1 post; 2 of 3 pass");
  });

  it("points a banned phrase at the line it is on, and an absence at line 1", () => {
    const io = bufferIo();
    runCheck({ dir: dirtySite().root, format: "human" }, io);

    const phrase = io.lines.find((line) => line.endsWith("no filler AI phrases"))!;
    const links = io.lines.find((line) => line.endsWith("internal links >= 2"))!;
    // `path:line: law` — the shape every editor's error parser already knows.
    expect(Number(phrase.split(":")[1])).toBeGreaterThan(1);
    expect(links.split(":")[1]).toBe("1");
  });

  it("emits one GitHub annotation per violation and a notice for the summary", () => {
    const io = bufferIo();
    expect(runCheck({ dir: dirtySite().root, format: "github" }, io)).toBe(1);

    const annotations = io.lines.filter((line) => line.startsWith("::error"));
    expect(annotations).toHaveLength(2);
    for (const annotation of annotations) {
      expect(annotation).toMatch(
        /^::error file=content\/blog\/bad-post\.md,line=\d+,title=rankloop%3A [^:]+::bad-post breaks the law: /,
      );
    }
    expect(io.lines.at(-1)).toBe("::notice::2 violations in 1 post; 2 of 3 pass");
  });

  it("prints nothing but the pass line in github format when the corpus is clean", () => {
    const io = bufferIo();
    expect(runCheck({ dir: cleanSite().root, format: "github" }, io)).toBe(0);
    expect(io.lines).toEqual(["validated 3 posts: all laws pass"]);
  });

  it("honours a laws override from rankloop.json", () => {
    // 5000 is above every generated post; the word-count floor is the one law
    // whose threshold is impossible to satisfy by accident.
    const site = writeSite({
      posts: [{ slug: "only-post", links: [] }],
      laws: { wordMin: 5000, wordMax: 9000, internalLinksMin: 0 },
    });
    const io = bufferIo();
    expect(runCheck({ dir: site.root, format: "human" }, io)).toBe(1);
    expect(io.text).toContain("word count >= 5000");
  });

  it("rejects a laws block no post could ever satisfy", () => {
    const site = writeSite({ posts: [{ slug: "only-post" }], laws: { wordMin: 5000 } });
    const io = bufferIo();
    expect(runCheck({ dir: site.root, format: "human" }, io)).toBe(1);
    expect(io.errors.join("\n")).toContain("no post could pass");
  });

  it("passes with no posts rather than failing a repo that has not started", () => {
    const site = writeSite({ posts: [] });
    const io = bufferIo();
    expect(runCheck({ dir: site.root, format: "human" }, io)).toBe(0);
    expect(io.text).toContain("nothing to check");
  });

  it("fails when there is no config, and says which command fixes it", () => {
    const site = cleanSite();
    rmSync(join(site.root, "rankloop.json"));
    const io = bufferIo();
    expect(runCheck({ dir: site.root, format: "human" }, io)).toBe(1);
    expect(io.errors.join("\n")).toContain("rankloop init");
  });

  it("fails on a broken config rather than checking nothing and passing", () => {
    const site = cleanSite();
    writeFileSync(join(site.root, "rankloop.json"), "{ not json", "utf8");
    const io = bufferIo();
    expect(runCheck({ dir: site.root, format: "human" }, io)).toBe(1);
    expect(io.errors.join("\n")).toContain("not valid JSON");
  });

  it("stops on an unparseable post instead of quietly checking a smaller corpus", () => {
    const site = htmlSite("<html><body><article>no structured data here</article></body></html>");
    const io = bufferIo();
    expect(runCheck({ dir: site.root, format: "human" }, io)).toBe(1);
    expect(io.errors.join("\n")).toContain("parse fail");
    expect(io.errors.join("\n")).toContain("no JSON-LD");
  });

  it("reads html posts through their JSON-LD, the way a crawler does", () => {
    const site = htmlSite(
      [
        "<html><head>",
        '<script type="application/ld+json">',
        JSON.stringify({
          "@type": "BlogPosting",
          headline: "A short post",
          description: "Short enough to pass the description law.",
          datePublished: "2026-07-01",
          articleSection: "Guides",
        }),
        "</script>",
        "</head><body><article><p>Barely a paragraph.</p></article></body></html>",
      ].join("\n"),
    );
    const io = bufferIo();
    expect(runCheck({ dir: site.root, format: "human" }, io)).toBe(1);
    // Parsing worked: the metadata laws pass and only the body laws fail.
    expect(io.text).toContain("word count >= 850");
    expect(io.text).not.toContain("date parses");
    expect(io.text).not.toContain("category known");
  });

  it("fails on two files claiming one URL", () => {
    const site = cleanSite();
    const nested = join(site.root, site.contentDir, "grinder-notes");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "index.md"), markdownPost({ slug: "grinder-notes" }), "utf8");
    const io = bufferIo();
    expect(runCheck({ dir: site.root, format: "human" }, io)).toBe(1);
    expect(io.errors.join("\n")).toContain("duplicate slug");
  });
});
