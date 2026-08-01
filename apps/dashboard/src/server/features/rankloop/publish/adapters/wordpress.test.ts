import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WordPressAdapterConfig } from "./config";
import { callAt, jsonBodyOf, recordedCalls } from "./fetchRecorder";
import type { FetchCall } from "./fetchRecorder";
import type { CreatePostInput, PublishHub } from "./types";
import { createWordPressAdapter } from "./wordpress";

const config: WordPressAdapterConfig = {
  baseUrl: "https://blog.example.com",
  username: "beans",
  applicationPassword: "abcd efgh ijkl mnop",
  defaultPostStatus: "draft",
  linkInjection: true,
};

const article = {
  slug: "aeropress-vs-v60",
  title: "AeroPress vs V60",
  description: "Which brewer suits which morning.",
  date: "2026-08-01",
  category: "Comparisons",
  keyword: "aeropress vs v60",
  path: "/compare/aeropress-vs-v60/",
  markdown: [
    "---",
    "title: AeroPress vs V60",
    "description: Which brewer suits which morning.",
    "date: 2026-08-01",
    "category: Comparisons",
    "keyword: aeropress vs v60",
    "---",
    "",
    "Both brewers make a clean cup.",
    "",
    "## Body and clarity",
    "",
    "The V60 runs faster.",
  ].join("\n"),
};

const hub: PublishHub = {
  name: "Comparisons",
  path: "/compare/",
  slug: "compare",
  description: "Every head-to-head comparison on this site.",
};

function createInput(
  overrides: Partial<CreatePostInput> = {},
): CreatePostInput {
  return { article, hub: null, links: [], ...overrides };
}

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function calls(): FetchCall[] {
  return recordedCalls(fetchMock.mock.calls);
}

function callUrl(index: number): string {
  return callAt(calls(), index).url;
}

function sentBody(index: number): Record<string, unknown> {
  return jsonBodyOf(callAt(calls(), index));
}

/** categories lookup -> post create -> meta write, the happy path order. */
function mockSuccessfulCreate(
  options: { categoryFound?: boolean; metaField?: string | null } = {},
) {
  fetchMock.mockResolvedValueOnce(
    jsonResponse(
      options.categoryFound === false
        ? []
        : [{ id: 5, name: "Comparisons", slug: "comparisons" }],
    ),
  );
  fetchMock.mockResolvedValueOnce(
    jsonResponse({
      id: 99,
      link: "https://blog.example.com/compare/aeropress-vs-v60/",
      meta:
        options.metaField === null
          ? {}
          : { [options.metaField ?? "yoast_wpseo_metadesc"]: "" },
    }),
  );
  fetchMock.mockResolvedValueOnce(jsonResponse({ id: 99 }));
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WordPress adapter capabilities", () => {
  it("says WordPress keeps its own sitemap and returns its own URLs", () => {
    const adapter = createWordPressAdapter(config);
    expect(adapter.capabilities).toMatchObject({
      kind: "wordpress",
      ownsDerivedArtifacts: false,
      publishedUrl: "returned",
      contentFormat: "html",
      linkInjection: "edits-pages",
    });
  });
});

describe("WordPress adapter ensureHub", () => {
  it("creates the hub as a page, not a post, when it is missing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 12, link: "https://blog.example.com/compare/" }),
    );

    const result = await createWordPressAdapter(config).ensureHub(hub);

    expect(callUrl(0)).toBe(
      "https://blog.example.com/wp-json/wp/v2/pages?slug=compare&context=edit",
    );
    expect(callUrl(1)).toBe("https://blog.example.com/wp-json/wp/v2/pages");
    expect(sentBody(1)).toEqual({
      title: "Comparisons",
      slug: "compare",
      content: "<p>Every head-to-head comparison on this site.</p>",
      status: "draft",
    });
    expect(result).toMatchObject({ ref: "12", created: true });
  });

  it("leaves an existing hub alone", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([{ id: 12, link: "https://blog.example.com/compare/" }]),
    );

    const result = await createWordPressAdapter(config).ensureHub(hub);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ref: "12", created: false, notes: [] });
  });

  it("creates the hub before the instance when both run", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 12, link: "https://blog.example.com/compare/" }),
    );
    mockSuccessfulCreate();

    const adapter = createWordPressAdapter(config);
    await adapter.ensureHub(hub);
    await adapter.createPost(createInput());

    const pageCreate = calls().findIndex(
      (call) => call.url.endsWith("/wp/v2/pages") && call.method === "POST",
    );
    const postCreate = calls().findIndex((call) =>
      call.url.endsWith("/wp/v2/posts"),
    );
    expect(pageCreate).toBeGreaterThanOrEqual(0);
    expect(pageCreate).toBeLessThan(postCreate);
  });
});

