import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import type { UniverseCandidate } from "@/server/features/rankloop/universe/services/keywordAdmission";
import type { HarvestConfig } from "@/types/schemas/rankloopUniverse";
import { RANKLOOP_REPO_URL } from "@/shared/product";

// Real questions real people typed, from two published feeds that need no
// key and no approval. Autocomplete gives you the phrasing; these give you
// the problem behind it — which is why their rows are pool-flagged: they
// carry neutral priors and would never out-score a metric-backed row, so the
// pool-mix rule is how they ever reach a calendar.

/**
 * v1's hard-won pacing constants (rankloop 0.2 harvest.py), verified in
 * production against both feeds. Do not "optimize" these downward:
 *
 * - StackExchange tag feeds are capped at 30 entries, cached ~5 minutes
 *   server-side, and 429-happy under bursts. 2s between tags stays well
 *   clear; the cache means a faster loop would re-read the same bytes anyway.
 * - Reddit's public /new/.rss returns 200 with 25 entries, and then 429s a
 *   second request seconds later even under a custom UA. 20s between subs,
 *   and exactly ONE retry at 2× that gap when a 429 comes back — patiently,
 *   because the alternative to the public feed is the approval-gated Data
 *   API, and there is no third option we would be willing to use.
 */
export const STACKEXCHANGE_TAG_GAP_MS = 2_000;
export const REDDIT_RSS_GAP_MS = 20_000;
export const REDDIT_RETRY_BACKOFF_MULTIPLIER = 2;
export const REDDIT_MAX_ATTEMPTS = 2;

const FEED_TIMEOUT_MS = 20_000;

// Identify honestly: an anonymous-looking bot is what a feed operator
// throttles first, and this request is research, not a crawl.
const HARVEST_USER_AGENT = `rankloop/2.0 (query research; +${RANKLOOP_REPO_URL})`;

// Same bounds as autocomplete's, widened at the top: a question title is a
// sentence, and 120 chars is where a title stops being a keyword.
const MIN_TITLE_LENGTH = 8;
const MAX_TITLE_LENGTH = 120;

const feedParser = new XMLParser({
  ignoreAttributes: false,
  isArray: (name) => name === "entry",
});

// ---------------------------------------------------------------------------
// Parsers (pure — the mocked-fetch tests drive these directly)
// ---------------------------------------------------------------------------

type FeedEntry = {
  title: string;
  url: string;
  /** StackExchange annotates entries with a vote count; Reddit does not. */
  votes: number | null;
};

// An XML text node arrives as a string, as a number when it looks numeric, or
// as an object carrying `#text` when the element also has attributes — all
// three shapes come out of one feed, so the schema accepts all three rather
// than assuming the one today's sample happened to use.
const textNodeSchema = z.union([
  z.string(),
  z.number(),
  z.object({ "#text": z.union([z.string(), z.number()]) }).passthrough(),
]);

// `<link href="…"/>` is an attribute, not a child, and an entry can carry
// several links. A childless element is falsy in most languages' truthiness
// rules, so reading the element as text would silently lose every URL.
const linkNodeSchema = z.object({ "@_href": z.string() }).passthrough();

const atomFeedSchema = z.object({
  feed: z
    .object({
      entry: z
        .array(
          z
            .object({
              title: textNodeSchema.optional(),
              id: textNodeSchema.optional(),
              link: z
                .union([linkNodeSchema, z.array(linkNodeSchema)])
                .optional(),
              "re:rank": textNodeSchema.optional(),
            })
            .passthrough(),
        )
        .optional(),
    })
    .passthrough(),
});

type TextNode = z.infer<typeof textNodeSchema>;
type LinkNode = z.infer<typeof linkNodeSchema>;

function readText(value: TextNode | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return readText(value["#text"]);
}

function readLinkHref(value: LinkNode | LinkNode[] | undefined): string {
  if (value === undefined) return "";
  const links = Array.isArray(value) ? value : [value];
  return links.find((link) => link["@_href"] !== "")?.["@_href"] ?? "";
}

/** Feed titles arrive HTML-escaped, suffixed with moderation tags, and
 *  question-marked; a keyword row wants none of that. */
export function cleanFeedTitle(raw: string): string {
  return raw
    .replace(/\s*\[(closed|duplicate|solved|on hold)\]\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\?+$/, "")
    .trim();
}

const QUESTION_OPENERS =
  /^(how|what|why|when|where|which|who|whose|can|could|should|would|will|does|do|did|is|are|was|were|has|have|any|anyone|anybody|best|looking for|need help|help with)\b/i;

/**
 * Question-shaped titles only. A feed carries announcements, memes and rants
 * alongside the questions; a backlog row that isn't a question is a row no
 * brief can answer. Checked on the RAW title, before cleanFeedTitle strips
 * the trailing "?" that is half the signal.
 */
export function isQuestionShaped(rawTitle: string): boolean {
  const title = rawTitle.trim();
  if (!title) return false;
  if (title.endsWith("?")) return true;
  return QUESTION_OPENERS.test(title);
}

/** A body that isn't the feed we asked for — a 429 HTML page, a redirect
 *  notice — parses to something that isn't a feed and yields no entries,
 *  which is the same answer as an empty feed and the right one either way. */
