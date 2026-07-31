/** Framework detection, one fixture layout per framework. The fixtures are
 * the starter conventions each framework actually ships, trimmed to the two
 * or three files detection reads. */

import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { detect, blogPathFor, contentModeOf } from "../src/detect.ts";

const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe("detect()", () => {
  it("reads Astro from the dependency list, not from a config file", () => {
    expect(detect(fixture("astro-app"))).toMatchObject({
      framework: "astro",
      label: "Astro",
      contentDir: "src/content/blog",
      mode: "markdown",
      blogPath: "blog",
    });
  });

  it("finds a Next.js content tree", () => {
    expect(detect(fixture("next-app"))).toMatchObject({
      framework: "next",
      contentDir: "src/content/blog",
      mode: "markdown",
    });
  });

  it("recognises Hugo from hugo.toml with no package.json at all", () => {
    expect(detect(fixture("hugo-site"))).toMatchObject({
      framework: "hugo",
      contentDir: "content/posts",
      mode: "markdown",
      // Hugo serves content/posts at /posts/, and the directory name is the
      // only evidence available offline.
      blogPath: "posts",
    });
  });

  it("recognises Eleventy and its src/ input directory", () => {
    expect(detect(fixture("eleventy-site"))).toMatchObject({
      framework: "eleventy",
      contentDir: "src/posts",
      mode: "markdown",
    });
  });

  it("falls back to plain markdown when nothing declares a framework", () => {
    expect(detect(fixture("plain-markdown"))).toMatchObject({
      framework: "markdown",
      label: "plain markdown",
      contentDir: "posts",
      mode: "markdown",
    });
  });

  it("detects html mode from <slug>/index.html post directories", () => {
    expect(detect(fixture("html-site"))).toMatchObject({
      framework: "markdown",
      contentDir: "blog",
      mode: "html",
    });
  });

  it("reports no content directory rather than guessing one that is empty", () => {
    expect(detect(fixture("astro-app/src/pages"))).toMatchObject({
      contentDir: null,
      mode: "markdown",
    });
  });
});

describe("contentModeOf()", () => {
  it("returns null for a directory holding no pages", () => {
    expect(contentModeOf(fixture("hugo-site/../nothing-here"))).toBeNull();
  });
});

describe("blogPathFor()", () => {
  it("keeps a directory name that reads like a URL path", () => {
    expect(blogPathFor("src/content/posts")).toBe("posts");
    expect(blogPathFor("_posts")).toBe("posts");
  });

  it("falls back to blog for a name no router would use", () => {
    expect(blogPathFor("src/content")).toBe("blog");
    expect(blogPathFor(null)).toBe("blog");
  });
});