describe("WordPress adapter createPost", () => {
  it("posts the rendered article as a draft and reports WordPress's own URL", async () => {
    mockSuccessfulCreate();

    const result =
      await createWordPressAdapter(config).createPost(createInput());

    expect(callUrl(1)).toBe("https://blog.example.com/wp-json/wp/v2/posts");
    expect(sentBody(1)).toEqual({
      title: "AeroPress vs V60",
      slug: "aeropress-vs-v60",
      content:
        "<p>Both brewers make a clean cup.</p>\n\n<h2>Body and clarity</h2>\n\n<p>The V60 runs faster.</p>",
      excerpt: "Which brewer suits which morning.",
      status: "draft",
      categories: [5],
    });
    expect(result).toMatchObject({
      ref: "99",
      url: "https://blog.example.com/compare/aeropress-vs-v60/",
      urlConfidence: "verified",
    });
    expect(result.notes).toContain(
      "The post is a draft. Publish it in WordPress when it reads right.",
    );
  });

  it("publishes outright when the project asked for that, and says nothing about drafts", async () => {
    mockSuccessfulCreate();

    const result = await createWordPressAdapter({
      ...config,
      defaultPostStatus: "publish",
    }).createPost(createInput());

    expect(sentBody(1)).toMatchObject({ status: "publish" });
    expect(result.notes.join(" ")).not.toContain("draft");
  });

  it("skips a category that does not exist instead of creating one", async () => {
    mockSuccessfulCreate({ categoryFound: false });

    const result =
      await createWordPressAdapter(config).createPost(createInput());

    // The create body carries no `categories` key at all: sending an empty
    // array would strip whatever WordPress assigns by default.
    expect(sentBody(1)).not.toHaveProperty("categories");
    expect(result.notes).toContain(
      "The \"Comparisons\" category doesn't exist in WordPress, so the post kept your site's default. rankloop never creates categories.",
    );
    expect(
      calls().some(
        (call) =>
          call.url.includes("/wp/v2/categories") && call.method === "POST",
      ),
    ).toBe(false);
  });

  it("refuses a fuzzy category match", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        { id: 7, name: "Comparison guides", slug: "comparison-guides" },
      ]),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 99, link: "https://blog.example.com/x/", meta: {} }),
    );

    const result =
      await createWordPressAdapter(config).createPost(createInput());

    expect(sentBody(1)).not.toHaveProperty("categories");
    expect(result.notes.join(" ")).toContain("doesn't exist in WordPress");
  });

  it("writes the meta description through the field the create response revealed", async () => {
    mockSuccessfulCreate({ metaField: "rank_math_description" });

    await createWordPressAdapter(config).createPost(createInput());

    expect(callUrl(2)).toBe("https://blog.example.com/wp-json/wp/v2/posts/99");
    expect(sentBody(2)).toEqual({
      title: "AeroPress vs V60",
      meta: { rank_math_description: "Which brewer suits which morning." },
    });
  });

  it("says so and stops when no SEO plugin field is writable", async () => {
    mockSuccessfulCreate({ metaField: null });

    const result =
      await createWordPressAdapter(config).createPost(createInput());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.notes).toContain(
      "No SEO plugin field for the meta description, so WordPress kept its own excerpt.",
    );
  });

  it("maps a 401 to PUBLISH_AUTH_FAILED without echoing the password", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: "unauthorized" }, 401),
    );

    const error = await createWordPressAdapter(config)
      .createPost(createInput())
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "PUBLISH_AUTH_FAILED" });
    expect(String(error)).not.toContain(config.applicationPassword);
  });

  it("maps an unreachable site to PUBLISH_UNREACHABLE", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(
      createWordPressAdapter(config).createPost(createInput()),
    ).rejects.toMatchObject({ code: "PUBLISH_UNREACHABLE" });
  });
});

describe("WordPress adapter getPost and updatePost", () => {
  it("reads the raw body so the owned block can be merged into it", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          id: 42,
          link: "https://blog.example.com/blog/tampers/",
          content: { raw: "<p>Ours.</p>", rendered: "<p>Rendered.</p>" },
        },
      ]),
    );

    const post = await createWordPressAdapter(config).getPost("/blog/tampers/");

    expect(callUrl(0)).toBe(
      "https://blog.example.com/wp-json/wp/v2/posts?slug=tampers&context=edit",
    );
    expect(post).toEqual({
      ref: "42",
      path: "/blog/tampers/",
      body: "<p>Ours.</p>",
    });
  });

  it("declines to link-inject a site that hides content.raw", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([{ id: 42, link: "https://x/", content: {} }]),
    );

    await expect(
      createWordPressAdapter(config).getPost("/blog/tampers/"),
    ).resolves.toBeNull();
  });

  it("never hands back a render as if it were the source", async () => {
    // The shape a hardened site actually returns: context=edit answered, but
    // filtered back down to the render. Merging into that and writing it back
    // would replace the user's shortcodes and block comments with their own
    // one-time expansion, on a live post, silently.
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          id: 42,
          link: "https://x/",
          content: { rendered: "<p>Expanded gallery.</p>" },
        },
      ]),
    );

    await expect(
      createWordPressAdapter(config).getPost("/blog/tampers/"),
    ).resolves.toBeNull();
    // Declining means declining: no write may follow the read.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("writes back only the body it was handed, and touches no other field", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 42 }));

    await createWordPressAdapter(config).updatePost({
      ref: "42",
      path: "/blog/tampers/",
      body: "<p>Ours.</p>\n<!-- rankloop:related start -->x<!-- rankloop:related end -->",
    });

    expect(callUrl(0)).toBe("https://blog.example.com/wp-json/wp/v2/posts/42");
    expect(Object.keys(sentBody(0))).toEqual(["content"]);
  });
});