function parseAtomEntries(xml: string, withVotes: boolean): FeedEntry[] {
  let raw: unknown;
  try {
    raw = feedParser.parse(xml);
  } catch {
    return [];
  }
  const parsed = atomFeedSchema.safeParse(raw);
  if (!parsed.success) return [];

  return (parsed.data.feed.entry ?? []).flatMap((entry) => {
    const title = readText(entry.title);
    if (!title) return [];
    const votes = withVotes ? Number(readText(entry["re:rank"])) : Number.NaN;
    return [
      {
        title,
        url: readLinkHref(entry.link) || readText(entry.id),
        votes: Number.isFinite(votes) ? votes : null,
      },
    ];
  });
}

/** StackExchange per-tag Atom: entries carry a vote count in the rank
 *  namespace, and `id` is the canonical question URL. */
export function parseStackExchangeFeed(xml: string): FeedEntry[] {
  return parseAtomEntries(xml, true);
}

/** Reddit per-sub Atom: same document shape, no vote element. */
export function parseRedditFeed(xml: string): FeedEntry[] {
  return parseAtomEntries(xml, false);
}

/** Shared admission: question-shaped, length-bounded, de-duplicated across
 *  both feeds within one run. */
export function toHarvestCandidate(input: {
  entry: FeedEntry;
  seed: string;
  origin: "stackexchange" | "reddit";
  seen: Set<string>;
}): UniverseCandidate | null {
  if (!isQuestionShaped(input.entry.title)) return null;
  const keyword = cleanFeedTitle(input.entry.title).toLowerCase();
  if (
    keyword.length < MIN_TITLE_LENGTH ||
    keyword.length > MAX_TITLE_LENGTH ||
    input.seen.has(keyword)
  ) {
    return null;
  }
  input.seen.add(keyword);
  return {
    keyword,
    source: "harvest",
    seed: input.seed,
    notes: {
      // The flag S6/S7 read to satisfy the pool-mix rule: exactly one slot per
      // batch comes from here, so unmeasured questions reach the calendar
      // without being able to take it over.
      pool: "fresh_question",
      origin: input.origin,
      url: input.entry.url,
      ...(input.entry.votes === null ? {} : { votes: input.entry.votes }),
    },
  };
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

class FeedHttpError extends Error {
  constructor(readonly status: number) {
    super(`Feed responded ${status}`);
    this.name = "FeedHttpError";
  }
}

async function fetchFeed(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": HARVEST_USER_AGENT,
      Accept: "application/atom+xml, application/xml",
    },
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
  });
  if (!response.ok) throw new FeedHttpError(response.status);
  return response.text();
}

async function harvestStackExchange(
  config: HarvestConfig,
  seen: Set<string>,
): Promise<UniverseCandidate[]> {
  const site = config.stackExchangeSite;
  if (!site || config.stackExchangeTags.length === 0) return [];

  const candidates: UniverseCandidate[] = [];
  for (const [index, tag] of config.stackExchangeTags.entries()) {
    if (index > 0) await sleep(STACKEXCHANGE_TAG_GAP_MS);
    try {
      const xml = await fetchFeed(
        `https://${site}/feeds/tag/${encodeURIComponent(tag)}`,
      );
      for (const entry of parseStackExchangeFeed(xml)) {
        const candidate = toHarvestCandidate({
          entry,
          seed: `stackexchange/${tag}`,
          origin: "stackexchange",
          seen,
        });
        if (candidate) candidates.push(candidate);
      }
    } catch (error) {
      // A tag that doesn't exist on that site 404s, and a burst 429s. Either
      // way the remaining tags are still worth reading — a partial harvest is
      // a harvest.
      console.info(`[universe] stackexchange/${tag} skipped:`, error);
    }
  }
  return candidates;
}

async function harvestReddit(
  config: HarvestConfig,
  seen: Set<string>,
): Promise<UniverseCandidate[]> {
  const candidates: UniverseCandidate[] = [];
  for (const [index, sub] of config.subreddits.entries()) {
    if (index > 0) await sleep(REDDIT_RSS_GAP_MS);
    const xml = await readSubredditFeed(sub);
    if (xml === null) continue;
    for (const entry of parseRedditFeed(xml)) {
      const candidate = toHarvestCandidate({
        entry,
        seed: `r/${sub}`,
        origin: "reddit",
        seen,
      });
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

/** One retry, and only for a 429, at twice the pacing gap. Anything else is
 *  the sub being gone or private, which no amount of waiting fixes. */
async function readSubredditFeed(sub: string): Promise<string | null> {
  for (let attempt = 1; attempt <= REDDIT_MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchFeed(
        `https://www.reddit.com/r/${encodeURIComponent(sub)}/new/.rss`,
      );
    } catch (error) {
      const throttled = error instanceof FeedHttpError && error.status === 429;
      if (throttled && attempt < REDDIT_MAX_ATTEMPTS) {
        await sleep(REDDIT_RSS_GAP_MS * REDDIT_RETRY_BACKOFF_MULTIPLIER);
        continue;
      }
      console.info(`[universe] reddit r/${sub} skipped:`, error);
      return null;
    }
  }
  return null;
}

/**
 * Read both feeds into candidates. Opt-in per project: there is no default
 * subreddit or tag set, and guessing one produces a backlog of other
 * people's questions.
 */
export async function harvestQuestions(
  config: HarvestConfig,
): Promise<UniverseCandidate[]> {
  const seen = new Set<string>();
  const stackExchange = await harvestStackExchange(config, seen);
  const reddit = await harvestReddit(config, seen);
  return [...stackExchange, ...reddit];
}
