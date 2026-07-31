import { z } from "zod";
import { AppError } from "@/server/lib/errors";

// The WordPress client. It started (spec 0013) as the least-dangerous write
// path: only ever updating fields of an existing post, never creating, never
// deleting. Spec 0021 adds creation, because publishing an article is the one
// thing that has to make a page that was not there before — and nothing else
// widened. There is still no delete, no taxonomy creation, and no write to a
// user's prose outside the delimited block rankloop maintains.
//
// Authentication stays an application password the user can revoke in
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

// ---------------------------------------------------------------------------
// Creation (spec 0021)
// ---------------------------------------------------------------------------

/** WordPress post status. 'draft' is what a connection defaults to. */
type WordPressPostStatus = "draft" | "publish";

// A created object answers with more than the update path needed: `link` is
// the canonical URL WordPress itself resolved, which beats any URL we could
// compute from a permalink structure we cannot see.
const createdSchema = z.object({
  id: z.number().int(),
  link: z.string(),
  meta: z.unknown().optional(),
});

const termSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  slug: z.string(),
});

const termListSchema = z.array(termSchema);

const contentPostSchema = z.object({
  id: z.number().int(),
  link: z.string(),
  content: z.object({
    raw: z.string().optional(),
    rendered: z.string().optional(),
  }),
});

const contentPostListSchema = z.array(contentPostSchema);

type CreatedWordPressPost = {
  id: number;
  link: string;
  /** Detected from the create response, so the description needs no probe. */
  metaDescriptionField: MetaDescriptionField | null;
};

async function createPost(
  config: WordPressConfig,
  input: {
    title: string;
    slug: string;
    content: string;
    excerpt: string;
    status: WordPressPostStatus;
    /** Existing category ids only — resolveCategoryIds decides which. */
    categoryIds: number[];
  },
): Promise<CreatedWordPressPost> {
  const body: Record<string, unknown> = {
    title: input.title,
    slug: input.slug,
    content: input.content,
    excerpt: input.excerpt,
    status: input.status,
  };
  // Sending `categories: []` would strip whatever WordPress assigns by
  // default; omitting the key leaves the site's own default alone.
  if (input.categoryIds.length > 0) body.categories = input.categoryIds;
  const payload = await wpFetch(config, "/wp-json/wp/v2/posts", {
    method: "POST",
    body,
  });
  const parsed = createdSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AppError(
      "PUBLISH_UNREACHABLE",
      "Unexpected response shape from POST /wp-json/wp/v2/posts.",
    );
  }
  return {
    id: parsed.data.id,
    link: parsed.data.link,
    metaDescriptionField: detectMetaDescriptionField(parsed.data.meta),
  };
}

/** Hubs are pages, not posts: a hub is site architecture, and putting one in
 *  the post feed would push it through the RSS and the blog index. */
async function findPageBySlug(
  config: WordPressConfig,
  slug: string,
): Promise<{ id: number; link: string } | null> {
  const payload = await wpFetch(
    config,
    `/wp-json/wp/v2/pages?slug=${encodeURIComponent(slug)}&context=edit`,
  );
  const parsed = z
    .array(z.object({ id: z.number().int(), link: z.string() }))
    .safeParse(payload);
  if (!parsed.success) {
    throw new AppError(
      "PUBLISH_UNREACHABLE",
      "Unexpected response shape from /wp-json/wp/v2/pages.",
    );
  }
  return parsed.data[0] ?? null;
}

async function createPage(
  config: WordPressConfig,
  input: {
    title: string;
    slug: string;
    content: string;
    status: WordPressPostStatus;
  },
): Promise<{ id: number; link: string }> {
  const payload = await wpFetch(config, "/wp-json/wp/v2/pages", {
    method: "POST",
    body: input,
  });
  const parsed = createdSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AppError(
      "PUBLISH_UNREACHABLE",
      "Unexpected response shape from POST /wp-json/wp/v2/pages.",
    );
  }
  return { id: parsed.data.id, link: parsed.data.link };
}

/**
 * Map category names to ids, matching only what already exists.
 *
 * rankloop never creates taxonomy the user did not ask for: a category is a
 * navigational commitment on someone else's site, and a page type named
 * "Comparisons" is not permission to add a "Comparisons" category to their
 * menu. Names with no match come back as `missing` so the caller can say what
 * it skipped instead of silently dropping it.
 */
async function resolveCategoryIds(
  config: WordPressConfig,
  names: string[],
): Promise<{ ids: number[]; missing: string[] }> {
  const ids: number[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const payload = await wpFetch(
      config,
      `/wp-json/wp/v2/categories?search=${encodeURIComponent(name)}`,
    );
    const parsed = termListSchema.safeParse(payload);
    // `search` is a fuzzy match: "Comparison" would return "Comparisons".
    // Only an exact name or slug hit counts, or we would file the post under
    // a category the user never meant.
    const wanted = name.trim().toLowerCase();
    const hit = parsed.success
      ? parsed.data.find(
          (term) =>
            term.name.trim().toLowerCase() === wanted ||
            term.slug.trim().toLowerCase() === wanted,
        )
      : undefined;
    if (hit) ids.push(hit.id);
    else missing.push(name);
  }
  return { ids, missing };
}

/** The post body as stored, so the caller can merge rankloop's owned block
 *  into it. context=edit is what returns content.raw rather than the
 *  shortcode-expanded render — merging into rendered output would write the
 *  render back over the source. */
async function findPostContentBySlug(
  config: WordPressConfig,
  slug: string,
): Promise<{ id: number; link: string; content: string } | null> {
  const payload = await wpFetch(
    config,
    `/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&context=edit`,
  );
  const parsed = contentPostListSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AppError(
      "PUBLISH_UNREACHABLE",
      "Unexpected response shape from /wp-json/wp/v2/posts.",
    );
  }
  const post = parsed.data[0];
  if (!post) return null;
  const content = post.content.raw ?? post.content.rendered;
  if (content === undefined) {
    // A site that hides content.raw from an authenticated edit context cannot
    // be link-injected safely: merging into a render and writing it back
    // would replace the user's source with its own output.
    return null;
  }
  return { id: post.id, link: post.link, content };
}

/**
 * Write a post body back. The only caller is link injection, and the body it
 * passes is the post's own content with rankloop's delimited block merged in
 * — read first, merged, written whole, because the REST API has no way to
 * patch a fragment. Nothing else in this file replaces a post's content.
 */
async function updatePostContent(
  config: WordPressConfig,
  input: { postId: number; content: string },
): Promise<void> {
  await wpFetch(config, `/wp-json/wp/v2/posts/${input.postId}`, {
    method: "POST",
    body: { content: input.content },
  });
}

export const WordPressClient = {
  testConnection,
  findPostBySlug,
  updatePost,
  createPost,
  findPageBySlug,
  createPage,
  resolveCategoryIds,
  findPostContentBySlug,
  updatePostContent,
};
