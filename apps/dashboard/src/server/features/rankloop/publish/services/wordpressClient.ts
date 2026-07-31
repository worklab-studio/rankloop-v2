import { z } from "zod";
import { AppError } from "@/server/lib/errors";

// The WordPress adapter (spec 0013): the least-dangerous write path. It only
// ever updates fields of an existing post — never creates, never deletes —
// and authenticates with an application password the user can revoke in
// WordPress at any time. Plain fetch against wp-json; no SDK, no logging.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Decrypted publish_connections config for the wordpress adapter. */
export type WordPressConfig = {
  baseUrl: string;
  username: string;
  applicationPassword: string;
};

// The SEO-plugin post-meta keys this client knows how to write a description
// into. Core WordPress has no meta-description field at all — it belongs to
// whichever plugin the site runs.
const META_DESCRIPTION_FIELDS = [
  "yoast_wpseo_metadesc",
  "rank_math_description",
] as const;

type MetaDescriptionField = (typeof META_DESCRIPTION_FIELDS)[number];

type WordPressPost = {
  id: number;
  slug: string;
  title: string;
  /** null when neither Yoast nor Rank Math exposes a writable description. */
  metaDescriptionField: MetaDescriptionField | null;
  /** The current live description from the detected field, when non-empty. */
  metaDescription: string | null;
};

type UpdatePostResult = {
  /** false = no writable SEO-plugin field was detected, so the description
   *  was silently skipped (the title still went through). */
  metaDescriptionApplied: boolean;
};

// context=edit responses carry title.raw; a hardened site may strip the edit
// context back down to rendered. Either serves as "the current title".
const postSchema = z.object({
  id: z.number().int(),
  slug: z.string(),
  title: z.object({
    raw: z.string().optional(),
    rendered: z.string().optional(),
  }),
  meta: z.unknown().optional(),
});

const postListSchema = z.array(postSchema);

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function basicAuth(config: WordPressConfig): string {
  return `Basic ${btoa(`${config.username}:${config.applicationPassword}`)}`;
}

/**
 * One place turns HTTP reality into AppError codes: 401/403 is
 * PUBLISH_AUTH_FAILED, everything else that isn't a 2xx JSON body is
 * PUBLISH_UNREACHABLE. Error detail is capped at path + status — the config
 * (and therefore the application password) must never leak into a message,
 * a log line, or a thrown error.
 */
async function wpFetch(
  config: WordPressConfig,
  path: string,
  init?: { method?: string; body?: unknown; authenticated?: boolean },
): Promise<unknown> {
  // Trailing slashes are normalized at save, but re-strip here so a hand-run
  // config can't produce "https://site.com//wp-json".
  const url = `${config.baseUrl.replace(/\/+$/, "")}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: init?.method ?? "GET",
      headers: {
        ...(init?.authenticated === false
          ? {}
          : { Authorization: basicAuth(config) }),
        ...(init?.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new AppError("PUBLISH_UNREACHABLE", `Could not reach ${path}.`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new AppError(
      "PUBLISH_AUTH_FAILED",
      `WordPress returned ${response.status} for ${path}.`,
    );
  }
  if (!response.ok) {
    throw new AppError(
      "PUBLISH_UNREACHABLE",
      `WordPress returned ${response.status} for ${path}.`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new AppError(
      "PUBLISH_UNREACHABLE",
      `Non-JSON response from ${path}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Meta-field detection
// ---------------------------------------------------------------------------

/**
 * Detection is key-presence in the post's REST `meta` map: a plugin that
 * registered its description field with `show_in_rest` lists the key even
 * when the value is empty, and a key that isn't listed isn't writable —
 * writing it blind would 400 the whole update, taking the title change down
 * with it. No key means the caller skips the description and reports it.
 */
export function detectMetaDescriptionField(
  meta: unknown,
): MetaDescriptionField | null {
  // WP serializes an empty meta map as [] (PHP array), not {} — treat any
  // non-plain-object as "no fields registered".
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    return null;
  }
  for (const field of META_DESCRIPTION_FIELDS) {
    if (field in meta) return field;
  }
  return null;
}

const metaRecordSchema = z.record(z.string(), z.unknown());

/** The detected field's current value — the editor pre-fills from it. */
function metaDescriptionValue(
  meta: unknown,
  field: MetaDescriptionField | null,
): string | null {
  if (field === null) return null;
  const parsed = metaRecordSchema.safeParse(meta);
  if (!parsed.success) return null;
  const value = parsed.data[field];
  return typeof value === "string" && value !== "" ? value : null;
}

// ---------------------------------------------------------------------------
// Client operations
// ---------------------------------------------------------------------------

/**
 * Two probes: the REST root proves the URL is a reachable WordPress site at
 * all (no credentials involved), then users/me proves the application
 * password actually authenticates. Splitting them keeps the failure stories
 * distinct — PUBLISH_UNREACHABLE vs PUBLISH_AUTH_FAILED.
 */
async function testConnection(config: WordPressConfig): Promise<void> {
  await wpFetch(config, "/wp-json/", { authenticated: false });
  await wpFetch(config, "/wp-json/wp/v2/users/me");
}

/** Authenticated with context=edit: that context is what exposes the post's
 *  registered `meta` map, where Yoast / Rank Math surface their fields. */
async function findPostBySlug(
  config: WordPressConfig,
  slug: string,
): Promise<WordPressPost | null> {
  const payload = await wpFetch(
    config,
    `/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&context=edit`,
  );
  const parsed = postListSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AppError(
      "PUBLISH_UNREACHABLE",
      "Unexpected response shape from /wp-json/wp/v2/posts.",
    );
  }
  const post = parsed.data[0];
  if (!post) return null;
  const metaDescriptionField = detectMetaDescriptionField(post.meta);
  return {
    id: post.id,
    slug: post.slug,
    title: post.title.raw ?? post.title.rendered ?? "",
    metaDescriptionField,
    metaDescription: metaDescriptionValue(post.meta, metaDescriptionField),
  };
}

/** Update title (always) and meta description (best-effort — only when a
 *  writable SEO-plugin field was detected on the post). */
async function updatePost(
  config: WordPressConfig,
  input: {
    postId: number;
    title: string;
    metaDescription?: string;
    metaDescriptionField: MetaDescriptionField | null;
  },
): Promise<UpdatePostResult> {
  const body: Record<string, unknown> = { title: input.title };
  let metaDescriptionApplied = false;
  if (
    input.metaDescription !== undefined &&
    input.metaDescriptionField !== null
  ) {
    body.meta = { [input.metaDescriptionField]: input.metaDescription };
    metaDescriptionApplied = true;
  }
  await wpFetch(config, `/wp-json/wp/v2/posts/${input.postId}`, {
    method: "POST",
    body,
  });
  return { metaDescriptionApplied };
}

export const WordPressClient = {
  testConnection,
  findPostBySlug,
  updatePost,
};
