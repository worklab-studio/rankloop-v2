// The three outreach message shapes (spec 0015), rendered by substitution and
// nothing else. No LLM, no network, no randomness: the same target and the
// same asset produce the same text on every recompute, and every clause in
// that text is either about your own page or quoted from the stored evidence.
// Unit-tested directly in templates.logic.test.ts.
//
// House rules the shapes below are written to: plain text, under 120 words,
// no flattery opener, nothing asserted about their site that the evidence
// does not contain, and no hard ask at the end — the draft is a starting
// point a human edits and sends, so it must not read as finished.

import type { LinkGapTarget } from "@/server/features/rankloop/outreach/linkGap.logic";
import type {
  OutreachEvidence,
  OutreachMatchType,
  OutreachTemplateKind,
} from "@/types/schemas/rankloopOutreach";

type DraftAsset = {
  path: string;
  url: string;
  title: string | null;
};

// Three competitors named is enough to show the pattern; the rest is a list
// nobody reads and starts to read like a threat.
const QUOTED_EVIDENCE_LIMIT = 3;

/**
 * Which shape to write. A data-shaped asset is offered as a citation because
 * that is the one ask a stranger grants without a relationship; everything
 * else is the resource-page pitch. No asset means no template — a target with
 * nothing of ours to point at is still worth listing, and still gets no
 * fabricated message.
 *
 * 'broken_link' is never chosen here. It needs link-status checking that S4b
 * does not do, and guessing that a link is dead is the fastest way to look
 * like a bot.
 */
export function chooseTemplateKind(
  shape: OutreachMatchType["shape"] | null,
): OutreachTemplateKind | null {
  if (shape === null) return null;
  return shape === "data" ? "data_citation" : "resource_page";
}

/** "a, b and c" — the Oxford-comma-free list the drafts read out loud. */
function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * What this domain links to, said exactly as far as the evidence goes: the
 * competitor's page when a per-link source named one, the competitor's domain
 * when all we have is a referring-domains row. Never both, never a guess.
 */
function evidencePhrase(evidence: OutreachEvidence[]): string {
  return joinList(
    evidence.slice(0, QUOTED_EVIDENCE_LIMIT).map((entry) => {
      if (!entry.targetUrl) return entry.competitorDomain;
      try {
        const url = new URL(entry.targetUrl);
        return `${entry.competitorDomain}${url.pathname}`;
      } catch {
        return entry.competitorDomain;
      }
    }),
  );
}

/** The asset as a human would name it. A manifest row can have no title —
 *  crawls miss them and publish-appended rows arrive without one — and the
 *  path is a better handle than "our page". */
function assetName(asset: DraftAsset): string {
  return asset.title?.trim() || asset.path;
}

/** The first number in the title, which on a data page is the finding: "47%",
 *  "1,284". Null when the title carries none, and then the citation draft
 *  leads with the page instead of inventing a figure. */
function leadingFigure(title: string | null): string | null {
  return title?.match(/\d[\d,.]*\s?%?/)?.[0].trim() ?? null;
}

function resourcePageDraft(input: {
  siteName: string;
  target: LinkGapTarget;
  asset: DraftAsset;
}): string {
  return [
    `Hi — I run ${input.siteName}.`,
    `I was mapping who links out in this space and ${input.target.domain} came up: it links to ${evidencePhrase(input.target.evidence)}.`,
    `We published ${assetName(input.asset)} (${input.asset.url}) on the same subject.`,
    // The one sentence only the sender can write. rankloop has never read
    // their page or ours, so a generated comparison here would be the exact
    // fabrication this feature exists to avoid — it ships as a slot instead.
    `[One line on what yours adds that the page you link to doesn't — you can see both, rankloop can't.]`,
    `Passing it along in case it earns a spot. No reply needed either way.`,
  ].join("\n\n");
}

function dataCitationDraft(input: {
  siteName: string;
  target: LinkGapTarget;
  asset: DraftAsset;
}): string {
  const figure = leadingFigure(input.asset.title);
  const lead = figure
    ? `${figure} is the headline number in ${assetName(input.asset)} (${input.asset.url}).`
    : `${assetName(input.asset)} (${input.asset.url}) is the data page we keep on this subject.`;

  return [
    `Hi — I run ${input.siteName}.`,
    lead,
    `I'm sending it because ${input.target.domain} links to ${evidencePhrase(input.target.evidence)}, so the subject looks in scope for you.`,
    `Cite it if it's ever useful. No reply needed.`,
  ].join("\n\n");
}

/**
 * Render one draft, or null when the requested shape has nothing to say.
 *
 * The stored draft is written once at generation and then belongs to the
 * human: a later recompute refreshes the evidence around it and leaves the
 * text alone, so what this function returns is a first draft, never a
 * replacement for one.
 */
export function renderDraftMessage(input: {
  kind: OutreachTemplateKind;
  siteName: string;
  target: LinkGapTarget;
  asset: DraftAsset;
}): string | null {
  switch (input.kind) {
    case "resource_page":
      return resourcePageDraft(input);
    case "data_citation":
      return dataCitationDraft(input);
    case "broken_link":
      // Reserved. The pitch is "the link on your page is dead, here is a live
      // one" — a claim rankloop cannot make until something checks link
      // status, and a wrong one burns the domain for good. The branch exists
      // so landing that step is code, not a schema change.
      return null;
  }
}
