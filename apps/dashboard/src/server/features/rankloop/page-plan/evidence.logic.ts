// Pure functions behind the approval card's evidence sentence (spec 0017):
// how much of a tracked competitor's earning traffic already comes from pages
// shaped like this candidate. Reads S4a's stored study (studySummaryJson +
// competitor_pages) and nothing else. No I/O — unit-tested directly in
// evidence.logic.test.ts.
//
// The honesty rule this module exists to keep: no matching competitor data
// means the sentence is omitted, never estimated. A card that guessed "41%"
// from an unstudied competitor would be the one number a founder trusts most
// and the one we had least right.

import {
  matchPattern,
  stems,
  type PageTypeCandidate,
} from "@/server/features/rankloop/page-plan/planner.logic";

/** One tracked competitor as the evidence pass sees it. `studied` is false
 *  until S4a has written a playbook for it — an unstudied competitor
 *  contributes no evidence, which is different from contributing zero. */
export type EvidenceCompetitor = {
  domain: string;
  studied: boolean;
  pages: Array<{ url: string; etv: number | null }>;
};

export type PageTypeEvidence =
  | {
      hasCompetitorSignal: false;
      /** Competitors that were studied but carry no page of this shape —
       *  the card says "no competitor signal for this shape" either way, and
       *  this number is what makes that statement checkable. */
      competitorsChecked: number;
    }
  | {
      hasCompetitorSignal: true;
      /** The competitor the sentence names: the one earning the largest
       *  share from this shape. */
      leadDomain: string;
      matchedPages: number;
      totalPages: number;
      /** Whole percent of the competitor's earning pages with this shape. */
      pageSharePct: number;
      /** Whole percent of its earning traffic those pages represent, or null
       *  when the provider priced none of them. */
      etvSharePct: number | null;
      competitorsChecked: number;
      competitorsWithSignal: number;
    };

/**
 * Does one competitor URL read as this candidate's shape?
 *
 * The path is de-slugged back into words and run through the same table the
 * keywords went through, so "/breville-vs-delonghi/" lands on Comparisons for
 * exactly the reason "breville vs delonghi" did — including precedence, so a
 * URL that reads as two shapes counts once, for the same one our own keyword
 * would have. Editorial clusters have no URL shape to match, so they match on
 * carrying every stem the cluster is named for.
 */
export function pageMatchesCandidate(
  candidate: PageTypeCandidate,
  url: string,
): boolean {
  const text = deslug(url);
  if (candidate.kind === "blog") {
    if (candidate.clusterTokens.length === 0) return false;
    const pathStems = new Set(stems(text));
    return candidate.clusterTokens.every((token) => pathStems.has(token));
  }
  return matchPattern(text)?.key === candidate.key;
}

/** A URL path as words: host dropped, separators to spaces. Query strings and
 *  extensions go with them — "/best-grinders.html?ref=x" is about grinders. */
function deslug(url: string): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // Already a path, or not parseable — de-slug what we were given.
  }
  return path.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[^a-zA-Z0-9]+/g, " ");
}

/**
 * The evidence one candidate can honestly claim.
 *
 * Share is computed per competitor and the strongest one is named, rather
 * than pooled across the tracked set: "41% of espressotoolbox.example's
 * traffic" is a claim about a real site a founder can go and look at, while a
 * blended share across five competitors is a number nobody can check.
 *
 * The denominator is the top-earning pages S4a stored, not the competitor's
 * whole site — which is why the sentence says "earns X% of its search
 * traffic", scoped to the cohort that earns any.
 */
export function computeCandidateEvidence(input: {
  candidate: PageTypeCandidate;
  competitors: EvidenceCompetitor[];
}): PageTypeEvidence {
  const studied = input.competitors.filter(
    (competitor) => competitor.studied && competitor.pages.length > 0,
  );

  let lead: {
    domain: string;
    matchedPages: number;
    totalPages: number;
    pageSharePct: number;
    etvSharePct: number | null;
  } | null = null;
  let withSignal = 0;

  for (const competitor of studied) {
    const matched = competitor.pages.filter((page) =>
      pageMatchesCandidate(input.candidate, page.url),
    );
    if (matched.length === 0) continue;
    withSignal += 1;

    const totalEtv = sumEtv(competitor.pages);
    const matchedEtv = sumEtv(matched);
    const reading = {
      domain: competitor.domain,
      matchedPages: matched.length,
      totalPages: competitor.pages.length,
      pageSharePct: Math.round(
        (matched.length / competitor.pages.length) * 100,
      ),
      // No priced page anywhere in the cohort means no traffic share exists
      // to report — the card falls back to the page count.
      etvSharePct:
        totalEtv > 0 ? Math.round((matchedEtv / totalEtv) * 100) : null,
    };
    // Traffic share leads; the page share breaks ties for keyless studies
    // where nothing has an etv, and the domain breaks those so the sentence
    // names the same competitor on every recompute.
    const wins =
      lead === null ||
      (reading.etvSharePct ?? -1) > (lead.etvSharePct ?? -1) ||
      ((reading.etvSharePct ?? -1) === (lead.etvSharePct ?? -1) &&
        (reading.pageSharePct > lead.pageSharePct ||
          (reading.pageSharePct === lead.pageSharePct &&
            reading.domain.localeCompare(lead.domain) < 0)));
    if (wins) lead = reading;
  }

  if (lead === null) {
    return { hasCompetitorSignal: false, competitorsChecked: studied.length };
  }
  return {
    hasCompetitorSignal: true,
    leadDomain: lead.domain,
    matchedPages: lead.matchedPages,
    totalPages: lead.totalPages,
    pageSharePct: lead.pageSharePct,
    etvSharePct: lead.etvSharePct,
    competitorsChecked: studied.length,
    competitorsWithSignal: withSignal,
  };
}

function sumEtv(pages: Array<{ etv: number | null }>): number {
  return pages.reduce((sum, page) => sum + (page.etv ?? 0), 0);
}
