import type { InferSelectModel } from "drizzle-orm";
import { z } from "zod";
import { publishConnections } from "@/db/schema";

// ---------------------------------------------------------------------------
// DB-derived types
// ---------------------------------------------------------------------------

type PublishConnection = InferSelectModel<typeof publishConnections>;

// ---------------------------------------------------------------------------
// API / UI types
// ---------------------------------------------------------------------------

/** Carried by every masked config: the two shared settings, plus the one bit
 *  a secret is allowed to become on this side of the wire. */
type MaskedPublishSettings = {
  defaultPostStatus: "draft" | "publish";
  linkInjection: boolean;
  /** True when a credential is stored. The value itself never comes back —
   *  the form reads this and puts the mask in the placeholder. */
  hasSecret: boolean;
};

/** What connection reads return to the client. The nested config mirrors the
 *  stored (encrypted) config's shape minus its secret: the application
 *  password, the signing secret and the GitHub token never cross the wire
 *  after save — they mask to `hasSecret` (spec 0013 acceptance 4). The
 *  discriminant is repeated inside `config` so the form can narrow on the
 *  object it is actually reading. */
export type MaskedPublishConnection = Pick<
  PublishConnection,
  "adapter" | "status" | "lastCheckedAt"
> & {
  config:
    | ({
        adapter: "wordpress";
        baseUrl: string;
        username: string;
      } & MaskedPublishSettings)
    | ({
        adapter: "webhook";
        url: string;
        siteUrl: string;
      } & MaskedPublishSettings)
    | ({
        adapter: "github";
        owner: string;
        repo: string;
        baseBranch: string;
        contentDir: string;
        publicDir: string;
        commitMode: "pull-request" | "direct";
        siteUrl: string;
      } & MaskedPublishSettings);
};

/**
 * One neighbour the publish touched, as stored in
 * `articles.links_injected_json`.
 *
 * The outcomes are all reported, not just the successes: a page whose owned
 * block could not be located is a page rankloop deliberately declined to edit,
 * and hiding that would make "links injected: 2 of 3" look like a bug instead
 * of the restraint it is.
 */
export const injectedLinkSchema = z.object({
  contentPageId: z.string(),
  path: z.string(),
  outcome: z.enum([
    /** The owned block was written (appended or rewritten). */
    "injected",
    /** The block already said exactly this — nothing was sent to the site. */
    "unchanged",
    /** The target applies links itself; rankloop sent it the list. */
    "delegated",
    /** The page's delimiters were damaged, so nothing was written. */
    "malformed",
    /** The target has no page at that path any more. */
    "missing",
    /** The write was attempted and the target rejected it. */
    "failed",
  ]),
});

const injectedLinksSchema = z.array(injectedLinkSchema);

export type RankloopInjectedLink = z.infer<typeof injectedLinkSchema>;

/** A stored injection record read back, or an empty list when the column is
 *  empty or was written by an older shape. A corrupt record must cost the
 *  publish panel its link list, never the page. */
export function parseInjectedLinks(raw: string | null): RankloopInjectedLink[] {
  if (!raw) return [];
  try {
    const parsed = injectedLinksSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

export const getPublishConnectionSchema = z.object({
  projectId: z.string().uuid(),
});

/** Publish one approved article. The article row and the workflow instance are
 *  both named server-side; a client cannot name either, and cannot choose the
 *  target — that is the project's one saved connection. */
export const publishRankloopArticleSchema = z.object({
  projectId: z.string().uuid(),
  articleId: z.string().uuid(),
});

export const getPublishedArticlesSchema = z.object({
  projectId: z.string().uuid(),
});

// An http(s) address, not just any string zod would call a URL — `mailto:` and
// `file:` both pass `.url()`, and neither is somewhere rankloop can publish.
const httpUrl = z
  .string()
  .url()
  .max(2000)
  .refine(
    (value) => value.startsWith("https://") || value.startsWith("http://"),
    "The address must start with http:// or https://",
  );

// The two settings every adapter's blob carries (spec 0021 schema section).
const publishSettingsFields = {
  defaultPostStatus: z.enum(["draft", "publish"]),
  linkInjection: z.boolean(),
};

// Every secret below is optional for the same reason: the masked read-back
// can't round-trip it, so an omitted value means "keep the stored one" and a
// blank one would wipe a working credential on an unrelated edit. The caps are
// sanity bounds (a WordPress application password is 24 chars plus spaces, a
// fine-grained GitHub token ~93).
const wordpressConfigInput = z.object({
  adapter: z.literal("wordpress"),
  ...publishSettingsFields,
  baseUrl: httpUrl,
  username: z.string().min(1).max(200),
  applicationPassword: z.string().min(1).max(200).optional(),
});

const webhookConfigInput = z.object({
  adapter: z.literal("webhook"),
  ...publishSettingsFields,
  url: httpUrl,
  secret: z.string().min(1).max(500).optional(),
  siteUrl: httpUrl,
});

const githubConfigInput = z.object({
  adapter: z.literal("github"),
  ...publishSettingsFields,
  owner: z.string().min(1).max(200),
  repo: z.string().min(1).max(200),
  token: z.string().min(1).max(500).optional(),
  baseBranch: z.string().min(1).max(200),
  contentDir: z.string().max(200),
  // Where the derived artifacts (sitemap.xml, rss.xml, llms.txt,
  // llms-full.txt) have to land to be served at the site root. "public" is
  // that directory in most generators and stays the default, but a repo that
  // serves from "static" or "docs" — or from the root itself — would otherwise
  // get four files committed somewhere nothing publishes them. The default
  // survives here too, so connections saved before the field existed parse.
  publicDir: z.string().max(200).default("public"),
  commitMode: z.enum(["pull-request", "direct"]),
  siteUrl: httpUrl,
});

export const savePublishConnectionConfigSchema = z.discriminatedUnion(
  "adapter",
  [wordpressConfigInput, webhookConfigInput, githubConfigInput],
);

export type SavePublishConnectionConfig = z.infer<
  typeof savePublishConnectionConfigSchema
>;

// `adapter` is sent alongside the blob because it is its own column, not part
// of the blob. The refine is what keeps the column and the shape from drifting
// apart: a row whose column said 'github' over a WordPress blob would fail on
// the next read instead of here.
export const savePublishConnectionSchema = z
  .object({
    projectId: z.string().uuid(),
    adapter: z.enum(publishConnections.adapter.enumValues),
    config: savePublishConnectionConfigSchema,
  })
  .refine((value) => value.adapter === value.config.adapter, {
    message: "The adapter and its configuration disagree.",
    path: ["config", "adapter"],
  });

export const testPublishConnectionSchema = z.object({
  projectId: z.string().uuid(),
});

// The editor's 70/165 charcount hints are guidance; these caps are the hard
// sanity bounds (Google truncates, it doesn't reject).
export const executeRetitleProposalSchema = z.object({
  projectId: z.string().uuid(),
  proposalId: z.string().uuid(),
  newTitle: z.string().trim().min(1).max(300),
  newMetaDescription: z.string().trim().min(1).max(500).optional(),
});

const proposalActionSchema = z.object({
  projectId: z.string().uuid(),
  proposalId: z.string().uuid(),
});

export const attestProposalSchema = proposalActionSchema;
export const getPushGuidanceSchema = proposalActionSchema;
export const getRetitleContextSchema = proposalActionSchema;
