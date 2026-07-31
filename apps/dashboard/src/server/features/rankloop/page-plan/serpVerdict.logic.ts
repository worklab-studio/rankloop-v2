// Pure functions behind plan-time SERP validation (spec 0017): what one
// sampled SERP says about a candidate page type, and the kill / caution / ok
// verdict a handful of those readings add up to. No I/O and no provider call —
// the fetching lives in the workflow; this file only judges what came back.
// Unit-tested directly in serpVerdict.logic.test.ts.

// ---------------------------------------------------------------------------
// What a SERP reading is made of
// ---------------------------------------------------------------------------

export type SerpOrganicResult = {
  /** Organic rank (rank_group), 1-based — what a user counts as "position". */
  position: number;
  url: string;
  domain: string;
  title: string;
  description: string | null;
};

export type SerpSample = {
  keyword: string;
  organic: SerpOrganicResult[];
  /** Only ever true when the response actually exposed the feature; a
   *  provider that doesn't report AI Overviews leaves this false rather than
   *  letting us guess. */
  aiOverview: boolean;
  featuredSnippet: boolean;
};

export type SerpSampleReading = {
  keyword: string;
  ugcTop5: number;
  weakness: number;
  aiOverview: boolean;
  featuredSnippet: boolean;
  winnableSignal: boolean;
};

export type PageTypeSerpCheck = {
  status: "ok" | "caution" | "kill" | "unsampled";
  /** One sentence, written to be read out loud on the card — including on
   *  the killed types, which are shown collapsed with their reason rather
   *  than hidden. */
  reason: string | null;
  sampled: number;
  /** Samples where UGC holds two or more of the top five. */
  hardSerps: number;
  aiOverviews: number;
  /** Σ weak slots in positions 6–10 across the samples. */
  weakSlots: number;
  winnable: number;
  samples: SerpSampleReading[];
};

// ---------------------------------------------------------------------------
// Shipped lists and thresholds
// ---------------------------------------------------------------------------

/**
 * The forums and Q&A platforms Google has spent two years promoting.
 *
 * Post-"hidden gems", a Reddit thread at position 2 is not a weak result you
 * can outrank with a better article — it is the answer the ranking system
 * decided the query wanted. Reading these as weakness (the way a 2019-era
 * difficulty tool would) is the single most expensive mistake this planner
 * could make, which is why they get their own kill rule instead of a bonus.
 */
const UGC_DOMAINS = new Set([
  "answers.com",
  "discord.com",
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "medium.com",
  "pinterest.com",
  "quora.com",
  "reddit.com",
  "serverfault.com",
  "stackexchange.com",
  "stackoverflow.com",
  "substack.com",
  "superuser.com",
  "threads.net",
  "tiktok.com",
  "tumblr.com",
  "twitter.com",
  "x.com",
  "youtube.com",
]);

/** Hosts and paths that say "forum" without being one of the platforms
 *  above — every niche has three of these and none of them is on a list. */
const FORUM_MARKERS = [
  /(^|\.)forum(s)?\./i,
  /(^|\.)community\./i,
  /(^|\.)board(s)?\./i,
  /\/forum(s)?(\/|$)/i,
  /\/thread(s)?(\/|$)/i,
  /\/topic(s)?(\/|$)/i,
  /\/viewtopic\.php/i,
  /\/showthread\.php/i,
];

/**
 * Domains that rank on brand, not on the page.
 *
 * Not a completeness claim — it can't be one — which is why it is paired with
 * the shape heuristic below rather than used alone.
 */
const MAJOR_DOMAINS = new Set([
  "amazon.com",
  "apple.com",
  "bbc.co.uk",
  "bbc.com",
  "britannica.com",
  "cnet.com",
  "cnn.com",
  "ebay.com",
  "etsy.com",
  "forbes.com",
  "google.com",
  "healthline.com",
  "homedepot.com",
  "ikea.com",
  "imdb.com",
  "investopedia.com",
  "lowes.com",
  "mayoclinic.org",
  "microsoft.com",
  "nytimes.com",
  "rei.com",
  "target.com",
  "techradar.com",
  "theguardian.com",
  "tomsguide.com",
  "walmart.com",
  "webmd.com",
  "wikipedia.org",
  "wirecutter.com",
]);

