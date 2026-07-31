import { SafeExternalLink } from "@/client/components/SafeExternalLink";
import {
  OUTREACH_STALE_LABEL,
  OUTREACH_STATUS_OPTIONS,
  staleChipTitle,
} from "@/client/features/rankloop-plan/outreachDisplay.logic";
import type { getRankloopOutreach } from "@/serverFunctions/rankloopOutreach";
import type {
  OutreachEvidence,
  OutreachStatus,
} from "@/types/schemas/rankloopOutreach";
import { tagChipClass } from "@/shared/tag-colors";

type OutreachTargetRow = Awaited<
  ReturnType<typeof getRankloopOutreach>
>["targets"][number];

// Chip anatomy mirrors TagChip's xs size (h-5 px-1.5 text-[11px]) so the
// competitors a domain links to read as the same system as the coverage and
// page-type chips on the Competitors tab.
const chipBaseClass =
  "inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-[11px] font-medium";

// One chip per competitor, all violet: the chips answer "who does this domain
// already link to", and coloring them apart would imply a ranking between
// competitors that the gap doesn't have. The linked URL is the hover title
// rather than the label — the label has to stay scannable down a hundred
// rows, and for domain-level evidence there is no URL to show anyway.
function LinkedCompetitors({ evidence }: { evidence: OutreachEvidence[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {evidence.map((entry) => (
        <span
          key={entry.competitorId}
          title={entry.targetUrl ?? entry.competitorDomain}
          className={`${chipBaseClass} ${tagChipClass("violet")}`}
        >
          {entry.competitorDomain}
        </span>
      ))}
    </div>
  );
}

// Slate, alone among the eight tag colors: every other chip in this table
// names something the gap found, and this one names the absence of it. Dimming
// rather than hiding the computed cells behind it, because "who it used to
// link to" is exactly the context someone needs to decide what to do with a
// domain they have already written to.
function StaleChip({ staleAsOf }: { staleAsOf: string }) {
  return (
    <span
      title={staleChipTitle(staleAsOf)}
      className={`${chipBaseClass} ${tagChipClass("slate")}`}
    >
      {OUTREACH_STALE_LABEL}
    </span>
  );
}

// The computed columns and only those. Status and the draft are the human's,
// and dimming them would say their own work had gone stale too.
const STALE_CELL_CLASS = "opacity-45";

export function RankloopOutreachTable({
  rows,
  onStatusChange,
  onDraft,
}: {
  rows: OutreachTargetRow[];
  onStatusChange: (targetId: string, status: OutreachStatus) => void;
  onDraft: (target: OutreachTargetRow) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="table table-sm">
        <thead>
          <tr>
            <th>Domain</th>
            <th>Links to</th>
            <th className="text-right">Domain rank</th>
            <th>Your asset</th>
            <th>Status</th>
            <th aria-label="Draft" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const staleClass = row.staleAsOf === null ? "" : STALE_CELL_CLASS;
            return (
              <tr key={row.id}>
                <td>
                  <div className="flex flex-col items-start gap-1">
                    <SafeExternalLink
                      url={`https://${row.domain}`}
                      label={row.domain}
                      className="link link-hover inline-flex items-center gap-1 font-medium"
                    />
                    {row.staleAsOf === null ? null : (
                      <StaleChip staleAsOf={row.staleAsOf} />
                    )}
                  </div>
                </td>
                <td className={staleClass}>
                  <LinkedCompetitors evidence={row.evidence} />
                </td>
                <td className={`text-right tabular-nums ${staleClass}`}>
                  {row.domainRank === null ? (
                    <span className="text-base-content/40">—</span>
                  ) : (
                    row.domainRank.toLocaleString("en-US")
                  )}
                </td>
                <td className={staleClass}>
                  {row.assetPath === null ? (
                    <span className="text-base-content/40">— no match</span>
                  ) : (
                    <span
                      className="block max-w-xs truncate font-mono text-xs"
                      title={row.assetTitle ?? row.assetPath}
                    >
                      {row.assetPath}
                    </span>
                  )}
                </td>
                <td>
                  <select
                    // w-auto: the select is width:100% of a td the auto-layout
                    // table sizes from its header alone, which clips the label
                    // to one character — a status board you cannot read is not
                    // a status board.
                    className="select select-bordered select-sm w-auto"
                    aria-label={`Outreach status for ${row.domain}`}
                    value={row.status}
                    onChange={(event) => {
                      // Narrow the select's string back to the stored union by
                      // looking it up rather than asserting — the options
                      // array is the only place the vocabulary lives.
                      const picked = OUTREACH_STATUS_OPTIONS.find(
                        (option) => option.value === event.target.value,
                      );
                      if (picked) onStatusChange(row.id, picked.value);
                    }}
                  >
                    {OUTREACH_STATUS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="text-right">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => onDraft(row)}
                  >
                    Draft
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
