import { z } from "zod";
import type { UniverseCandidate } from "@/server/features/rankloop/universe/services/keywordAdmission";

// Free long-tail expansion from the three public suggest endpoints. What
// autocomplete returns is what people literally typed, which is exactly the
// zero-volume tail every paid tool buckets as "0" and undervalues — and the
// tail is what a young domain can win this quarter. Rows land with volume
// NULL on purpose; the backlog's picker admits NULL volume by design.

// The suggest endpoints serve empty bodies (or 403s) to anything that
// announces itself as a script. A browser UA is not a disguise here — the
// request is one a browser makes, at a rate no browser would be throttled
// for — it is the only string these endpoints answer.
const SUGGEST_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

/** Polite spacing between suggest calls, from v1's suggest.py: three free
 *  endpoints stay free when nobody hammers them. 150ms × 27 calls per seed is
 *  ~4 seconds of pacing per seed, which is the whole cost of being welcome. */
export const SUGGEST_PACING_MS = 150;

/** The eight question shapes that convert to articles. Prefixes only — v1's
 *  a-z suffix fan-out tripled the call count for the same tail, and a Worker
 *  invocation has a subrequest budget a laptop cron did not. */
export const QUESTION_PREFIXES = [
  "how to",
  "why is",
  "can i",
  "does",
  "what is",
  "best",
  "is it",
  "fix",
];

// 8 chars filters head terms a new site cannot win; 90 filters the pasted
// sentences autocomplete occasionally echoes back. Both from v1.
const MIN_SUGGESTION_LENGTH = 8;
const MAX_SUGGESTION_LENGTH = 90;

const SUGGEST_TIMEOUT_MS = 10_000;

/** Seeds per run. Each seed costs 27 subrequests (9 queries × 3 endpoints);
 *  ten seeds is 270, comfortably inside a Worker invocation's budget and
 *  ~40 seconds of pacing inside a 5-minute step. */
export const AUTOCOMPLETE_SEED_LIMIT = 10;

// ---------------------------------------------------------------------------
// Parsers (pure — the mocked-fetch tests drive these directly)
// ---------------------------------------------------------------------------

/**
 * The OpenSearch suggestion shape: `[query, [suggestions], ...]`. Google
 * (client=firefox), Bing (osjson) and DuckDuckGo (type=list) all answer in
 * it, so one parser covers all three — and all three have changed shape
 * before, which is why every level is checked rather than indexed into.
 */
const openSearchEnvelopeSchema = z
  .tuple([z.unknown(), z.array(z.unknown())])
  .rest(z.unknown());

export function parseOpenSearchSuggest(body: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return [];
  }
  const parsed = openSearchEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data[1].filter(
    (entry): entry is string => typeof entry === "string",
  );
}

type SuggestEndpoint = {
  name: string;
  url: (query: string, languageCode: string) => string;
};

export const SUGGEST_ENDPOINTS: SuggestEndpoint[] = [
  {
    name: "google",
    // client=firefox is the variant that returns clean JSON; client=chrome
    // wraps the payload in JSONP with a hostile encoding.
    url: (query, languageCode) =>
      `https://suggestqueries.google.com/complete/search?client=firefox&hl=${encodeURIComponent(languageCode)}&q=${encodeURIComponent(query)}`,
  },
  {
    name: "bing",
    // No market param on purpose — Bing infers one, and guessing a region
    // from a bare language code is worse than letting it.
    url: (query) =>
      `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(query)}`,
  },
  {
    name: "ddg",
    // type=list forces the OpenSearch shape; without it DDG returns a list of
    // {"phrase": ...} objects.
    url: (query) =>
      `https://duckduckgo.com/ac/?type=list&q=${encodeURIComponent(query)}`,
  },
];

/** Every query one seed fans out to: the bare seed, then the eight question
 *  shapes in front of it. */
export function expandSeed(seed: string): string[] {
  return [seed, ...QUESTION_PREFIXES.map((prefix) => `${prefix} ${seed}`)];
}

/** Length-bounded, lowercased, de-duplicated against what the run has already
 *  seen. Returns null for a suggestion that doesn't earn a backlog row. */
export function normalizeSuggestion(
  raw: string,
  seen: Set<string>,
): string | null {
  const keyword = raw.trim().toLowerCase();
  if (
    !keyword ||
    keyword.length < MIN_SUGGESTION_LENGTH ||
    keyword.length > MAX_SUGGESTION_LENGTH ||
    seen.has(keyword)
  ) {
    return null;
  }
  seen.add(keyword);
  return keyword;
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fetchSuggestions(
  endpoint: SuggestEndpoint,
  query: string,
  languageCode: string,
): Promise<string[]> {
  const response = await fetch(endpoint.url(query, languageCode), {
    headers: { "User-Agent": SUGGEST_USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(SUGGEST_TIMEOUT_MS),
  });
  if (!response.ok) return [];
  return parseOpenSearchSuggest(await response.text());
}

/** One endpoint's answer, folded into rows. No difficulty and no volume:
 *  nothing measured them, and the shared scorer's null branch is exactly the
 *  neutral prior these rows should carry — enough to sit in the backlog,
 *  never enough to out-rank a metric-backed row. */
function toCandidates(
  suggestions: string[],
  seed: string,
  suggestSource: string,
  seen: Set<string>,
): UniverseCandidate[] {
  return suggestions.flatMap((suggestion) => {
    const keyword = normalizeSuggestion(suggestion, seen);
    if (!keyword) return [];
    return [
      {
        keyword,
        source: "autocomplete" as const,
        seed,
        notes: { suggestSource },
      },
    ];
  });
}

/**
 * Expand the seed set through all three endpoints.
 *
 * One endpoint failing never fails the step — that is the whole reason there
 * are three. Google rate-limiting a Worker's IP, Bing changing its response
 * shape, DDG timing out: each is caught per call, counted, and the other two
 * carry the run. A step that died because one free endpoint sulked would make
 * the free half of this product the unreliable half.
 */
export async function expandWithAutocomplete(input: {
  seeds: string[];
  languageCode: string;
}): Promise<UniverseCandidate[]> {
  const seen = new Set<string>();
  const candidates: UniverseCandidate[] = [];
  const failures = new Map<string, number>();

  for (const seed of input.seeds.slice(0, AUTOCOMPLETE_SEED_LIMIT)) {
    for (const query of expandSeed(seed)) {
      for (const endpoint of SUGGEST_ENDPOINTS) {
        try {
          const suggestions = await fetchSuggestions(
            endpoint,
            query,
            input.languageCode,
          );
          candidates.push(
            ...toCandidates(suggestions, seed, endpoint.name, seen),
          );
        } catch {
          failures.set(endpoint.name, (failures.get(endpoint.name) ?? 0) + 1);
        }
        await sleep(SUGGEST_PACING_MS);
      }
    }
  }

  if (failures.size > 0) {
    console.info(
      `[universe] autocomplete endpoint failures: ${[...failures]
        .map(([name, count]) => `${name}=${count}`)
        .join(" ")}`,
    );
  }
  return candidates;
}
