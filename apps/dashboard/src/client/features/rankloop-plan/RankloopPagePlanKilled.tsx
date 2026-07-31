import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { kindDisplay } from "@/client/features/rankloop-plan/pagePlanDisplay.logic";
import { tagChipClass } from "@/shared/tag-colors";
import type { PageTypeCard } from "@/types/schemas/rankloopPagePlan";

const chipBaseClass =
  "inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-[11px] font-medium";

// A decidedAt is the fingerprint of a human: the planner never sets one, so a
// declined row carrying a timestamp is a type the user turned down and its
// SERP reason — which may well have been "ok" — is not the reason it is here.
function whyNot(row: PageTypeCard): string {
  if (row.decidedAt !== null) return "You declined this type.";
  return row.serpCheck?.reason ?? "No reason recorded.";
}

/**
 * The what-not-to-build panel, pointed at our own plan. Most of these are
 * shapes the planner killed on SERP evidence — a forum owning the top five, or
 * nothing beatable anywhere in the sample. They ship collapsed but present: a
 * founder who wonders why the obvious page type isn't in the plan deserves the
 * reason rather than a shorter list.
 */
export function RankloopPagePlanKilled({ rows }: { rows: PageTypeCard[] }) {
  const [open, setOpen] = useState(false);

  if (rows.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-base-300/30"
      >
        <span className="text-sm font-medium">
          Not worth building ({rows.length})
        </span>
        <ChevronDown
          className={`size-4 shrink-0 text-base-content/50 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open ? (
        <div className="overflow-x-auto border-t border-base-300">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Type</th>
                <th className="text-right">Pages</th>
                <th>Why not</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const kind = kindDisplay(row.kind);
                return (
                  <tr key={row.id}>
                    <td>
                      <span className="flex items-center gap-2">
                        <span className="font-medium">{row.name}</span>
                        <span
                          className={`${chipBaseClass} ${tagChipClass(
                            kind.color,
                          )}`}
                        >
                          {kind.label}
                        </span>
                      </span>
                    </td>
                    <td className="text-right tabular-nums">
                      {row.instanceCount.toLocaleString("en-US")}
                    </td>
                    <td className="text-base-content/70">{whyNot(row)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
