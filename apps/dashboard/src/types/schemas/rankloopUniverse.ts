import type { InferSelectModel } from "drizzle-orm";
import { z } from "zod";
import type { keywordBacklog } from "@/db/schema";

// ---------------------------------------------------------------------------
// DB-derived types
// ---------------------------------------------------------------------------

type KeywordBacklogRow = InferSelectModel<typeof keywordBacklog>;
/** The backlog's own source enum — 'manual' included, because a human typing
 *  a keyword is a source of rows even though no run ever produces it. */
export type KeywordBacklogSource = KeywordBacklogRow["source"];

/**
 * The same enum as a value, for the Keywords tab's source filter — 'manual'
 * included, because a filter that can't express it hides rows the table is
 * already showing.
 *
 * Written out rather than read off `keywordBacklog.source.enumValues`: the
 * Keywords tab imports this module, and a *value* import of `@/db/schema`
 * pulls Drizzle — and `cloudflare:workers` beneath it — into the browser
 * bundle, which fails the build. `satisfies` keeps every entry checked
 * against the column's own union.
 */
export const BACKLOG_SOURCES = [
  "gsc",
  "gap",
  "expansion",
  "autocomplete",
  "harvest",
  "manual",
] as const satisfies readonly KeywordBacklogSource[];

// ---------------------------------------------------------------------------
// The five sources a run can dispatch
// ---------------------------------------------------------------------------

export const UNIVERSE_SOURCES = [
  "gsc",
  "gap",
  "expansion",
  "autocomplete",
  "harvest",
] as const;

export type UniverseSource = (typeof UNIVERSE_SOURCES)[number];

/** Sources that cost nothing but time: Search Console memory the project
 *  already paid Google nothing for, three public suggest endpoints, and two
 *  public feeds. Only these auto-run — see scheduledKeywordUniverse.ts. */
export const FREE_UNIVERSE_SOURCES: readonly UniverseSource[] = [
  "gsc",
  "autocomplete",
  "harvest",
];

/** Sources that spend DataForSEO credits per call. A schedule that quietly
 *  bills someone weekly is how a tool loses trust, so these are manual-only
 *  and the dispatcher refuses them. */
const METERED_UNIVERSE_SOURCES: readonly UniverseSource[] = [
  "gap",
  "expansion",
];

export function isMeteredUniverseSource(source: UniverseSource): boolean {
  return METERED_UNIVERSE_SOURCES.includes(source);
}

// ---------------------------------------------------------------------------
// Harvest configuration
// ---------------------------------------------------------------------------

/**
 * Where the free question feeds are read from. Opt-in per project because
 * there is no such thing as a default subreddit — the tag set that matches a
 * niche is knowledge only the site's owner has, and guessing it produces a
 * backlog of other people's questions.
 *
 * Stored on the run row's sourcesJson rather than in a table of its own: the
 * last run that harvested IS the record of how harvesting was configured, so
 * the weekly block can repeat it and the Collapsible can prefill from it,
 * with no schema surface the spec didn't ask for.
 */
export const harvestConfigSchema = z.object({
  // A StackExchange site host (e.g. "superuser.com"), hostname only.
  stackExchangeSite: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Enter a StackExchange site hostname")
    .max(100)
    .optional(),
  // Six tags at 2s apart is 12 seconds of pacing — past that a harvest step
  // spends more time sleeping than reading.
  stackExchangeTags: z
    .array(z.string().trim().min(1).max(50))
    .max(6)
    .default([]),
  // Three subs at 20s apart is a minute, which is v1's measured whole-run
  // cost. Five would be pushing a free feed's patience for two more subs.
  subreddits: z
    .array(
      z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_]{2,21}$/, "Enter a subreddit name without r/"),
    )
    .max(3)
    .default([]),
});

export type HarvestConfig = z.infer<typeof harvestConfigSchema>;

export function hasHarvestSources(config: HarvestConfig | null): boolean {
  if (!config) return false;
  const stackExchange = Boolean(
    config.stackExchangeSite && config.stackExchangeTags.length > 0,
  );
  return stackExchange || config.subreddits.length > 0;
}

// ---------------------------------------------------------------------------
// keyword_universe_runs.sourcesJson
// ---------------------------------------------------------------------------

const universeRunSourcesSchema = z.object({
  sources: z.array(z.enum(UNIVERSE_SOURCES)),
  harvest: harvestConfigSchema.optional(),
});

type UniverseRunSources = z.infer<typeof universeRunSourcesSchema>;

/** Read a run's dispatch record, or null when the column holds JSON this
 *  version of the code doesn't understand — a shape change must degrade to
 *  "we can't say what that run asked for", never to a crash. */
export function parseUniverseRunSources(
  json: string | null,
): UniverseRunSources | null {
  if (!json) return null;
  try {
    const parsed = universeRunSourcesSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Server function inputs
// ---------------------------------------------------------------------------

export const getRankloopUniverseRunSchema = z.object({
  projectId: z.string().uuid(),
});

export const startRankloopUniverseSchema = z.object({
  projectId: z.string().uuid(),
  sources: z
    .array(z.enum(UNIVERSE_SOURCES))
    .min(1)
    .max(UNIVERSE_SOURCES.length),
  harvest: harvestConfigSchema.optional(),
});

// ---------------------------------------------------------------------------
// The Keywords tab's own reads and hand edits
// ---------------------------------------------------------------------------

/**
 * The gate as the card renders it. `documentCount` is recomputed on read from
 * the project's own pages, which is why it is nullable: a positive earned
 * entirely from the queries the site ranks for — or typed in by hand — has no
 * page count, and the chip shows the token alone rather than a zero.
 */
export type GateCard = {
  positives: { token: string; documentCount: number | null }[];
  negatives: string[];
  kdCeiling: number;
  kdCeilingUpdatedAt: string | null;
  userEdited: boolean;
  derivedAt: string;
};

export const BACKLOG_PAGE_SIZES = [25, 50, 100] as const;

export const getRankloopBacklogSchema = z.object({
  projectId: z.string().uuid(),
  // Absent means every source; an empty array would mean "none", which no
  // filter row can express and which would render an empty table nobody asked
  // for.
  sources: z.array(z.enum(BACKLOG_SOURCES)).min(1).optional(),
  search: z.string().trim().max(100).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(50),
  sort: z
    .enum(["score", "keyword", "searchVolume", "keywordDifficulty"])
    .default("score"),
  order: z.enum(["asc", "desc"]).default("desc"),
});

export const getRankloopGateSchema = z.object({
  projectId: z.string().uuid(),
});

/** A hand-edited gate replaces both lists wholesale — the card holds the
 *  whole set, and a per-token endpoint would make two chips removed in one
 *  edit into two races. Tokens are literals; 60 chars is a long phrase and
 *  well past anything the derivation produces. */
export const updateRankloopGateSchema = z.object({
  projectId: z.string().uuid(),
  positives: z.array(z.string().trim().min(1).max(60)).max(40),
  negatives: z.array(z.string().trim().min(1).max(60)).max(40),
});

/** Bounded like every other bulk input in the app: one page of the table at
 *  its largest, with room for a select-all that spans a filter. */
export const skipRankloopKeywordsSchema = z.object({
  projectId: z.string().uuid(),
  keywordIds: z.array(z.string().uuid()).min(1).max(500),
});
