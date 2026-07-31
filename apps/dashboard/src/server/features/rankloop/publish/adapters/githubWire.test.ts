import { defaultLaws } from "@rankloop/engine";
import type { EngineConfig } from "@rankloop/engine";
import { describe, expect, it, vi } from "vitest";
import { buildDerivedArtifacts, corpusFromManifest } from "./githubWire";
import type { WirePage } from "./githubWire";

const config: EngineConfig = {
  site: {
    url: "https://beans.coffee",
    name: "Beans",
    description: "Coffee, measured.",
    blogPath: "blog",
    mode: "markdown",
  },
  taxonomy: { Comparisons: "compare", Guides: "guides" },
  keywords: { positive: [], negative: [], classify: [] },
  laws: defaultLaws(),
};

const manifest: WirePage[] = [
  {
    path: "/blog/tampers/",
    title: "Tampers",
    description: "Every tamper we know of.",
    date: "2026-07-01",
    category: "Guides",
  },
  {
    path: "/blog/aeropress-vs-v60/",
    title: "AeroPress vs V60",
    description: "Which brewer suits which morning.",
    date: "2026-08-01",
    category: "Comparisons",
  },
];

function bodyFor(path: string): string {
  return `---\ntitle: x\n---\n\nBody of ${path}`;
}

describe("corpusFromManifest", () => {
  it("orders posts newest first, which is what every wire function assumes", () => {
    const { posts } = corpusFromManifest(config, manifest);
    expect(posts.map((post) => post.slug)).toEqual([
      "aeropress-vs-v60",
      "tampers",
    ]);
  });

  it("keeps pages outside the blog root out rather than inventing a URL for them", () => {
    const { posts, outsideBlogRoot } = corpusFromManifest(config, [
      ...manifest,
      {
        path: "/docs/api/",
        title: "API",
        description: "",
        date: "2026-06-01",
        category: "Guides",
      },
      {
        path: "/blog/",
        title: "Blog",
        description: "",
        date: "2026-06-01",
        category: "Guides",
      },
    ]);
    expect(posts).toHaveLength(2);
    expect(outsideBlogRoot.map((page) => page.path)).toEqual([
      "/docs/api/",
      "/blog/",
    ]);
  });
});

describe("buildDerivedArtifacts", () => {
  it("regenerates all four files from the manifest", async () => {
    const loadMarkdown = vi.fn(async (path: string) => bodyFor(path));

    const { artifacts } = await buildDerivedArtifacts({
      config,
      manifest,
      today: "2026-08-01",
      loadMarkdown,
    });

    expect(artifacts.map((artifact) => artifact.path)).toEqual([
      "/sitemap.xml",
      "/rss.xml",
      "/llms.txt",
      "/llms-full.txt",
    ]);
    const sitemap = artifacts[0].content;
    expect(sitemap).toContain(
      "<loc>https://beans.coffee/blog/aeropress-vs-v60/</loc>",
    );
    // Hubs come from the taxonomy, not from the manifest.
    expect(sitemap).toContain("<loc>https://beans.coffee/blog/compare/</loc>");
    expect(artifacts[2].content).toContain(
      "- [AeroPress vs V60](https://beans.coffee/blog/aeropress-vs-v60/)",
    );
    expect(artifacts[3].content).toContain("Body of /blog/tampers/");
    expect(loadMarkdown).toHaveBeenCalledWith("/blog/aeropress-vs-v60/");
  });

  it("notes the pages it left out of the sitemap", async () => {
    const { notes } = await buildDerivedArtifacts({
      config,
      manifest: [
        ...manifest,
        {
          path: "/docs/api/",
          title: "API",
          description: "",
          date: "2026-06-01",
          category: "Guides",
        },
      ],
      today: "2026-08-01",
      loadMarkdown: async (path) => bodyFor(path),
    });

    expect(notes.join(" ")).toContain("1 page sit");
    expect(notes.join(" ")).toContain("Your own build still owns those");
  });

  it("still writes llms-full.txt when a body has gone missing, and says how many", async () => {
    const { artifacts, notes } = await buildDerivedArtifacts({
      config,
      manifest,
      today: "2026-08-01",
      loadMarkdown: async (path) =>
        path === "/blog/tampers/" ? null : bodyFor(path),
    });

    expect(artifacts).toHaveLength(4);
    expect(notes.join(" ")).toContain("covers 1 of 2 posts");
  });

  it("skips llms-full.txt rather than spend a repo read per post on a big corpus", async () => {
    const big: WirePage[] = Array.from({ length: 301 }, (_value, index) => ({
      path: `/blog/post-${index}/`,
      title: `Post ${index}`,
      description: "",
      date: "2026-01-01",
      category: "Guides",
    }));
    const loadMarkdown = vi.fn(async () => "body");

    const { artifacts, notes } = await buildDerivedArtifacts({
      config,
      manifest: big,
      today: "2026-08-01",
      loadMarkdown,
    });

    expect(artifacts.map((artifact) => artifact.path)).toEqual([
      "/sitemap.xml",
      "/rss.xml",
      "/llms.txt",
    ]);
    expect(loadMarkdown).not.toHaveBeenCalled();
    expect(notes.join(" ")).toContain("llms-full.txt was skipped");
  });
});
