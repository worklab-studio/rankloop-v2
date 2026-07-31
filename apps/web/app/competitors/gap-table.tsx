"use client";

/** The keyword-gap table with the per-row "Write it" action. Queueing is
 * optimistic and cosmetic — local state stands in for POST /proposals. */

import { useState } from "react";
import type { GapKeyword } from "@/lib/types";
import { fmtInt } from "@/lib/mock";
import { KdBadge, TagChip } from "@/components/ui";

function IntentChip({ intent }: { intent: string | null }) {
  if (!intent) return <span className="text-base-content/40">—</span>;
  const commercial = intent === "commercial" || intent === "transactional";
  return <TagChip color={commercial ? "amber" : "slate"}>{intent}</TagChip>;
}

export function GapTable({ rows }: { rows: GapKeyword[] }) {
  const [queued, setQueued] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<string | null>(null);

  function queue(keyword: string) {
    setQueued((q) => ({ ...q, [keyword]: true }));
    setToast(keyword);
    window.setTimeout(() => setToast((t) => (t === keyword ? null : t)), 2600);
  }

  return (
    <>
      <div className="overflow-x-auto">
        <table className="table table-sm">
          <thead>
            <tr>
              <th>Keyword</th>
              <th className="text-right">Volume</th>
              <th>KD</th>
              <th>They rank</th>
              <th>Intent</th>
              <th className="text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.keyword}·${r.competitorDomain}`}>
                <td className="font-medium">{r.keyword}</td>
                <td className="text-right tabular-nums">
                  {r.volume === null ? (
                    <span className="text-base-content/40">—</span>
                  ) : (
                    fmtInt(r.volume)
                  )}
                </td>
                <td>
                  <KdBadge value={r.difficulty} />
                </td>
                <td className="whitespace-nowrap text-base-content/60">
                  <span className="font-medium tabular-nums text-base-content">
                    #{r.competitorPosition}
                  </span>{" "}
                  at {r.competitorDomain}
                </td>
                <td>
                  <IntentChip intent={r.intent} />
                </td>
                <td className="text-right">
                  {queued[r.keyword] ? (
                    <TagChip color="emerald">queued</TagChip>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => queue(r.keyword)}
                    >
                      Write it
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {toast ? (
        <div className="toast toast-end z-50">
          <div className="rounded-lg border border-base-300 bg-base-100 px-4 py-3 shadow-lg">
            <span className="text-sm">
              &ldquo;{toast}&rdquo; queued — it will surface in Opportunities.
            </span>
          </div>
        </div>
      ) : null}
    </>
  );
}
