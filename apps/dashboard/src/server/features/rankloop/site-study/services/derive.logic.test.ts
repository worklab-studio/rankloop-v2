import { describe, expect, it } from "vitest";
import {
  derivePageKinds,
  invertInlinkCounts,
  isPostLikePath,
  urlToPath,
  type DeriveKindInput,
} from "./derive.logic";

function page(overrides: Partial<DeriveKindInput>): DeriveKindInput {
  return {
    path: "/somewhere",
    publishedAt: null,
    wordCount: 800,
    isIndexable: true,
    outlinkPaths: [],
    ...overrides,
  };
}

describe("isPostLikePath", () => {
  it("matches the common blog section shapes, but not the section index itself", () => {
    expect(isPostLikePath("/blog/how-to-x")).toBe(true);
    expect(isPostLikePath("/en/articles/deep-dive")).toBe(true);
    // /blog/ is the index page — a hub candidate, not a post.
    expect(isPostLikePath("/blog/")).toBe(false);
    expect(isPostLikePath("/blog")).toBe(false);
  });

  it("matches dated permalink shapes", () => {
    expect(isPostLikePath("/2024/05/launch-recap")).toBe(true);
    expect(isPostLikePath("/notes/2024-05-01-launch")).toBe(true);
    expect(isPostLikePath("/pricing")).toBe(false);
  });
});

describe("derivePageKinds", () => {
  it("classifies a page with publishedAt as a post regardless of path", () => {
    const kinds = derivePageKinds([
      page({ path: "/stories/x", publishedAt: "2026-05-01T00:00:00.000Z" }),
    ]);
    expect(kinds.get("/stories/x")).toBe("post");
  });

  it("puts non-indexable and utility paths in 'other', even blog-shaped ones", () => {
    const kinds = derivePageKinds([
      page({ path: "/blog/hidden-draft", isIndexable: false }),
      page({ path: "/tag/seo" }),
      page({ path: "/blog/page/2" }),
    ]);
    expect(kinds.get("/blog/hidden-draft")).toBe("other");
    expect(kinds.get("/tag/seo")).toBe("other");
    expect(kinds.get("/blog/page/2")).toBe("other");
  });

  it("recognizes a thin page fanning out to ≥8 distinct posts as a hub", () => {
    const posts = Array.from({ length: 8 }, (_, i) =>
      page({ path: `/blog/post-${i}` }),
    );
    const kinds = derivePageKinds([
      ...posts,
      page({
        path: "/blog",
        wordCount: 120,
        outlinkPaths: posts.map((p) => p.path),
      }),
    ]);
    expect(kinds.get("/blog")).toBe("hub");
  });

  it("keeps 'page' when the fan-out is 7 posts or the page is long-form", () => {
    const posts = Array.from({ length: 8 }, (_, i) =>
      page({ path: `/blog/post-${i}` }),
    );
    const kinds = derivePageKinds([
      ...posts,
      page({
        path: "/thin-but-narrow",
        wordCount: 120,
        outlinkPaths: posts.slice(0, 7).map((p) => p.path),
      }),
      page({
        path: "/long-form-roundup",
        wordCount: 500,
        outlinkPaths: posts.map((p) => p.path),
      }),
    ]);
    expect(kinds.get("/thin-but-narrow")).toBe("page");
    expect(kinds.get("/long-form-roundup")).toBe("page");
  });

  it("only counts outlinks that are posts in this run toward the hub rule", () => {
    // 8 outlinks, but only 2 targets are crawled posts — the rest are
    // unknown paths and must not manufacture a hub.
    const kinds = derivePageKinds([
      page({ path: "/blog/a" }),
      page({ path: "/blog/b" }),
      page({
        path: "/links",
        wordCount: 100,
        outlinkPaths: [
          "/blog/a",
          "/blog/b",
          "/x1",
          "/x2",
          "/x3",
          "/x4",
          "/x5",
          "/x6",
        ],
      }),
    ]);
    expect(kinds.get("/links")).toBe("page");
  });

  it("defaults everything else to 'page'", () => {
    const kinds = derivePageKinds([page({ path: "/pricing" })]);
    expect(kinds.get("/pricing")).toBe("page");
  });
});

describe("invertInlinkCounts", () => {
  it("counts distinct source pages per target and ignores self-links", () => {
    const counts = invertInlinkCounts([
      { path: "/a", outlinkPaths: ["/b", "/c", "/a"] },
      { path: "/b", outlinkPaths: ["/c"] },
      { path: "/c", outlinkPaths: [] },
    ]);
    expect(counts.get("/c")).toBe(2);
    expect(counts.get("/b")).toBe(1);
    // Self-link earns no inlink.
    expect(counts.get("/a")).toBeUndefined();
  });
});

describe("urlToPath", () => {
  it("extracts the pathname and tolerates malformed rows", () => {
    expect(urlToPath("https://acme.com/blog/x?utm=1#top")).toBe("/blog/x");
    expect(urlToPath("not a url")).toBe("not a url");
  });
});
