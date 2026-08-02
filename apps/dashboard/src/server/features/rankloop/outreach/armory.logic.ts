// The Grow armory: classifying and scoring link targets (spec 0029).
//
// Three lanes feed one board — the curated seed pack, SERP-mined listicles,
// and competitor referring pages that look submittable. This file is the
// pure half: what kind of target a URL is, how attainable it looks, and how
// to dedupe across lanes. No I/O, no provider calls.

export type TargetLane = "link_gap" | "seed" | "serp" | "backlink_submit";
export type TargetKind = "directory" | "listicle" | "blog" | "resource_page";

// ---------------------------------------------------------------------------
// Submission shapes
// ---------------------------------------------------------------------------

/**
 * URL fragments that mean "this page accepts additions".
 *
 * Deliberately path fragments rather than a general classifier: a page at
 * `/submit` or `/add-listing` is telling you outright what it is, and
 * guessing beyond that produces targets a human then has to disqualify one
 * by one, which is worse than a shorter list.
 */
const SUBMISSION_PATHS = [
  "/submit",
  "/add-listing",
  "/add-tool",
  "/add-product",
  "/suggest",
  "/new-listing",
  "/get-listed",
  "/list-your",
] as const;

/**
 * Fragments that mean "this page is a roundup", which accepts additions by
 * editorial request rather than a form.
 *
 * Substrings, not path prefixes. The obvious spelling — `"/alternatives"` —
 * misses `/notion-alternatives`, which is the single most valuable shape on
 * this list and the one the mining queries go looking for.
 */
const LISTICLE_FRAGMENTS = [
  "best-",
  "top-",
  "alternatives",
  "-vs-",
  "comparison",
  "roundup",
] as const;

/** `best-practices` is a blog post about doing something well, not a list of
 *  products to be added to. It is the one false positive `best-` reliably
 *  produces, so it is excluded by name rather than by a cleverer rule. */
const LISTICLE_EXCLUSIONS = ["best-practice"] as const;

const DIRECTORY_PATHS = ["/directory", "/tools/", "/software/", "/categories"] as const;

/** Pages nobody can be pitched. Same rationale as the link-gap filter: a row
 *  that cannot succeed is worse than no row, because it costs a human the
 *  time to work out that it cannot succeed. */
const NON_TARGET_PATHS = [
  "/login",
  "/signin",
  "/signup",
  "/register",
  "/pricing",
  "/privacy",
  "/terms",
  "/cart",
  "/checkout",
] as const;

function pathOf(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return "";
  }
}

export function isNonTarget(url: string): boolean {
  const path = pathOf(url);
  return NON_TARGET_PATHS.some((p) => path.startsWith(p));
}

/** Does this page look like it takes submissions through a form? */
export function looksSubmittable(url: string): boolean {
  const path = pathOf(url);
  return SUBMISSION_PATHS.some((p) => path.includes(p));
}

/**
 * What kind of target a URL is, from its shape alone.
 *
 * Order matters: a submission form inside a directory is still a directory
 * to the person filling it in, and `/best-crm-tools/submit` should read as a
 * form rather than a roundup.
 */
export function classifyTarget(url: string): TargetKind {
  const path = pathOf(url);
  if (SUBMISSION_PATHS.some((p) => path.includes(p))) return "directory";
  if (DIRECTORY_PATHS.some((p) => path.includes(p))) return "directory";

  const excluded = LISTICLE_EXCLUSIONS.some((p) => path.includes(p));
  if (!excluded && LISTICLE_FRAGMENTS.some((p) => path.includes(p))) {
    // Checked before `/blog/`: a roundup published on a blog is still a
    // roundup, and "10 best CRM tools" at /blog/best-crm-tools is exactly
    // the page worth asking to be added to.
    return "listicle";
  }
  if (/\/(blog|posts?|articles?)\//.test(path)) return "blog";
  return "resource_page";
}

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

/**
 * The key three lanes dedupe on.
 *
 * Registrable-ish: strip `www.` and lowercase, but do NOT try to strip
 * arbitrary subdomains. `blog.example.com` and `example.com` are genuinely
 * different targets with different editors, and collapsing them loses one.
 */
export function targetKey(domainOrUrl: string): string {
  let host = domainOrUrl.trim().toLowerCase();
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname.toLowerCase();
    } catch {
      /* fall through to the raw string */
    }
  }
  return host.replace(/^www\./, "").replace(/\/+$/, "");
}

/**
 * Merge rows from several lanes, keeping the richest version of each domain.
 *
 * Lane precedence is by how much a row can tell you: a seed entry knows the
 * submission URL and what the form wants; a link-gap row knows which
 * competitors are already there. When both exist the merged row carries
 * both, so a domain found twice reads as stronger rather than appearing
 * twice.
 */
export interface ArmoryCandidate {
  domain: string;
  lane: TargetLane;
  kind: TargetKind;
  submissionUrl: string | null;
  /** Why this target is plausible, in the user's words. */
  evidence: string;
  domainRank: number | null;
  competitorCount: number;
}

const LANE_RANK: Record<TargetLane, number> = {
  seed: 3,
  backlink_submit: 2,
  serp: 1,
  link_gap: 0,
};

