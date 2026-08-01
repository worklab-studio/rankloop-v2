import { frontmatter } from "@rankloop/engine";
import { AppError } from "@/server/lib/errors";
import type { WebhookAdapterConfig } from "./config";
import { absoluteUrl } from "./paths.logic";
import type {
  AdapterNote,
  CreatePostInput,
  CreatedPost,
  EnsuredHub,
  ExistingPost,
  OwnedBlockUpdate,
  PublishAdapter,
  PublishCapabilities,
  PublishHub,
} from "./types";

// The webhook target: for a site rankloop has no business logging into.
//
// Everything rankloop knows goes out as one signed JSON envelope and the
// receiving site decides what to do with it. That means this adapter cannot
// keep the promises the other two keep by construction, so it states the
// difference instead of hiding it:
//
//   * link injection is delegated — the envelope carries the links, and the
//     site applies them. rankloop never sees, and so never edits, the page;
//   * the published URL is whatever the endpoint answers with. When it
//     answers with nothing, rankloop computes the URL from the page type's
//     urlPattern and marks it unverified, because a URL we made up is not
//     evidence that a page exists.

export const webhookCapabilities: PublishCapabilities = {
  kind: "webhook",
  label: "your publish endpoint",
  // The envelope carries the status; whether the receiver honours it is the
  // receiver's business, and rankloop does not claim otherwise.
  supportsDraft: true,
  createsHubs: true,
  linkInjection: "delegated",
  ownsDerivedArtifacts: false,
  publishedUrl: "computed",
  contentFormat: "markdown",
};

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

// Exported because the daily digest goes out over the same wire format
// (spec 0025): one receiver, one signature check, one set of header names. A
// second sender that spelled these itself would be one rename away from
// silently sending envelopes nobody verifies.
export const SIGNATURE_HEADER = "X-Rankloop-Signature";
export const TIMESTAMP_HEADER = "X-Rankloop-Timestamp";
export const EVENT_HEADER = "X-Rankloop-Event";

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * HMAC-SHA256 over `${timestamp}.${body}`, hex, prefixed with its algorithm.
 *
 * The timestamp is inside the signed string, not just beside it: signing the
 * body alone would let anyone who captured one envelope replay it forever,
 * and a receiver that checks the age of the timestamp has nothing to trust if
 * the timestamp is not covered. Prefixing the algorithm leaves room to add a
 * second one later without breaking the receivers written against this one.
 */
export async function signEnvelope(
  secret: string,
  timestamp: string,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  return `sha256=${toHex(signature)}`;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** What a receiver may answer with. Every field is optional: an endpoint that
 *  returns 200 and an empty body is a valid receiver, it just gets less
 *  confidence back from us. */
type WebhookReply = {
  url?: string;
  ref?: string;
  created?: boolean;
};

function readReply(payload: unknown): WebhookReply {
  if (typeof payload !== "object" || payload === null) return {};
  const record: Record<string, unknown> = { ...payload };
  return {
    url: typeof record.url === "string" ? record.url : undefined,
    ref: typeof record.ref === "string" ? record.ref : undefined,
    created: typeof record.created === "boolean" ? record.created : undefined,
  };
}

/** One POST, signed. The secret is used and never travels or gets logged —
 *  error messages here carry a status code and nothing else. */
async function post(
  config: WebhookAdapterConfig,
  event: string,
  envelope: unknown,
): Promise<WebhookReply> {
  // Signed over exactly the bytes that go out: serialize once, sign that
  // string, send that string. Re-stringifying for the request would risk
  // signing a document the receiver never saw.
  const body = JSON.stringify(envelope);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signEnvelope(config.secret, timestamp, body);

  let response: Response;
  try {
    response = await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [EVENT_HEADER]: event,
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: signature,
      },
      body,
    });
  } catch {
    throw new AppError(
      "PUBLISH_UNREACHABLE",
      "Could not reach your publish endpoint.",
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new AppError(
      "PUBLISH_AUTH_FAILED",
      `Your publish endpoint rejected the signature (${response.status}).`,
    );
  }
  if (!response.ok) {
    throw new AppError(
      "PUBLISH_UNREACHABLE",
      `Your publish endpoint returned ${response.status}.`,
    );
  }
  try {
    return readReply(await response.json());
  } catch {
    // A receiver that acknowledges with an empty body is doing nothing
    // wrong; it just leaves us computing the URL ourselves.
    return {};
  }
}

