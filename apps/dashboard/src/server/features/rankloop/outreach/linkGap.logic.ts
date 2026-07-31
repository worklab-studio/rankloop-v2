// Pure functions behind the outreach planner (spec 0015): the link gap —
// domains linking to two or more tracked competitors but not to you — and the
// asset match that pairs each surviving target with one of your own pages.
// No I/O, no provider calls, no model calls — unit-tested directly in
// linkGap.logic.test.ts.

import type {
  OutreachEvidence,
  OutreachMatchType,
} from "@/types/schemas/rankloopOutreach";

// ---------------------------------------------------------------------------
// The gap
// ---------------------------------------------------------------------------

// One shared link is a coincidence — a syndicated release, a directory
// everyone ends up in. Two independent competitors is a domain that links out
// to this niche on purpose, which is the only kind worth a human's morning.
const MIN_COMPETITORS = 2;

// A hundred targets is already more outreach than a month holds, and the tail
// past it is domains carrying one weak link each.
const TARGET_LIMIT = 100;

/**
 * Domains that link to everyone and answer to no one.
 *
 * Every one of these would top the gap on competitor count alone — they link
 * to all of your competitors, and to their competitors — and none of them has
 * someone on the other end who adds a link because a stranger asked. Left in,
 * they would fill the first screen of the board with work that cannot
 * succeed, which is worse than an empty board.
 *
 * A named list, not a regex over the hostname: "search.acme.com" is a real
 * publisher and must stay a target, while any subdomain of an entry below is
 * the same platform and is dropped with it.
 */
const NON_TARGET_DOMAINS = new Set([
  // Social networks and UGC platforms — links are posts, not editorial.
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "medium.com",
  "pinterest.com",
  "quora.com",
  "reddit.com",
  "substack.com",
  "threads.net",
  "tiktok.com",
  "tumblr.com",
  "twitter.com",
  "vk.com",
  "x.com",
  "youtube.com",
  // Search engines and their properties.
  "baidu.com",
  "bing.com",
  "duckduckgo.com",
  "google.com",
  "yahoo.com",
  "yandex.ru",
  // Directories, archives and the platform hosts every site links to.
  "amazon.com",
  "apple.com",
  "archive.org",
  "blogspot.com",
  "cloudflare.com",
  "creativecommons.org",
  "github.com",
  "godaddy.com",
  "gravatar.com",
  "microsoft.com",
  "squarespace.com",
  "w3.org",
  "wikipedia.org",
  "wix.com",
  "wordpress.com",
  "wordpress.org",
]);

export type LinkGapSourceRow = {
  competitorId: string;
  competitorDomain: string;
  /** The referring domain, as the provider spelled it. */
  domain: string;
  domainRank: number | null;
  backlinks: number | null;
  /** Present only when the source knew which page was linked; see the
   *  OutreachEvidence doc-comment for why S4b never fills these. */
  targetUrl?: string | null;
  anchor?: string | null;
};

export type LinkGapTarget = {
  domain: string;
  domainRank: number | null;
  competitorCount: number;
  evidence: OutreachEvidence[];
};

/** Lowercase, drop the leading www, drop a trailing dot — the same domain
 *  written three ways by three endpoints must group as one target. */
function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
}

/** True when `domain` is `root` or sits under it. Used for both the
 *  non-target list and the project's own domain. */
function isSelfOrSubdomain(domain: string, root: string): boolean {
  return domain === root || domain.endsWith(`.${root}`);
}

function isNonTarget(domain: string): boolean {
  for (const entry of NON_TARGET_DOMAINS) {
    if (isSelfOrSubdomain(domain, entry)) return true;
  }
  return false;
}

/**
 * The link gap: who links to two or more of the competitors you track, and
 * not to you.
 *
 * Exclusions run before the count, not after, so a domain that only reaches
 * the threshold via an excluded competitor never appears. `ourDomains` is
 * whatever the backlinks feature already had cached — keyless it arrives
 * empty, which costs precision (a domain already linking to you shows up as a
 * target) but never invents one.
 *
 * Ranking is competitorCount first because the count is the finding; domain
 * rank only breaks its ties, and the domain name breaks those, so two
 * recomputes over the same rows return the same order.
 */
export function computeLinkGap(input: {
  competitorDomains: LinkGapSourceRow[];
  ourDomains: string[];
  ourDomain: string | null;
}): LinkGapTarget[] {
  const ours = new Set(input.ourDomains.map(normalizeDomain));
  const ownRoot = input.ourDomain ? normalizeDomain(input.ourDomain) : null;

  const grouped = new Map<string, LinkGapTarget>();
  for (const row of input.competitorDomains) {
    const domain = normalizeDomain(row.domain);
    if (!domain) continue;
    if (ours.has(domain)) continue;
    if (ownRoot && isSelfOrSubdomain(domain, ownRoot)) continue;
    if (isSelfOrSubdomain(domain, normalizeDomain(row.competitorDomain)))
      continue;
    if (isNonTarget(domain)) continue;

    const existing = grouped.get(domain);
    const target = existing ?? {
      domain,
      domainRank: null,
      competitorCount: 0,
      evidence: [],
    };
    // The same domain can be reported with different ranks per competitor
    // (each reading is a snapshot); keep the highest so the column matches
    // the best evidence we have rather than the last row read.
    if (row.domainRank !== null) {
      target.domainRank = Math.max(target.domainRank ?? 0, row.domainRank);
    }
    // One evidence entry per competitor: a second row for a competitor
    // already counted refreshes nothing and must not inflate the count.
    if (!target.evidence.some((e) => e.competitorId === row.competitorId)) {
      target.evidence.push({
        competitorId: row.competitorId,
        competitorDomain: normalizeDomain(row.competitorDomain),
        backlinks: row.backlinks,
        targetUrl: row.targetUrl ?? null,
        anchor: row.anchor ?? null,
      });
      target.competitorCount += 1;
    }
    if (!existing) grouped.set(domain, target);
  }

  return [...grouped.values()]
    .filter((target) => target.competitorCount >= MIN_COMPETITORS)
    .toSorted(
      (a, b) =>
        b.competitorCount - a.competitorCount ||
        (b.domainRank ?? -1) - (a.domainRank ?? -1) ||
        a.domain.localeCompare(b.domain),
    )
    .slice(0, TARGET_LIMIT);
}

