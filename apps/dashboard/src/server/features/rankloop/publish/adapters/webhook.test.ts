import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebhookAdapterConfig } from "./config";
import { callAt, jsonBodyOf, recordedCalls } from "./fetchRecorder";
import type { FetchCall } from "./fetchRecorder";
import type { CreatePostInput, PublishHub } from "./types";
import {
  createWebhookAdapter,
  signEnvelope,
  testWebhookConnection,
} from "./webhook";

const config: WebhookAdapterConfig = {
  url: "https://hooks.example.com/rankloop",
  secret: "s3cr3t-per-project",
  siteUrl: "https://example.com",
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

function sentRequest(index = 0): FetchCall {
  return callAt(recordedCalls(fetchMock.mock.calls), index);
}

/** Lowercased on the way in, the way a receiving server sees them. */
function headerOf(name: string, index = 0): string {
  return sentRequest(index).headers[name.toLowerCase()] ?? "";
}

function rawBody(index = 0): string {
  const body = sentRequest(index).body;
  if (body === null) throw new Error("expected a request body");
  return body;
}

function parsedBody(index = 0): Record<string, unknown> {
  return jsonBodyOf(sentRequest(index));
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-01T09:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("signEnvelope", () => {
  it("is HMAC-SHA256 over timestamp.body, hex, tagged with its algorithm", async () => {
    const expected = createHmac("sha256", "s3cr3t-per-project")
      .update("1754038800.{}")
      .digest("hex");

    await expect(signEnvelope(config.secret, "1754038800", "{}")).resolves.toBe(
      `sha256=${expected}`,
    );
  });

  it("changes when the timestamp changes, so an envelope cannot be replayed", async () => {
    const first = await signEnvelope(config.secret, "1", "{}");
    const second = await signEnvelope(config.secret, "2", "{}");
    expect(first).not.toBe(second);
  });

  it("changes when the secret changes", async () => {
    const mine = await signEnvelope("a", "1", "{}");
    const theirs = await signEnvelope("b", "1", "{}");
    expect(mine).not.toBe(theirs);
  });
});

describe("Webhook adapter capabilities", () => {
  it("says links are delegated and the URL is computed", () => {
    expect(createWebhookAdapter(config).capabilities).toMatchObject({
      kind: "webhook",
      linkInjection: "delegated",
      publishedUrl: "computed",
      ownsDerivedArtifacts: false,
      contentFormat: "markdown",
    });
  });
});

describe("Webhook adapter createPost", () => {
  it("sends the article, its frontmatter, the hub and the links in one envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ url: "https://example.com/compare/aeropress-vs-v60/" }),
    );

    const result = await createWebhookAdapter(config).createPost(
      createInput({
        hub: { name: "Comparisons", path: "/compare/", ref: "hub-1" },
        links: [
          {
            fromPath: "/blog/tampers/",
            toPath: "/compare/aeropress-vs-v60/",
            anchor: "AeroPress vs V60",
          },
        ],
      }),
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://hooks.example.com/rankloop",
    );
    expect(sentRequest().method).toBe("POST");
    expect(parsedBody()).toEqual({
      event: "post.create",
      status: "draft",
      article: {
        slug: "aeropress-vs-v60",
        title: "AeroPress vs V60",
        description: "Which brewer suits which morning.",
        date: "2026-08-01",
        category: "Comparisons",
        keyword: "aeropress vs v60",
        path: "/compare/aeropress-vs-v60/",
        markdown: article.markdown,
      },
      frontmatter: {
        title: "AeroPress vs V60",
        description: "Which brewer suits which morning.",
        date: "2026-08-01",
        category: "Comparisons",
        keyword: "aeropress vs v60",
      },
      hub: { name: "Comparisons", path: "/compare/", ref: "hub-1" },
      links: [
        {
          fromPath: "/blog/tampers/",
          toPath: "/compare/aeropress-vs-v60/",
          anchor: "AeroPress vs V60",
        },
      ],
    });
    expect(result.urlConfidence).toBe("verified");
  });

  it("signs exactly the bytes it sends", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));

    await createWebhookAdapter(config).createPost(createInput());

    const timestamp = headerOf("X-Rankloop-Timestamp");
    const expected = createHmac("sha256", config.secret)
      .update(`${timestamp}.${rawBody()}`)
      .digest("hex");
    expect(headerOf("X-Rankloop-Signature")).toBe(`sha256=${expected}`);
    // 2026-08-01T09:00:00Z, in seconds — the receiver checks its age.
    expect(timestamp).toBe("1785574800");
    expect(headerOf("X-Rankloop-Event")).toBe("post.create");
  });

  it("never puts the secret in the request", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));

    await createWebhookAdapter(config).createPost(createInput());

    expect(rawBody()).not.toContain(config.secret);
    expect(JSON.stringify(sentRequest().headers)).not.toContain(config.secret);
  });

  it("computes the URL from the page type's path and marks it unverified", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ref: "cms-88" }));

    const result = await createWebhookAdapter(config).createPost(createInput());

    expect(result).toMatchObject({
      ref: "cms-88",
      url: "https://example.com/compare/aeropress-vs-v60/",
      urlConfidence: "unverified",
    });
    expect(result.notes.join(" ")).toContain("unverified until a crawl");
  });

  it("treats an acknowledgement with no body as a valid receipt", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 202 }));

    const result = await createWebhookAdapter(config).createPost(createInput());

    expect(result).toMatchObject({
      ref: "aeropress-vs-v60",
      urlConfidence: "unverified",
    });
  });

  it("says how many links it handed over, since it will not add them itself", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ url: "https://example.com/x/" }),
    );

    const result = await createWebhookAdapter(config).createPost(
      createInput({
        links: [
          { fromPath: "/a/", toPath: "/x/", anchor: "x" },
          { fromPath: "/b/", toPath: "/x/", anchor: "x" },
        ],
      }),
    );

    expect(result.notes).toContain(
      "Sent 2 links for your site to add. rankloop doesn't edit pages on this target.",
    );
  });

  it("maps a rejected signature to PUBLISH_AUTH_FAILED", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "bad sig" }, 403));

    await expect(
      createWebhookAdapter(config).createPost(createInput()),
    ).rejects.toMatchObject({ code: "PUBLISH_AUTH_FAILED" });
  });

  it("maps a 500 and a dead host to PUBLISH_UNREACHABLE", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));
    await expect(
      createWebhookAdapter(config).createPost(createInput()),
    ).rejects.toMatchObject({ code: "PUBLISH_UNREACHABLE" });

    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(
      createWebhookAdapter(config).createPost(createInput()),
    ).rejects.toMatchObject({ code: "PUBLISH_UNREACHABLE" });
  });
});

