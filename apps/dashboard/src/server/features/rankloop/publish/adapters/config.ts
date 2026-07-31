import { z } from "zod";
import type { publishConnections } from "@/db/schema";
import { AppError } from "@/server/lib/errors";

// The decrypted shapes of publish_connections.configJson, one per adapter
// (spec 0021). The blob is data at rest that no migration ever rewrote, so
// every read re-validates: a shape drift should fail here, loudly, and not
// three calls deep inside a fetch.
//
// The adapter name is NOT part of the blob — it lives in its own column, which
// is what S3b wrote and what makes `parseAdapterConfig` backwards compatible
// with connections saved before webhook and github existed.

export type PublishAdapterKind =
  (typeof publishConnections.adapter.enumValues)[number];

// ---------------------------------------------------------------------------
// Shared settings
// ---------------------------------------------------------------------------

/**
 * Carried by every adapter's blob. 'draft' is the default on purpose: the safe
 * default is that a human sees the post on their own site before the world
 * does. Connections saved before these keys existed parse to the defaults.
 */
const publishSettingsSchema = z.object({
  defaultPostStatus: z.enum(["draft", "publish"]).default("draft"),
  linkInjection: z.boolean().default(true),
});

export type PublishSettings = z.infer<typeof publishSettingsSchema>;

// ---------------------------------------------------------------------------
// Per-adapter shapes
// ---------------------------------------------------------------------------

const wordpressSchema = publishSettingsSchema.extend({
  baseUrl: z.string(),
  username: z.string(),
  applicationPassword: z.string(),
});

const webhookSchema = publishSettingsSchema.extend({
  url: z.string(),
  /** Signs the envelope. Per project, never sent, never logged. */
  secret: z.string(),
  /** The site root the page type's urlPattern hangs off, for computed URLs. */
  siteUrl: z.string(),
});

const githubSchema = publishSettingsSchema.extend({
  owner: z.string(),
  repo: z.string(),
  token: z.string(),
  /** The branch a PR targets, or the branch a direct commit lands on. */
  baseBranch: z.string().default("main"),
  /** Repo-relative root the urlPattern's path hangs off ("content"). */
  contentDir: z.string().default("content"),
  /** Repo-relative root that is served at the site root, where the derived
   *  artifacts (sitemap.xml, rss.xml, llms.txt, llms-full.txt) live. */
  publicDir: z.string().default("public"),
  /**
   * PR by default. Direct commits are opt-in because a commit straight to the
   * default branch is a deploy nobody reviewed.
   */
  commitMode: z.enum(["pull-request", "direct"]).default("pull-request"),
  siteUrl: z.string(),
});

export type WordPressAdapterConfig = z.infer<typeof wordpressSchema>;
export type WebhookAdapterConfig = z.infer<typeof webhookSchema>;
export type GitHubAdapterConfig = z.infer<typeof githubSchema>;

export type PublishAdapterConfig =
  | ({ adapter: "wordpress" } & WordPressAdapterConfig)
  | ({ adapter: "webhook" } & WebhookAdapterConfig)
  | ({ adapter: "github" } & GitHubAdapterConfig);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Turn the adapter column plus the decrypted blob into a config the adapters
 * can use. The switch rather than a discriminated union is deliberate: the
 * discriminant lives outside the data being parsed, and a union would force
 * either a cast or a rewrite of every row saved by S3b.
 *
 * The thrown message names the adapter and nothing else — a validation error
 * that echoed the input would echo an application password with it.
 */
export function parseAdapterConfig(
  adapter: PublishAdapterKind,
  raw: unknown,
): PublishAdapterConfig {
  switch (adapter) {
    case "wordpress":
      return { adapter, ...parseOrThrow(wordpressSchema, raw, adapter) };
    case "webhook":
      return { adapter, ...parseOrThrow(webhookSchema, raw, adapter) };
    case "github":
      return { adapter, ...parseOrThrow(githubSchema, raw, adapter) };
  }
}

function parseOrThrow<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  adapter: PublishAdapterKind,
): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(
      "PUBLISH_NOT_CONNECTED",
      `The stored ${adapter} connection is missing fields it needs.`,
    );
  }
  return parsed.data;
}
