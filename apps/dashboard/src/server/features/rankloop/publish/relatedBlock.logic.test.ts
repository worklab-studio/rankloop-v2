import { describe, expect, it } from "vitest";
import { mergeRelatedBlock } from "./relatedBlock.logic";

// The delimiters are spelled out here rather than imported: renaming a marker
// orphans every block already living on a user's site, and that should break a
// test that names the old one, not quietly follow the rename.
const START = "<!-- rankloop:related start -->";
const END = "<!-- rankloop:related end -->";

const PROSE = [
  "# Espresso tampers",
  "",
  "The flat base is the whole argument, and nobody edits this sentence but me.",
  "",
  "## Why 58.5mm",
  "",
  "Because the basket is 58mm and the gap is where the puck fails.",
].join("\n");

const ONE_LINK = [{ path: "/blog/tamper-sizes/", title: "Tamper sizes" }];

describe("mergeRelatedBlock — appending", () => {
  it("appends exactly one block to a page that has none", () => {
    const result = mergeRelatedBlock({
      content: PROSE,
      links: ONE_LINK,
      format: "markdown",
    });

    expect(result.outcome).toBe("appended");
    expect(result.content.split(START)).toHaveLength(2);
    expect(result.content.split(END)).toHaveLength(2);
    expect(result.content).toContain("[Tamper sizes](/blog/tamper-sizes/)");
  });

  it("leaves the user's text byte-identical as the result's prefix", () => {
    const result = mergeRelatedBlock({
      content: PROSE,
      links: ONE_LINK,
      format: "markdown",
    });

    expect(result.content.startsWith(PROSE)).toBe(true);
    // And nothing of ours landed before the delimiter.
    expect(result.content.slice(0, result.content.indexOf(START))).toBe(
      `${PROSE}\n\n`,
    );
  });

  it("does not double the separator on content that already ends in a newline", () => {
    const result = mergeRelatedBlock({
      content: `${PROSE}\n`,
      links: ONE_LINK,
      format: "markdown",
    });

    expect(result.content.startsWith(`${PROSE}\n\n${START}`)).toBe(true);
  });

  it("appends nothing when there are no links and no block", () => {
    const result = mergeRelatedBlock({
      content: PROSE,
      links: [],
      format: "markdown",
    });

    expect(result.outcome).toBe("unchanged");
    expect(result.content).toBe(PROSE);
  });
});

describe("mergeRelatedBlock — idempotency", () => {
  it("injecting twice leaves one block and identical bytes", () => {
    const once = mergeRelatedBlock({
      content: PROSE,
      links: ONE_LINK,
      format: "markdown",
    });
    const twice = mergeRelatedBlock({
      content: once.content,
      links: ONE_LINK,
      format: "markdown",
    });

    expect(twice.outcome).toBe("unchanged");
    expect(twice.content).toBe(once.content);
    expect(twice.content.split(START)).toHaveLength(2);
  });

  it("re-running with a differently-slashed path does not add a second copy", () => {
    const once = mergeRelatedBlock({
      content: PROSE,
      links: ONE_LINK,
      format: "markdown",
    });
    const twice = mergeRelatedBlock({
      content: once.content,
      links: [{ path: "/blog/tamper-sizes", title: "Tamper sizes" }],
      format: "markdown",
    });

    expect(twice.links).toHaveLength(1);
  });

  it("survives ten injections of the same link without growing", () => {
    let content = PROSE;
    for (let run = 0; run < 10; run++) {
      content = mergeRelatedBlock({
        content,
        links: ONE_LINK,
        format: "html",
      }).content;
    }

    expect(content.split(START)).toHaveLength(2);
    expect(content.split("<li>")).toHaveLength(2);
  });
});