/**
 * The connection probe.
 *
 * This target has nothing readable — there is no page to GET and no session to
 * validate — so the probe is the smallest signed envelope the endpoint will
 * ever see: an event that carries no article and asks for nothing. A receiver
 * that does not recognise it can answer 200 and ignore it, which is exactly
 * what "the URL is right and the signature verifies" looks like.
 */
export async function testWebhookConnection(
  config: WebhookAdapterConfig,
): Promise<void> {
  await post(config, "connection.test", { event: "connection.test" });
}

export function createWebhookAdapter(
  config: WebhookAdapterConfig,
): PublishAdapter {
  async function ensureHub(hub: PublishHub): Promise<EnsuredHub> {
    const reply = await post(config, "hub.ensure", {
      event: "hub.ensure",
      hub: {
        name: hub.name,
        path: hub.path,
        slug: hub.slug,
        description: hub.description,
      },
    });
    const notes: AdapterNote[] = [];
    if (reply.created === undefined) {
      notes.push(
        "Your endpoint didn't say whether the hub already existed, so rankloop assumed it did.",
      );
    }
    return {
      ref: reply.ref ?? hub.slug,
      path: hub.path,
      url: reply.url ?? absoluteUrl(config.siteUrl, hub.path),
      created: reply.created ?? false,
      notes,
    };
  }

  async function createPost(input: CreatePostInput): Promise<CreatedPost> {
    const { article } = input;
    const [meta] = frontmatter(article.markdown);
    const reply = await post(config, "post.create", {
      event: "post.create",
      status: config.defaultPostStatus,
      article: {
        slug: article.slug,
        title: article.title,
        description: article.description,
        date: article.date,
        category: article.category,
        keyword: article.keyword,
        path: article.path,
        markdown: article.markdown,
      },
      // The parsed frontmatter travels beside the markdown so a receiver can
      // map fields without implementing the engine's parser.
      frontmatter: meta,
      hub: input.hub,
      // Delegated link injection (rule 2 still holds — the site owns the
      // edit): what to link, from where, with which anchor.
      links: input.links,
    });

    const notes: AdapterNote[] = [];
    if (!reply.url) {
      notes.push(
        "Your endpoint didn't return a URL, so this one is computed from the page type's URL pattern. It's unverified until a crawl finds the page.",
      );
    }
    if (input.links.length > 0) {
      notes.push(
        `Sent ${input.links.length} link${input.links.length === 1 ? "" : "s"} for your site to add. rankloop doesn't edit pages on this target.`,
      );
    }
    return {
      ref: reply.ref ?? article.slug,
      url: reply.url ?? absoluteUrl(config.siteUrl, article.path),
      urlConfidence: reply.url ? "verified" : "unverified",
      notes,
    };
  }

  return {
    capabilities: webhookCapabilities,
    ensureHub,
    createPost,
    getPost,
    updatePost,
  };
}

/** Nothing to read: this target never hands rankloop a page body, which is
 *  the whole reason its link injection is delegated. */
async function getPost(): Promise<ExistingPost | null> {
  return null;
}

async function updatePost(update: OwnedBlockUpdate): Promise<void> {
  // Reachable only from a caller that ignored `capabilities.linkInjection`.
  // Failing loudly beats a silent no-op that would report links as injected.
  throw new AppError(
    "VALIDATION_ERROR",
    `A webhook target applies its own links; rankloop can't edit ${update.path}.`,
  );
}