/**
 * A short domain ranking with a bare homepage is a brand.
 *
 * Approximate, and knowingly so: "rei.com" is a brand and "espresso-parts-
 * direct.example" is a small shop, and the length of the registrable label is
 * the only thing separating them that a SERP response actually carries. It is
 * used to *disqualify* a winnable signal, so being wrong costs a candidate a
 * caution it might not deserve — never a page nobody should have written.
 */
const MAJOR_BRAND_LABEL_MAX_LENGTH = 12;

/** UGC results in the top five before the SERP counts as hard. One Reddit
 *  thread among four articles is a normal SERP; two is a verdict. */
const UGC_TOP5_HARD_COUNT = 2;

/** Weakness is read in positions 6–10 only, and there are exactly five of
 *  them — the cap is belt-and-braces against a provider that renumbers. */
const WEAKNESS_FIRST_POSITION = 6;
const WEAKNESS_LAST_POSITION = 10;
const WEAKNESS_MAX = 5;

/** A snippet this short is a stub or a category page, not an article. The
 *  description is the only body signal a SERP response gives us, so this is
 *  the honest limit of "thin" at plan time. */
const THIN_DESCRIPTION_CHARS = 80;

/** A result whose own title or snippet advertises a year this old is coasting
 *  on an update nobody made. Three years clears the "2024 guide published in
 *  late 2023" false positive. */
const AGED_RESULT_YEARS = 3;

/** Results above this are the incumbents; a winnable signal has to come from
 *  below them. */
const WINNABLE_MIN_POSITION = 3;

// ---------------------------------------------------------------------------
// Reading one SERP
// ---------------------------------------------------------------------------

function registrableLabel(domain: string): string {
  const host = domain.toLowerCase().replace(/^www\./, "");
  const labels = host.split(".").filter(Boolean);
  // The longest non-TLD label is the stem — crude against "acme.co.uk", where
  // "acme" still wins on length (the brandTokens heuristic's own reasoning).
  let stem = "";
  for (const label of labels.slice(0, -1)) {
    if (label.length >= stem.length) stem = label;
  }
  return stem;
}

function isUgcResult(result: SerpOrganicResult): boolean {
  const host = result.domain.toLowerCase().replace(/^www\./, "");
  for (const entry of UGC_DOMAINS) {
    if (host === entry || host.endsWith(`.${entry}`)) return true;
  }
  return FORUM_MARKERS.some(
    (marker) => marker.test(host) || marker.test(result.url),
  );
}

/** True when the URL is the site's root — no path segments to speak of. */
function isHomepage(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") === "";
  } catch {
    return false;
  }
}

export function isMajorBrand(result: SerpOrganicResult): boolean {
  const host = result.domain.toLowerCase().replace(/^www\./, "");
  for (const entry of MAJOR_DOMAINS) {
    if (host === entry || host.endsWith(`.${entry}`)) return true;
  }
  return (
    registrableLabel(host).length < MAJOR_BRAND_LABEL_MAX_LENGTH &&
    isHomepage(result.url)
  );
}

/** A four-digit year in the title or snippet, at least AGED_RESULT_YEARS
 *  behind `now`. Titles carry these far more reliably than any date field a
 *  SERP response exposes. */
function isAged(result: SerpOrganicResult, now: Date): boolean {
  const text = `${result.title} ${result.description ?? ""}`;
  const years = [...text.matchAll(/\b(19|20)\d{2}\b/g)].map((match) =>
    Number(match[0]),
  );
  if (years.length === 0) return false;
  return Math.max(...years) <= now.getUTCFullYear() - AGED_RESULT_YEARS;
}

function isThin(result: SerpOrganicResult): boolean {
  return (result.description ?? "").trim().length < THIN_DESCRIPTION_CHARS;
}

/**
 * Read one sampled SERP.
 *
 * The two windows never overlap: UGC in positions 1–5 is counted as hardness
 * and NOTHING in the top five is ever counted as weakness. That separation is
 * the whole point — the same Reddit thread means "don't bother" at position 2
 * and "there's room" at position 8.
 */