// ---------------------------------------------------------------------------
// Asset matching
// ---------------------------------------------------------------------------

// Tokens under 3 chars ("a", "of", "10") match everything and mean nothing —
// the same floor the push inlink heuristic uses in execution.logic.ts.
const MIN_TOKEN_LENGTH = 3;

// Tokens carried by half the web's URLs. They overlap everything, so leaving
// them in would match every target to whichever of your pages happens to sit
// under /blog/.
const NON_TOPIC_TOKENS = new Set([
  "blog",
  "com",
  "home",
  "html",
  "index",
  "net",
  "news",
  "online",
  "org",
  "page",
  "post",
  "posts",
  "site",
  "web",
  "www",
]);

// Paths that read as a citable number, and paths that read as a reference
// piece. Shape decides the template — a data page is offered as a citation,
// everything else as a resource — and breaks scoring ties, because a
// resources page links to guides and datasets, not to pricing pages.
const DATA_PATH_TOKENS = new Set([
  "benchmark",
  "benchmarks",
  "data",
  "dataset",
  "report",
  "reports",
  "research",
  "statistics",
  "stats",
  "study",
  "survey",
  "trends",
]);

const GUIDE_PATH_TOKENS = new Set([
  "checklist",
  "comparison",
  "glossary",
  "guide",
  "guides",
  "handbook",
  "how",
  "playbook",
  "tutorial",
  "tutorials",
]);

const CITABLE_SHAPE_BONUS = 1;

type AssetPage = {
  id: string;
  path: string;
  title: string | null;
};

type AssetMatch = {
  pageId: string;
  matchType: OutreachMatchType;
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(
      (token) =>
        token.length >= MIN_TOKEN_LENGTH && !NON_TOPIC_TOKENS.has(token),
    );
}

/** Path tokens of a URL, tolerating the bare paths and malformed rows a
 *  crawl can persist. */
function urlPathTokens(url: string): string[] {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // Already a path, or not a URL at all — tokenize what we were given.
  }
  return tokenize(path);
}

/**
 * What a target is about, in tokens.
 *
 * First choice is the competitor URLs it links to: those name the subject the
 * domain chose to link about. When the evidence has none — which is every row
 * a referring-domains study writes — the linking domain's own name is the
 * only topic signal that exists, and "espresso-gear.example" does carry one.
 * The final label is dropped because it is the public suffix, not a topic.
 */
function targetTokens(target: LinkGapTarget): {
  tokens: Set<string>;
  reason: OutreachMatchType["reason"];
} {
  const linked = target.evidence.flatMap((entry) =>
    entry.targetUrl ? urlPathTokens(entry.targetUrl) : [],
  );
  if (linked.length > 0) {
    return { tokens: new Set(linked), reason: "linked_url_tokens" };
  }
  const labels = target.domain.split(".").slice(0, -1).join(" ");
  return { tokens: new Set(tokenize(labels)), reason: "domain_tokens" };
}

/** The asset's shape, which picks the template and breaks scoring ties. */
function assetShape(path: string): OutreachMatchType["shape"] {
  const tokens = tokenize(path);
  if (tokens.some((token) => DATA_PATH_TOKENS.has(token))) return "data";
  if (tokens.some((token) => GUIDE_PATH_TOKENS.has(token))) return "guide";
  return "page";
}

/**
 * Pick the page of yours to pitch to one target, or nothing.
 *
 * Deliberately naive: shared tokens are what the manifest already knows
 * without a model call, and a human reads the draft before it goes anywhere.
 * A page with zero token overlap is never padded in — the citable-shape bonus
 * can only break ties between pages that already share a token, or a data
 * page unrelated to the target would win every match by shape alone. No
 * overlap at all means no asset and no template, which the board renders as
 * "— no match" rather than as a guess.
 */
export function matchAssetPage(input: {
  target: LinkGapTarget;
  pages: AssetPage[];
}): AssetMatch | null {
  const { tokens, reason } = targetTokens(input.target);
  if (tokens.size === 0) return null;

  let best: (AssetMatch & { score: number; path: string }) | null = null;
  for (const page of input.pages) {
    const shared = [...new Set(tokenize(page.path))].filter((token) =>
      tokens.has(token),
    );
    if (shared.length === 0) continue;

    const shape = assetShape(page.path);
    const score = shared.length + (shape === "page" ? 0 : CITABLE_SHAPE_BONUS);
    // Path breaks score ties so a recompute over unchanged data picks the
    // same page every time.
    const wins =
      best === null ||
      score > best.score ||
      (score === best.score && page.path.localeCompare(best.path) < 0);
    if (wins) {
      best = {
        pageId: page.id,
        matchType: { reason, shape, tokens: shared.toSorted() },
        score,
        path: page.path,
      };
    }
  }

  return best === null
    ? null
    : { pageId: best.pageId, matchType: best.matchType };
}
