"use client";

/** Client island for /opportunities: filter tabs, score-breakdown toggles,
 * and optimistic approve/decline. Cosmetic local state only — the real API
 * swap replaces the decide() body, nothing else. Renders a fragment: the
 * type-filter tabs and ONE CardShell holding the proposal table, both
 * spaced by the layout's gap-5 column. */

import { Fragment, useState } from "react";
import { CheckCheck, ChevronDown } from "lucide-react";
import type { Proposal, ProposalStatus, ProposalType } from "@/lib/types";
import {
  CardShell, EmptyState, EvidenceChips, ScoreBadge, ScoreBreakdown, TypeBadge,
} from "@/components/ui";

type FilterKey = "all" | ProposalType;

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "write_new", label: "Write" },
  { key: "retitle", label: "Retitle" },
  { key: "refresh", label: "Refresh" },
  { key: "push", label: "Push" },
  { key: "merge", label: "Merge" },
];

export default function Queue({ proposals }: { proposals: Proposal[] }) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [overrides, setOverrides] = useState<Record<string, ProposalStatus>>({});
  const [openScoreId, setOpenScoreId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const statusOf = (p: Proposal): ProposalStatus => overrides[p.id] ?? p.status;

  const sorted = [...proposals].sort((a, b) => b.score - a.score);
  const visible = filter === "all" ? sorted : sorted.filter((p) => p.type === filter);
  const countFor = (key: FilterKey): number =>
    key === "all" ? sorted.length : sorted.filter((p) => p.type === key).length;

  function announce(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2600);
  }

  function decide(p: Proposal, decision: "approved" | "declined") {
    setOverrides((o) => ({ ...o, [p.id]: decision }));
    announce(
      decision === "approved"
        ? `Approved: ${p.title}`
        : `Declined — "${p.target}" won't resurface for 10 days`,
    );
  }

  /** top 3 write_new proposals still awaiting a decision, by score */
  const batchable = sorted
    .filter((p) => p.type === "write_new" && statusOf(p) === "proposed")
    .slice(0, 3);

  function batchApprove() {
    if (batchable.length === 0) return;
    setOverrides((o) => {
      const next = { ...o };
      for (const p of batchable) next[p.id] = "approved";
      return next;
    });
    announce(`Approved ${batchable.length} write proposal${batchable.length === 1 ? "" : "s"}`);
  }

  const activeLabel = FILTERS.find((f) => f.key === filter)?.label ?? "All";

  return (
    <>
      {/* type filter — underline tabs, active = primary */}
      <div role="tablist" className="tabs tabs-border">
        {FILTERS.map(({ key, label }) => (
          <button
            key={key}
            role="tab"
            className={`tab gap-1.5 ${filter === key ? "tab-active" : ""}`}
            aria-selected={filter === key}
            onClick={() => setFilter(key)}
          >
            {label}
            <span className="text-[10px] tabular-nums text-base-content/40">{countFor(key)}</span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title={`No ${activeLabel.toLowerCase()} proposals right now`}
          hint="The engine re-scores the backlog nightly; new evidence surfaces here."
        />
      ) : (
        <CardShell
          title="Proposal queue"
          action={
            <button
              className="btn btn-primary btn-sm"
              onClick={batchApprove}
              disabled={batchable.length === 0}
              title="approve the highest-scoring write proposals still awaiting a decision"
            >
              <CheckCheck className="h-4 w-4" />
              Batch: approve top 3 writes
            </button>
          }
          stamp="Proposals expire after 10 days · scores re-computed nightly"
        >
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Proposal</th>
                  <th className="text-right">Score</th>
                  <th>Source</th>
                  <th className="text-right">Decision</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((p) => {
                  const status = statusOf(p);
                  const open = openScoreId === p.id;
                  return (
                    <Fragment key={p.id}>
                      <tr
                        className={`transition-colors hover:bg-base-300/30 ${
                          status === "declined" ? "opacity-50" : ""
                        }`}
                      >
                        <td className="align-top">
                          <div className="flex flex-col items-start gap-1">
                            <TypeBadge type={p.type} />
                            {p.type === "merge" ? (
                              <span className="badge badge-warning badge-outline badge-xs whitespace-nowrap">
                                never autopilot
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td className="max-w-md align-top">
                          <div className="font-medium leading-snug">{p.title}</div>
                          <div className="mt-0.5 truncate font-mono text-xs text-base-content/50">
                            {p.target}
                          </div>
                          <div className="mt-1.5">
                            <EvidenceChips evidence={p.evidence} />
                          </div>
                        </td>
                        <td className="align-top text-right">
                          <button
                            className="btn btn-ghost btn-xs gap-1 px-1.5"
                            onClick={() => setOpenScoreId(open ? null : p.id)}
                            aria-expanded={open}
                            title="show how this score was computed"
                          >
                            <ScoreBadge score={p.score} />
                            <ChevronDown
                              className={`h-3 w-3 opacity-50 transition-transform ${
                                open ? "rotate-180" : ""
                              }`}
                            />
                          </button>
                        </td>
                        <td className="align-top">
                          <span className="badge badge-ghost badge-sm font-mono">{p.source}</span>
                        </td>
                        <td className="align-top">
                          <div className="flex items-center justify-end gap-1.5">
                            {status === "proposed" ? (
                              <>
                                <button
                                  className="btn btn-primary btn-sm"
                                  onClick={() => decide(p, "approved")}
                                >
                                  Approve
                                </button>
                                <button
                                  className="btn btn-sm"
                                  onClick={() => decide(p, "declined")}
                                >
                                  Decline
                                </button>
                              </>
                            ) : status === "approved" ? (
                              <span className="badge badge-success badge-sm">approved</span>
                            ) : status === "declined" ? (
                              <span className="badge badge-ghost badge-sm">declined</span>
                            ) : (
                              <span className="badge badge-ghost badge-sm">{status}</span>
                            )}
                          </div>
                        </td>
                      </tr>
                      {open ? (
                        <tr>
                          <td colSpan={5} className="bg-base-300/30 py-3">
                            <div className="max-w-lg">
                              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-base-content/50">
                                score factors — multiply to {p.score.toFixed(2)}
                              </div>
                              <ScoreBreakdown factors={p.factors} />
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardShell>
      )}

      {toast ? (
        <div className="toast toast-end z-50">
          <div className="alert alert-success shadow-lg">
            <span className="text-sm">{toast}</span>
          </div>
        </div>
      ) : null}
    </>
  );
}