export function readSerpSample(
  sample: SerpSample,
  now: Date,
): SerpSampleReading {
  let ugcTop5 = 0;
  let weakness = 0;
  let winnableSignal = false;

  for (const result of sample.organic) {
    if (result.position <= 5) {
      if (isUgcResult(result)) ugcTop5 += 1;
    } else if (
      result.position >= WEAKNESS_FIRST_POSITION &&
      result.position <= WEAKNESS_LAST_POSITION &&
      (isUgcResult(result) || isThin(result) || isAged(result, now))
    ) {
      weakness += 1;
    }
    if (result.position > WINNABLE_MIN_POSITION && !isMajorBrand(result)) {
      winnableSignal = true;
    }
  }

  return {
    keyword: sample.keyword,
    ugcTop5,
    weakness: Math.min(weakness, WEAKNESS_MAX),
    aiOverview: sample.aiOverview,
    featuredSnippet: sample.featuredSnippet,
    winnableSignal,
  };
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

function isMajority(count: number, total: number): boolean {
  return count * 2 > total;
}

/** The check row for a candidate nothing was spent on. Both callers — no
 *  provider key, and a budget that ran out — pass their own reason, because
 *  "not sampled" without a why is the kind of silence this product doesn't
 *  do. */
export function unsampledSerpCheck(reason: string): PageTypeSerpCheck {
  return {
    status: "unsampled",
    reason,
    sampled: 0,
    hardSerps: 0,
    aiOverviews: 0,
    weakSlots: 0,
    winnable: 0,
    samples: [],
  };
}

/**
 * Turn a candidate's readings into its verdict.
 *
 * Kill comes first and is about the SERP itself: UGC owning the top five in
 * most of the sample, or not one result below the top three that isn't a
 * brand. Caution is about the odds, not the impossibility — an AI Overview
 * eating the clicks, or a cluster whose hard half sits above the difficulty
 * this project has earned. Everything else is ok, and "ok" is a statement
 * about a sample of six keywords, which is why the reason says so.
 */
export function judgeCandidateSerp(input: {
  readings: SerpSampleReading[];
  /** p75 of the candidate's KD band; null when nothing in it carries a KD. */
  kdBandP75: number | null;
  /** The project's adaptive KD ceiling (S5). */
  kdCeiling: number | null;
}): PageTypeSerpCheck {
  const { readings } = input;
  if (readings.length === 0) {
    return unsampledSerpCheck("Not sampled.");
  }

  const total = readings.length;
  const hardSerps = readings.filter(
    (reading) => reading.ugcTop5 >= UGC_TOP5_HARD_COUNT,
  ).length;
  const aiOverviews = readings.filter((reading) => reading.aiOverview).length;
  const winnable = readings.filter((reading) => reading.winnableSignal).length;
  const base = {
    sampled: total,
    hardSerps,
    aiOverviews,
    weakSlots: readings.reduce((sum, reading) => sum + reading.weakness, 0),
    winnable,
    samples: readings,
  };

  if (isMajority(hardSerps, total)) {
    return {
      ...base,
      status: "kill",
      reason: `Forums and Reddit hold at least ${UGC_TOP5_HARD_COUNT} of the top 5 on ${hardSerps} of ${total} sampled keywords — that is a hard SERP, not a weak one.`,
    };
  }
  if (winnable === 0) {
    return {
      ...base,
      status: "kill",
      reason: `Nothing below position ${WINNABLE_MIN_POSITION} on any of the ${total} sampled keywords is anything but a major brand.`,
    };
  }
  if (isMajority(aiOverviews, total)) {
    return {
      ...base,
      status: "caution",
      reason: `An AI Overview sits above the results on ${aiOverviews} of ${total} sampled keywords — expect fewer clicks than the volume suggests.`,
    };
  }
  if (
    input.kdBandP75 !== null &&
    input.kdCeiling !== null &&
    input.kdBandP75 > input.kdCeiling
  ) {
    return {
      ...base,
      status: "caution",
      reason: `The hard half of this cluster (KD ${input.kdBandP75}) sits above the difficulty you have earned so far (${input.kdCeiling}).`,
    };
  }
  return {
    ...base,
    status: "ok",
    reason: `${winnable} of ${total} sampled keywords have a result below position ${WINNABLE_MIN_POSITION} that isn't a major brand. This is a sample, not a survey.`,
  };
}