export function dedupeCandidates(
  candidates: readonly ArmoryCandidate[],
): ArmoryCandidate[] {
  const byKey = new Map<string, ArmoryCandidate>();

  for (const candidate of candidates) {
    const key = targetKey(candidate.domain);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, { ...candidate });
      continue;
    }
    // Keep the lane that knows the most, but never lose the other lane's
    // facts — a seed target that competitors also link to is the best kind
    // of row on the board.
    const winner =
      LANE_RANK[candidate.lane] > LANE_RANK[existing.lane] ? candidate : existing;
    const other = winner === candidate ? existing : candidate;
    byKey.set(key, {
      ...winner,
      submissionUrl: winner.submissionUrl ?? other.submissionUrl,
      domainRank: winner.domainRank ?? other.domainRank,
      competitorCount: Math.max(winner.competitorCount, other.competitorCount),
      evidence:
        winner.evidence === other.evidence
          ? winner.evidence
          : `${winner.evidence} · ${other.evidence}`,
    });
  }

  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface ScoredTarget extends ArmoryCandidate {
  score: number;
  /** The sentence the board shows under the score. */
  why: string;
}

/**
 * Attainability, from observable facts rather than vibes.
 *
 * A form you can fill in beats an editorial pitch. A page already listing
 * two of your competitors is proof the category is accepted. And a domain
 * far stronger than yours is LESS attainable, not more valuable — the
 * instinct to sort by domain rank puts the least winnable rows on the first
 * screen, which is how a board becomes decoration.
 */
export function attainability(input: {
  kind: TargetKind;
  submissionUrl: string | null;
  competitorCount: number;
  domainRank: number | null;
  yourDomainRank: number | null;
}): number {
  let score = 0.4;

  if (input.submissionUrl !== null) score += 0.3;
  if (input.kind === "directory") score += 0.1;
  if (input.kind === "blog") score -= 0.1;

  // Proof the category is accepted here.
  if (input.competitorCount >= 2) score += 0.2;
  else if (input.competitorCount === 1) score += 0.05;

  // A gap of more than ~30 rank points is a different league.
  if (input.domainRank !== null && input.yourDomainRank !== null) {
    const gap = input.domainRank - input.yourDomainRank;
    if (gap > 30) score -= 0.2;
    else if (gap > 15) score -= 0.1;
  }

  return Math.max(0, Math.min(1, score));
}

export function scoreTarget(
  candidate: ArmoryCandidate,
  yourDomainRank: number | null,
): ScoredTarget {
  const reach = candidate.domainRank ?? 0;
  const ease = attainability({
    kind: candidate.kind,
    submissionUrl: candidate.submissionUrl,
    competitorCount: candidate.competitorCount,
    domainRank: candidate.domainRank,
    yourDomainRank,
  });

  // Reach is worth having and worth nothing if you cannot get it, so the two
  // multiply rather than add. `+1` keeps an unranked domain from zeroing a
  // perfectly attainable target — plenty of good directories have no rank.
  const score = Math.round((reach + 1) * ease * 10) / 10;

  return { ...candidate, score, why: whySentence(candidate, ease) };
}

function whySentence(candidate: ArmoryCandidate, ease: number): string {
  const parts: string[] = [];
  if (candidate.competitorCount >= 2) {
    parts.push(`lists ${candidate.competitorCount} of your competitors`);
  } else if (candidate.competitorCount === 1) {
    parts.push("lists one of your competitors");
  }
  if (candidate.submissionUrl !== null) parts.push("takes submissions directly");
  if (candidate.domainRank !== null) parts.push(`domain rank ${candidate.domainRank}`);
  if (parts.length === 0) {
    return ease >= 0.5 ? "Open to additions" : "Editorial pitch";
  }
  return parts.join(" · ");
}

/** Highest score first; ties broken by the lane that knows the most, so a
 *  seed entry with a submission URL outranks a bare SERP hit. */
export function rankTargets(
  candidates: readonly ArmoryCandidate[],
  yourDomainRank: number | null,
): ScoredTarget[] {
  return dedupeCandidates(candidates)
    .map((c) => scoreTarget(c, yourDomainRank))
    .toSorted(
      (a, b) => b.score - a.score || LANE_RANK[b.lane] - LANE_RANK[a.lane],
    );
}

// ---------------------------------------------------------------------------
// SERP mining queries
// ---------------------------------------------------------------------------

/**
 * The submission-shaped queries for a category.
 *
 * These surface pages that already rank for the terms you want AND accept
 * additions — which is the whole trick. A generic "{noun}" query returns the
 * category's incumbents; these return the lists the incumbents are on.
 *
 * `year` is passed in rather than read from the clock so the caller controls
 * it and the function stays pure.
 */
export function miningQueries(noun: string, year: number): string[] {
  const term = noun.trim().toLowerCase();
  if (term === "") return [];
  return [
    `best ${term} tools`,
    `top ${term} software`,
    `${term} alternatives`,
    `${term} directory`,
    `submit ${term}`,
    `${term} tools ${year}`,
  ];
}
