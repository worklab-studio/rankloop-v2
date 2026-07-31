import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";
import { detectMetaDescriptionField, WordPressClient } from "./wordpressClient";

const config = {
  baseUrl: "https://blog.example.com",
  username: "beans",
  applicationPassword: "abcd efgh ijkl mnop qrst uvwx",
};

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sentBody(callIndex: number): unknown {
  const body = fetchMock.mock.calls[callIndex]?.[1]?.body;
  if (typeof body !== "string") {
    throw new Error("expected a JSON string request body");
  }
  return JSON.parse(body);
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WordPressClient.testConnection", () => {
  it("probes the REST root without credentials, then users/me with them", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ namespaces: ["wp/v2"] }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1, name: "beans" }));

    await WordPressClient.testConnection(config);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://blog.example.com/wp-json/",
      expect.objectContaining({ method: "GET", headers: {} }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://blog.example.com/wp-json/wp/v2/users/me",
      expect.objectContaining({
        headers: {
          Authorization: `Basic ${btoa("beans:abcd efgh ijkl mnop qrst uvwx")}`,
        },
      }),
    );
  });

  it("maps a 401 from users/me to PUBLISH_AUTH_FAILED without echoing the password", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ namespaces: ["wp/v2"] }));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: "unauthorized" }, 401),
    );

    const error = await rejectionOf(WordPressClient.testConnection(config));

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "PUBLISH_AUTH_FAILED" });
    expect(String(error)).not.toContain(config.applicationPassword);
    expect(String(error)).not.toContain(config.username);
  });

  it("maps a network failure on the REST root to PUBLISH_UNREACHABLE", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(WordPressClient.testConnection(config)).rejects.toMatchObject({
      code: "PUBLISH_UNREACHABLE",
    });
  });

  it("treats a non-WordPress 404 root as PUBLISH_UNREACHABLE", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "no" }, 404));

    await expect(WordPressClient.testConnection(config)).rejects.toMatchObject({
      code: "PUBLISH_UNREACHABLE",
    });
  });
});

describe("WordPressClient.findPostBySlug", () => {
  it("requests the slug with context=edit and returns the raw title", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          id: 42,
          slug: "best-espresso-tampers",
          title: { raw: "Best Espresso Tampers", rendered: "Best…" },
          meta: { rank_math_description: "" },
        },
      ]),
    );

    const post = await WordPressClient.findPostBySlug(
      config,
      "best-espresso-tampers",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://blog.example.com/wp-json/wp/v2/posts?slug=best-espresso-tampers&context=edit",
      expect.anything(),
    );
    expect(post).toEqual({
      id: 42,
      slug: "best-espresso-tampers",
      title: "Best Espresso Tampers",
      metaDescriptionField: "rank_math_description",
      // Registered but empty — a field to write into, no value to pre-fill.
      metaDescription: null,
    });
  });

  it("carries the live description value when the detected field has one", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          id: 7,
          slug: "kettles",
          title: { rendered: "Kettles" },
          meta: { yoast_wpseo_metadesc: "Every kettle we tested." },
        },
      ]),
    );

    const post = await WordPressClient.findPostBySlug(config, "kettles");

    expect(post).toMatchObject({
      metaDescriptionField: "yoast_wpseo_metadesc",
      metaDescription: "Every kettle we tested.",
    });
  });

  it("returns null on a slug miss (empty result array)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));

    await expect(
      WordPressClient.findPostBySlug(config, "gone"),
    ).resolves.toBeNull();
  });
});

describe("detectMetaDescriptionField", () => {
  it("detects Yoast and Rank Math by key presence, even with empty values", () => {
    expect(detectMetaDescriptionField({ yoast_wpseo_metadesc: "" })).toBe(
      "yoast_wpseo_metadesc",
    );
    expect(detectMetaDescriptionField({ rank_math_description: "x" })).toBe(
      "rank_math_description",
    );
  });

  it("returns null for absent keys, PHP-empty-array meta, and non-objects", () => {
    expect(detectMetaDescriptionField({ footnotes: "" })).toBeNull();
    expect(detectMetaDescriptionField([])).toBeNull();
    expect(detectMetaDescriptionField(undefined)).toBeNull();
  });
});

describe("WordPressClient.updatePost", () => {
  it("writes the meta description through the detected field", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 42 }));

    const result = await WordPressClient.updatePost(config, {
      postId: 42,
      title: "New Title",
      metaDescription: "A better description.",
      metaDescriptionField: "yoast_wpseo_metadesc",
    });

    expect(result).toEqual({ metaDescriptionApplied: true });
    expect(sentBody(0)).toEqual({
      title: "New Title",
      meta: { yoast_wpseo_metadesc: "A better description." },
    });
  });

  it("silently skips the description when no field was detected, and says so", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 42 }));

    const result = await WordPressClient.updatePost(config, {
      postId: 42,
      title: "New Title",
      metaDescription: "A better description.",
      metaDescriptionField: null,
    });

    expect(result).toEqual({ metaDescriptionApplied: false });
    expect(sentBody(0)).toEqual({ title: "New Title" });
  });
});