describe("Webhook adapter ensureHub", () => {
  it("asks the endpoint to ensure the hub and takes its answer", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        created: true,
        ref: "hub-1",
        url: "https://example.com/compare/",
      }),
    );

    const result = await createWebhookAdapter(config).ensureHub(hub);

    expect(headerOf("X-Rankloop-Event")).toBe("hub.ensure");
    expect(parsedBody()).toEqual({
      event: "hub.ensure",
      hub: {
        name: "Comparisons",
        path: "/compare/",
        slug: "compare",
        description: "Every head-to-head comparison on this site.",
      },
    });
    expect(result).toMatchObject({ ref: "hub-1", created: true, notes: [] });
  });

  it("says so when the endpoint did not answer whether it created the hub", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));

    const result = await createWebhookAdapter(config).ensureHub(hub);

    expect(result).toMatchObject({
      created: false,
      url: "https://example.com/compare/",
    });
    expect(result.notes.join(" ")).toContain("didn't say whether the hub");
  });
});

describe("Webhook adapter page editing", () => {
  it("has no page to read, which is why its links are delegated", async () => {
    await expect(
      createWebhookAdapter(config).getPost("/blog/tampers/"),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to pretend it edited a page", async () => {
    await expect(
      createWebhookAdapter(config).updatePost({
        ref: "x",
        path: "/blog/tampers/",
        body: "anything",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Webhook adapter testConnection", () => {
  it("sends the documented connection.test probe and takes any 200", async () => {
    // The settings help text names this event, its header and its emptiness,
    // because a receiver has to handle it before it has ever been written
    // against (S8a follow-up 3). Pinned here so the copy and the wire cannot
    // drift apart: a 200 with a body the probe never asked for still passes.
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await expect(testWebhookConnection(config)).resolves.toBeUndefined();

    expect(headerOf("X-Rankloop-Event")).toBe("connection.test");
    expect(parsedBody()).toEqual({ event: "connection.test" });
    expect(rawBody()).not.toContain("article");
  });
});