describe("mergeRelatedBlock — replacing", () => {
  it("changes only the span between the delimiters", () => {
    const before = "Intro paragraph.\n\n";
    const after = "\n\nA closing thought the user wrote by hand.\n";
    const seeded = mergeRelatedBlock({
      content: `${before}${START}${END}${after}`,
      links: ONE_LINK,
      format: "html",
    });

    expect(seeded.outcome).toBe("replaced");
    expect(seeded.content.startsWith(before)).toBe(true);
    expect(seeded.content.endsWith(after)).toBe(true);
  });

  it("keeps links a previous publish injected and lists the newest first", () => {
    const first = mergeRelatedBlock({
      content: PROSE,
      links: [{ path: "/blog/one/", title: "One" }],
      format: "markdown",
    });
    const second = mergeRelatedBlock({
      content: first.content,
      links: [{ path: "/blog/two/", title: "Two" }],
      format: "markdown",
    });

    expect(second.links.map((link) => link.path)).toEqual([
      "/blog/two/",
      "/blog/one/",
    ]);
  });

  it("caps the block at five links, dropping the oldest", () => {
    let content = PROSE;
    for (const n of [1, 2, 3, 4, 5, 6]) {
      content = mergeRelatedBlock({
        content,
        links: [{ path: `/blog/post-${n}/`, title: `Post ${n}` }],
        format: "markdown",
      }).content;
    }

    expect(content).not.toContain("/blog/post-1/");
    expect(content).toContain("/blog/post-6/");
    expect(content.split("- [")).toHaveLength(6);
  });

  it("reads an HTML block back when writing markdown, so no live link is lost", () => {
    const html = mergeRelatedBlock({
      content: PROSE,
      links: [{ path: "/blog/legacy/", title: "Legacy" }],
      format: "html",
    });
    const markdown = mergeRelatedBlock({
      content: html.content,
      links: [{ path: "/blog/fresh/", title: "Fresh" }],
      format: "markdown",
    });

    expect(markdown.content).toContain("[Legacy](/blog/legacy/)");
    expect(markdown.content).toContain("[Fresh](/blog/fresh/)");
    expect(markdown.content).not.toContain("<a href=");
  });

  it("collapses a duplicated block into one, leaving the text between them", () => {
    const content = [
      "Top.",
      `${START}\n<p>old</p>\n${END}`,
      "Middle prose the user wrote.",
      `${START}\n<p>older</p>\n${END}`,
      "Bottom.",
    ].join("\n\n");

    const result = mergeRelatedBlock({
      content,
      links: ONE_LINK,
      format: "html",
    });

    expect(result.content.split(START)).toHaveLength(2);
    expect(result.content).toContain("Middle prose the user wrote.");
    expect(result.content).toContain("Top.");
    expect(result.content).toContain("Bottom.");
  });
});

describe("mergeRelatedBlock — damaged delimiters", () => {
  it("refuses to write when the end marker is missing", () => {
    const content = `${PROSE}\n\n${START}\n<p>half a block</p>\n`;
    const result = mergeRelatedBlock({
      content,
      links: ONE_LINK,
      format: "html",
    });

    expect(result.outcome).toBe("malformed");
    expect(result.content).toBe(content);
    expect(result.links).toEqual([]);
  });

  it("refuses to write when an end marker precedes any start", () => {
    const content = `${END}\n${PROSE}`;
    const result = mergeRelatedBlock({
      content,
      links: ONE_LINK,
      format: "html",
    });

    expect(result.outcome).toBe("malformed");
    expect(result.content).toBe(content);
  });

  it("refuses to write when a start is nested inside a block", () => {
    const content = `${START}\n${START}\n${END}`;
    const result = mergeRelatedBlock({
      content,
      links: ONE_LINK,
      format: "html",
    });

    expect(result.outcome).toBe("malformed");
    expect(result.content).toBe(content);
  });

  it("appends a fresh block after the user deleted the old one", () => {
    const injected = mergeRelatedBlock({
      content: PROSE,
      links: ONE_LINK,
      format: "markdown",
    });
    const deleted = injected.content.slice(0, injected.content.indexOf(START));
    const again = mergeRelatedBlock({
      content: deleted,
      links: ONE_LINK,
      format: "markdown",
    });

    expect(again.outcome).toBe("appended");
    expect(again.content.split(START)).toHaveLength(2);
  });
});

describe("mergeRelatedBlock — untrusted titles and paths", () => {
  it("strips comment syntax so a title cannot close the block early", () => {
    const result = mergeRelatedBlock({
      content: PROSE,
      links: [{ path: "/blog/x/", title: `Sneaky ${END} out` }],
      format: "markdown",
    });

    // The comment syntax is removed, not escaped — the residue is inert text
    // and the document still holds exactly one end marker, ours.
    expect(result.content.split(END)).toHaveLength(2);
    expect(result.content).toContain("Sneaky rankloop:related end out");
  });

  it("escapes HTML in titles and hrefs", () => {
    const result = mergeRelatedBlock({
      content: PROSE,
      links: [{ path: '/blog/a"b/', title: "Tools & <script>" }],
      format: "html",
    });

    expect(result.content).toContain("Tools &amp; &lt;script&gt;");
    expect(result.content).toContain('href="/blog/a&quot;b/"');
    expect(result.content).not.toContain("<script>");
  });

  it("escapes markdown brackets and parenthesised paths", () => {
    const result = mergeRelatedBlock({
      content: PROSE,
      links: [{ path: "/guide/(2026)/", title: "The [best] guide" }],
      format: "markdown",
    });

    expect(result.content).toContain(
      "- [The \\[best\\] guide](/guide/%282026%29/)",
    );
  });

  it("drops links whose title or path sanitizes to nothing", () => {
    const result = mergeRelatedBlock({
      content: PROSE,
      links: [
        { path: "/blog/keep/", title: "Keep" },
        { path: "/blog/drop/", title: "   " },
      ],
      format: "markdown",
    });

    expect(result.links).toEqual([{ path: "/blog/keep/", title: "Keep" }]);
  });
});
