import type {
  OutreachEvidence,
  OutreachMatchType,
  OutreachStatus,
} from "@/types/schemas/rankloopOutreach";

// The board a human moves by hand. rankloop never sends anything, so it can
// never observe one of these transitions — every label names something the
// user did, not something the system saw, and the order is the order the work
// happens in.
export const OUTREACH_STATUS_OPTIONS: ReadonlyArray<{
  value: OutreachStatus;
  label: string;
}> = [
  { value: "to_contact", label: "To contact" },
  { value: "sent", label: "Sent" },
  { value: "replied", label: "Replied" },
  { value: "linked", label: "Linked" },
  { value: "declined", label: "Declined" },
];

/**
 * Host + path with the protocol and any www prefix dropped, so an evidence
 * line reads "rival.example/guides/x" rather than
 * "https://www.rival.example/guides/x". A bare host keeps no trailing slash;
 * unparseable values render whole rather than disappearing.
 */
export function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.host.replace(/^www\./, "");
    const path = `${parsed.pathname}${parsed.search}`;
    return path === "/" ? host : `${host}${path}`;
  } catch {
    return url;
  }
}

/**
 * One evidence line for the message modal. Everything S4b collects comes from
 * the referring-domains endpoint, which reports one row per linking domain —
 * so the usual line is "links to rival.example · 3 links" and the page-level
 * form ("links to rival.example/guides/x") only appears once a per-link
 * source fills targetUrl. The line says what the stored evidence says and
 * never a word more: the draft quotes it back to a stranger.
 */
export function evidenceLine(entry: OutreachEvidence): string {
  const target = entry.targetUrl
    ? shortUrl(entry.targetUrl)
    : entry.competitorDomain;
  const parts = [`links to ${target}`];
  if (entry.backlinks !== null) {
    parts.push(
      `${entry.backlinks.toLocaleString("en-US")} link${
        entry.backlinks === 1 ? "" : "s"
      }`,
    );
  }
  if (entry.anchor) parts.push(`“${entry.anchor}”`);
  return parts.join(" · ");
}

// Where the overlap was found. Named in plain words because the point of
// showing it is that a human can disagree with the match before writing to
// anyone.
const MATCH_REASON_SOURCE: Record<OutreachMatchType["reason"], string> = {
  linked_url_tokens: "the competitor pages it links to",
  domain_tokens: "the linking domain's own name",
};

/** The "why this page?" line under a matched asset, or null when nothing
 *  matched and there is no reason to give. */
export function matchReasonLine(
  matchType: OutreachMatchType | null,
): string | null {
  if (!matchType) return null;
  const source = MATCH_REASON_SOURCE[matchType.reason];
  if (matchType.tokens.length === 0) return `Matched on ${source}.`;
  return `Matched on ${source}: ${matchType.tokens.join(", ")}.`;
}

// The chip on a target nobody can recompute any more. It says what happened
// rather than what to do, because there is nothing to do: the row survives on
// the strength of the human's own work, and only they can decide whether a
// domain they already wrote to is still worth chasing.
export const OUTREACH_STALE_LABEL = "no longer in the gap";

/**
 * The chip's hover title, which is where the date lives — the label has to
 * stay one short line down a hundred rows. Dates are stored as ISO instants
 * and read as UTC days so a viewer west of Greenwich doesn't see a recompute
 * that ran at 01:00 UTC reported as the previous day. An unparseable stamp
 * degrades to the bare sentence rather than printing "Invalid Date".
 */
export function staleChipTitle(staleAsOf: string): string {
  const date = new Date(staleAsOf);
  if (Number.isNaN(date.getTime())) {
    return "These numbers are from the last refresh that still saw this domain.";
  }
  const day = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return `Left the gap on ${day}. These numbers are from the last refresh that still saw this domain.`;
}

/** The stamp under the targets table: what the gap was computed from. */
export function linkGapStamp(trackedCompetitors: number): string {
  return `link gap from ${trackedCompetitors} tracked competitor${
    trackedCompetitors === 1 ? "" : "s"
  } · refreshed with each monthly study`;
}
