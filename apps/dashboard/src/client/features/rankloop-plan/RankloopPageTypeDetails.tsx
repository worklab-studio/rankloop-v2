import {
  contractLines,
  kdBandLabel,
  requiredBlockLabel,
  serpSummaryLine,
} from "@/client/features/rankloop-plan/pagePlanDisplay.logic";
import { RankloopPageTypeInstances } from "@/client/features/rankloop-plan/RankloopPageTypeInstances";
import { tagChipClass } from "@/shared/tag-colors";
import type { PageTypeCard } from "@/types/schemas/rankloopPagePlan";

// The house inset-panel eyebrow, one per thing the drawer reveals.
function DetailSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-base-content/60">
        {label}
      </p>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

// Patterns are the two strings the writer will actually template against, so
// they render as data (mono) and a missing one renders as a null, not as an
// empty row that reads like a bug.
function PatternValue({ value }: { value: string | null }) {
  if (value === null) return <span className="text-base-content/40">—</span>;
  return (
    <span className="break-all font-mono text-xs text-base-content/80">
      {value}
    </span>
  );
}

function TemplateContract({
  contract,
}: {
  contract: PageTypeCard["contract"];
}) {
  if (!contract) {
    return (
      <p className="text-sm text-base-content/60">
        No contract derived yet &mdash; it lands with the next recompute.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {contract.requiredBlocks.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {contract.requiredBlocks.map((block) => (
            <span
              key={block}
              className={`inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-[11px] font-medium ${tagChipClass(
                "slate",
              )}`}
            >
              {requiredBlockLabel(block)}
            </span>
          ))}
        </div>
      ) : null}
      <p className="text-sm text-base-content/70">
        {contractLines(contract).join(" · ")}
      </p>
      {/* Where each rule came from — the "defaults" note is what keeps an
          unevidenced contract from reading as something we measured. */}
      {contract.notes.map((note) => (
        <p key={note} className="text-[11px] text-base-content/45">
          {note}
        </p>
      ))}
    </div>
  );
}

/**
 * Everything behind "More details": the patterns the writer templates against,
 * the contract it has to satisfy, the difficulty band, what the SERP sample
 * actually saw, and every keyword bound to the type. None of it changes the
 * yes/no, which is why none of it is on the card by default.
 */
export function RankloopPageTypeDetails({
  projectId,
  pageType,
}: {
  projectId: string;
  pageType: PageTypeCard;
}) {
  return (
    <div className="mt-4 space-y-4 rounded-lg border border-base-300 bg-base-200/20 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <DetailSection label="URL pattern">
          <PatternValue value={pageType.urlPattern} />
        </DetailSection>
        <DetailSection label="Keyword pattern">
          <PatternValue value={pageType.keywordPattern} />
        </DetailSection>
      </div>

      <DetailSection label="Template contract">
        <TemplateContract contract={pageType.contract} />
      </DetailSection>

      <DetailSection label="Difficulty">
        <p className="text-sm tabular-nums text-base-content/70">
          {kdBandLabel(pageType.evidence?.kdBand ?? null)}
        </p>
      </DetailSection>

      <DetailSection label="SERP sample">
        <p className="text-sm tabular-nums text-base-content/70">
          {serpSummaryLine(pageType.serpCheck)}
        </p>
        {pageType.serpCheck?.reason ? (
          <p className="mt-1 text-sm text-base-content/60">
            {pageType.serpCheck.reason}
          </p>
        ) : null}
      </DetailSection>

      <DetailSection
        label={`Keywords in this type (${pageType.instanceCount.toLocaleString(
          "en-US",
        )})`}
      >
        <RankloopPageTypeInstances
          projectId={projectId}
          pageTypeId={pageType.id}
        />
      </DetailSection>
    </div>
  );
}
