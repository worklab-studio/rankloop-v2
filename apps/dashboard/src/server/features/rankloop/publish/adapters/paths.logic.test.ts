import { describe, expect, it } from "vitest";
import {
  absoluteUrl,
  hubPathFromUrlPattern,
  normalizePath,
  pathFromUrlPattern,
  repoPathFor,
  slugFromPath,
} from "./paths.logic";

describe("pathFromUrlPattern", () => {
  it("substitutes the slug token the planner emits", () => {
    expect(pathFromUrlPattern("/compare/{slug}/", "aeropress-vs-v60")).toBe(
      "/compare/aeropress-vs-v60/",
    );
  });

  it("appends the slug when a hand-edited pattern lost its token", () => {
    expect(pathFromUrlPattern("/blog", "tampers")).toBe("/blog/tampers/");
  });

  it("puts a page type with no pattern at the site root", () => {
    expect(pathFromUrlPattern(null, "tampers")).toBe("/tampers/");
  });

  it("never emits a double slash", () => {
    expect(pathFromUrlPattern("//best//{slug}//", "kettles")).toBe(
      "/best/kettles/",
    );
  });
});

describe("hubPathFromUrlPattern", () => {
  it("drops the slug segment", () => {
    expect(hubPathFromUrlPattern("/compare/{slug}/")).toBe("/compare/");
    expect(hubPathFromUrlPattern("/guides/how-to/{slug}/")).toBe(
      "/guides/how-to/",
    );
  });

  it("has no hub to offer when the pattern is only a slug", () => {
    expect(hubPathFromUrlPattern("/{slug}/")).toBeNull();
  });

  it("has no hub to offer when the pattern has no slug token", () => {
    expect(hubPathFromUrlPattern("/blog/")).toBeNull();
    expect(hubPathFromUrlPattern(null)).toBeNull();
  });
});

describe("repoPathFor", () => {
  it("mirrors the URL structure under the content root", () => {
    expect(repoPathFor("content", "/compare/aeropress-vs-v60/", "post")).toBe(
      "content/compare/aeropress-vs-v60.md",
    );
  });

  it("files a hub as that directory's index, the stem the engine skips", () => {
    expect(repoPathFor("content", "/compare/", "hub")).toBe(
      "content/compare/index.md",
    );
  });

  it("tolerates a content root written with slashes", () => {
    expect(repoPathFor("/src/content/", "/blog/kettles/", "post")).toBe(
      "src/content/blog/kettles.md",
    );
  });

  it("drops the prefix entirely when the repo root is the content root", () => {
    expect(repoPathFor("", "/blog/kettles/", "post")).toBe("blog/kettles.md");
  });
});

describe("slugFromPath and absoluteUrl", () => {
  it("reads the last segment as the slug", () => {
    expect(slugFromPath("/compare/aeropress-vs-v60/")).toBe("aeropress-vs-v60");
    expect(slugFromPath("/")).toBe("");
  });

  it("joins a site root and a path without doubling the slash", () => {
    expect(absoluteUrl("https://example.com/", "/blog/kettles/")).toBe(
      "https://example.com/blog/kettles/",
    );
    expect(absoluteUrl("https://example.com", "blog/kettles")).toBe(
      "https://example.com/blog/kettles/",
    );
  });
});

describe("normalizePath", () => {
  it("guarantees one leading and one trailing slash", () => {
    expect(normalizePath("blog/kettles")).toBe("/blog/kettles/");
    expect(normalizePath("/blog/kettles/")).toBe("/blog/kettles/");
  });
});
