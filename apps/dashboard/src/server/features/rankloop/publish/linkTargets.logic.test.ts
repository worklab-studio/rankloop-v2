import { describe, expect, it } from "vitest";
import { pickLinkTargets, type LinkTargetCandidate } from "./linkTargets.logic";

function candidate(
  overrides: Partial<LinkTargetCandidate> &
    Pick<LinkTargetCandidate, "id" | "path">,
): LinkTargetCandidate {
  return {
    title: null,
    kind: "post",
    pageTypeId: null,
    ...overrides,
  };
}

const BASE = {
  pageTypeId: "type-comparisons",
  keyword: "espresso tamper sizes",
  selfPath: "/blog/espresso-tamper-sizes/",
  hubContentPageId: "page-hub",
};

describe("pickLinkTargets", () => {
  it("returns at most three targets", () => {
    const candidates = [1, 2, 3, 4, 5].map((n) =>
      candidate({
        id: `page-${n}`,
        path: `/blog/espresso-${n}/`,
        pageTypeId: "type-comparisons",
      }),
    );

    expect(pickLinkTargets({ ...BASE, candidates })).toHaveLength(3);
  });

  it("puts every same-page-type neighbour ahead of any token match", () => {
    const candidates = [
      candidate({
        id: "page-tokens",
        // Three shared tokens and nothing else.
        path: "/blog/espresso-tamper-sizes-guide/",
        pageTypeId: "type-guides",
      }),
      candidate({
        id: "page-family",
        path: "/blog/grinder-burrs/",
        title: "Grinder burrs",
        pageTypeId: "type-comparisons",
      }),
    ];

    expect(
      pickLinkTargets({ ...BASE, candidates }).map((t) => t.contentPageId),
    ).toEqual(["page-family", "page-tokens"]);
  });

  it("excludes the page type's hub", () => {
    const candidates = [
      candidate({
        id: "page-hub",
        path: "/blog/comparisons/",
        pageTypeId: "type-comparisons",
      }),
      candidate({
        id: "page-sibling",
        path: "/blog/tamper-bases/",
        pageTypeId: "type-comparisons",
      }),
    ];

    expect(
      pickLinkTargets({ ...BASE, candidates }).map((t) => t.contentPageId),
    ).toEqual(["page-sibling"]);
  });

  it("excludes the article's own freshly-written manifest row", () => {
    const candidates = [
      candidate({
        id: "page-self",
        path: "/blog/espresso-tamper-sizes/",
        pageTypeId: "type-comparisons",
      }),
      candidate({
        id: "page-other",
        path: "/blog/tamper-bases/",
        pageTypeId: "type-comparisons",
      }),
    ];

    expect(
      pickLinkTargets({ ...BASE, candidates }).map((t) => t.contentPageId),
    ).toEqual(["page-other"]);
  });

  it("treats a trailing-slash difference as the same page, not a neighbour", () => {
    const candidates = [
      candidate({
        id: "page-self",
        path: "/blog/espresso-tamper-sizes",
        pageTypeId: "type-comparisons",
      }),
    ];

    expect(pickLinkTargets({ ...BASE, candidates })).toEqual([]);
  });

  it("keeps only posts — hubs and utility pages are link chrome already", () => {
    const candidates = [
      candidate({
        id: "page-about",
        path: "/about/",
        kind: "page",
        pageTypeId: "type-comparisons",
      }),
      candidate({
        id: "page-hub-kind",
        path: "/blog/comparisons/",
        kind: "hub",
        pageTypeId: "type-comparisons",
      }),
      candidate({
        id: "page-post",
        path: "/blog/tamper-bases/",
        pageTypeId: "type-comparisons",
      }),
    ];

    expect(
      pickLinkTargets({ ...BASE, candidates }).map((t) => t.contentPageId),
    ).toEqual(["page-post"]);
  });

  it("returns fewer than three rather than padding with unrelated posts", () => {
    const candidates = [
      candidate({ id: "page-a", path: "/blog/espresso-basics/" }),
      candidate({ id: "page-b", path: "/blog/tax-deadlines/" }),
      candidate({ id: "page-c", path: "/blog/office-chairs/" }),
    ];

    expect(
      pickLinkTargets({ ...BASE, candidates }).map((t) => t.contentPageId),
    ).toEqual(["page-a"]);
  });

  it("returns nothing when no candidate is related at all", () => {
    const candidates = [
      candidate({ id: "page-b", path: "/blog/tax-deadlines/" }),
    ];

    expect(pickLinkTargets({ ...BASE, candidates })).toEqual([]);
  });

  it("matches on the title as well as the slug", () => {
    const candidates = [
      candidate({
        id: "page-titled",
        path: "/blog/2026-04-19/",
        title: "Choosing a tamper",
      }),
    ];

    expect(
      pickLinkTargets({ ...BASE, candidates }).map((t) => t.contentPageId),
    ).toEqual(["page-titled"]);
  });

  it("ignores leading path segments, which are site chrome on both sides", () => {
    const candidates = [
      // Shares "espresso" only in a leading segment; the slug itself is
      // unrelated. Counting it would make every post under /espresso/ a
      // neighbour of every other.
      candidate({ id: "page-chrome", path: "/espresso/tax-deadlines/" }),
    ];

    expect(pickLinkTargets({ ...BASE, candidates })).toEqual([]);
  });

  it("ignores tokens shorter than three characters", () => {
    const candidates = [
      candidate({ id: "page-short", path: "/blog/an-ok-x/" }),
    ];

    expect(
      pickLinkTargets({
        ...BASE,
        keyword: "an ok x",
        selfPath: "/blog/an-ok-x-guide/",
        candidates,
      }),
    ).toEqual([]);
  });

  it("breaks ties on path so a resumed run picks the same three", () => {
    const candidates = [
      candidate({
        id: "page-c",
        path: "/blog/c-espresso/",
        pageTypeId: "type-comparisons",
      }),
      candidate({
        id: "page-a",
        path: "/blog/a-espresso/",
        pageTypeId: "type-comparisons",
      }),
      candidate({
        id: "page-b",
        path: "/blog/b-espresso/",
        pageTypeId: "type-comparisons",
      }),
    ];

    const first = pickLinkTargets({ ...BASE, candidates });
    const second = pickLinkTargets({
      ...BASE,
      candidates: candidates.toReversed(),
    });

    expect(first.map((t) => t.contentPageId)).toEqual([
      "page-a",
      "page-b",
      "page-c",
    ]);
    expect(second).toEqual(first);
  });

  it("falls back to token matching when the article has no page type", () => {
    const candidates = [
      candidate({
        id: "page-family",
        path: "/blog/unrelated/",
        pageTypeId: "type-comparisons",
      }),
      candidate({ id: "page-tokens", path: "/blog/tamper-guide/" }),
    ];

    expect(
      pickLinkTargets({ ...BASE, pageTypeId: null, candidates }).map(
        (t) => t.contentPageId,
      ),
    ).toEqual(["page-tokens"]);
  });

  it("uses the path as the label when the manifest has no title", () => {
    const candidates = [
      candidate({
        id: "page-a",
        path: "/blog/tamper-bases/",
        pageTypeId: "type-comparisons",
      }),
    ];

    expect(pickLinkTargets({ ...BASE, candidates })).toEqual([
      {
        contentPageId: "page-a",
        path: "/blog/tamper-bases/",
        title: "/blog/tamper-bases/",
      },
    ]);
  });
});
