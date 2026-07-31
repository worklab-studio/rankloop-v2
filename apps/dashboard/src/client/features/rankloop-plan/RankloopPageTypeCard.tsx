import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import {
  CardShell,
  moreDetailsClass,
} from "@/client/features/dashboard/cardParts";
import {
  authoritySentence,
  cardStamp,
  demandSentence,
  evidenceSentence,
  kindDisplay,
  moneySentence,
  serpVerdictDisplay,
  serpVerdictLine,
} from "@/client/features/rankloop-plan/pagePlanDisplay.logic";
import { RankloopPageTypeDetails } from "@/client/features/rankloop-plan/RankloopPageTypeDetails";
import { tagChipClass } from "@/shared/tag-colors";
import type {
  PageTypeCard,
  PlanAuthority,
} from "@/types/schemas/rankloopPagePlan";

// Same anatomy as the competitor detail chips (TagChip's xs size, minus the
// dot) so a page type's kind and its SERP verdict read as one chip system.
const chipBaseClass =
  "inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-[11px] font-medium";

function ExampleTitles({ titles }: { titles: string[] }) {
  if (titles.length === 0) return null;
  return (
    <ul className="space-y-0.5 text-sm text-base-content/70">
      {titles.map((title) => (
        <li key={title} className="truncate" title={title}>
          {`“${title}”`}
        </li>
      ))}
    </ul>
  );
}

function SerpVerdict({ serpCheck }: { serpCheck: PageTypeCard["serpCheck"] }) {
  const verdict = serpVerdictDisplay(serpCheck);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={`${chipBaseClass} ${tagChipClass(verdict.color)}`}>
        {verdict.label}
      </span>
      <span className="text-sm text-base-content/70">
        {serpVerdictLine(serpCheck)}
      </span>
    </div>
  );
}

function DecisionRow({
  pageType,
  deciding,
  onDecide,
}: {
  pageType: PageTypeCard;
  deciding: boolean;
  onDecide: (decision: "approved" | "declined") => void;
}) {
  // An approved type keeps its card: this is the one strategy decision the
  // user makes, and it should stay visible with the evidence it was made on
  // rather than vanishing into the writer.
  if (pageType.status === "approved") {
    return (
      <p className="flex items-center gap-2 text-sm text-base-content/70">
        <Check className="size-4 shrink-0 text-success" />
        Approved &middot; {pageType.instanceCount.toLocaleString("en-US")}{" "}
        keyword
        {pageType.instanceCount === 1 ? "" : "s"} bound to this type
      </p>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        className="btn btn-primary btn-sm"
        disabled={deciding}
        onClick={() => onDecide("approved")}
      >
        {deciding ? <Loader2 className="size-4 animate-spin" /> : null}
        Approve
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={deciding}
        onClick={() => onDecide("declined")}
      >
        Decline
      </button>
    </div>
  );
}

/**
 * Gate 1. Everything on this card is something a founder who has never done
 * SEO can judge in one read: what the pages would be called, how much demand
 * sits under them, what writing them costs, whether a competitor already earns
 * from the shape, and what a live SERP sample says about winning it. The
 * patterns, the contract and the keyword list live behind "More details"
 * because none of them change the yes/no.
 */
export function RankloopPageTypeCard({
  projectId,
  pageType,
  authority,
  deciding,
  onDecide,
}: {
  projectId: string;
  pageType: PageTypeCard;
  authority: PlanAuthority | null;
  deciding: boolean;
  onDecide: (decision: "approved" | "declined") => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const kind = kindDisplay(pageType.kind);
  // Empty when either side of the comparison was never measured — the card
  // drops the line entirely rather than half-stating it.
  const authorityLine = authoritySentence(authority);

  return (
    <CardShell
      title={`${pageType.name} — ${pageType.instanceCount.toLocaleString(
        "en-US",
      )} page${pageType.instanceCount === 1 ? "" : "s"}`}
      stamp={cardStamp(pageType.serpCheck)}
      action={
        <div className="flex shrink-0 items-center gap-2">
          <span className={`${chipBaseClass} ${tagChipClass(kind.color)}`}>
            {kind.label}
          </span>
          <button
            type="button"
            className={moreDetailsClass}
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((open) => !open)}
          >
            {detailsOpen ? "Hide details" : "More details"}
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        {/* Real backlog keywords, verbatim. rankloop does not synthesize a
            headline here: the writer decides the title, and a card that
            invented one would be promising a page that doesn't exist. */}
        <ExampleTitles titles={pageType.evidence?.exampleTitles ?? []} />

        <div className="space-y-1">
          <p className="text-sm tabular-nums">
            {demandSentence(pageType.demand, pageType.instanceCount)}
          </p>
          <p className="text-sm text-base-content/70 tabular-nums">
            {moneySentence(pageType.instanceCount)}
          </p>
          <p className="text-sm text-base-content/70">
            {evidenceSentence(pageType.evidence?.competitor ?? null)}
          </p>
          {authorityLine ? (
            <p className="text-sm text-base-content/70 tabular-nums">
              {authorityLine}
            </p>
          ) : null}
        </div>

        <SerpVerdict serpCheck={pageType.serpCheck} />

        <DecisionRow
          pageType={pageType}
          deciding={deciding}
          onDecide={onDecide}
        />
      </div>

      {detailsOpen ? (
        <RankloopPageTypeDetails projectId={projectId} pageType={pageType} />
      ) : null}
    </CardShell>
  );
}
