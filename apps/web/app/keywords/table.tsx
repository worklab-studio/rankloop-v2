"use client";

/** The keyword backlog table — the interactive island for /keywords.
 * Filtering, sorting and the optimistic "Add to backlog" toggle are all
 * local state; nothing here talks to a server. Renders as ONE CardShell:
 * search in the header row, table in the body, the min_volume=0 law as
 * the provenance stamp. */

import { useMemo, useState } from "react";
import {
  ArrowDown, ArrowUp, ArrowUpDown, Check, Plus, Search,
} from "lucide-react";
import type { KeywordRow } from "@/lib/types";
import { CardShell, KdBadge, ScoreBadge, TagChip, type ChipColor } from "@/components/ui";
import { fmtInt } from "@/lib/mock";

type SortKey = "volume" | "difficulty" | "score";
type SortDir = "asc" | "desc";

/** source provenance, in the chip contract's colors: gsc=sky (Search
 * Console demand), harvested questions=lime (the pool), expansion
 * sources=slate. */
const SOURCE_CHIP: Record<string, ChipColor> = {
  gsc: "sky",
  reddit: "lime",
  stackexchange: "lime",
  dataforseo: "slate",
  autocomplete: "slate",
};

/** null-aware comparator — NULL volume/KD rows sort last in either
 * direction so free long-tail never gets buried above metric rows by a
 * sort quirk, but never disappears either. */
function cmpNullable(a: number | null, b: number | null, dir: 1 | -1): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return (a - b) * dir;
}

function SortableTh({
  label, k, sortKey, sortDir, onSort, alignRight,
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  alignRight?: boolean;
}) {
  const active = sortKey === k;
  const Icon = active ? (sortDir === "desc" ? ArrowDown : ArrowUp) : ArrowUpDown;
  return (
    <th className={alignRight ? "text-right" : undefined}>
      <button
        type="button"
        onClick={() => onSort(k)}
        className={`inline-flex cursor-pointer items-center gap-1 uppercase tracking-wide hover:text-base-content ${
          active ? "text-base-content" : ""
        }`}
        title={`Sort by ${label.toLowerCase()}`}
      >
        {label}
        <Icon className={`h-3 w-3 ${active ? "text-primary" : "opacity-40"}`} />
      </button>
    </th>
  );
}

export default function KeywordTable({ rows }: { rows: KeywordRow[] }) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  /** keywords queued this session (optimistic, cosmetic) */
  const [queued, setQueued] = useState<ReadonlySet<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);

  function handleSort(k: SortKey) {
    if (k === sortKey) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(k);
      setSortDir("desc");
    }
  }

  function toggleQueue(keyword: string) {
    const isQueued = queued.has(keyword);
    const next = new Set(queued);
    if (isQueued) {
      next.delete(keyword);
    } else {
      next.add(keyword);
    }
    setQueued(next);
    if (!isQueued) {
      const msg = `“${keyword}” queued — it enters the next pick cycle.`;
      setToast(msg);
      window.setTimeout(
        () => setToast((cur) => (cur === msg ? null : cur)),
        2500,
      );
    }
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? rows.filter((r) => r.keyword.toLowerCase().includes(q))
      : rows.slice();
    const dir: 1 | -1 = sortDir === "desc" ? -1 : 1;
    filtered.sort(
      (a, b) => cmpNullable(a[sortKey], b[sortKey], dir) || b.score - a.score,
    );
    return filtered;
  }, [rows, query, sortKey, sortDir]);

  return (
    <CardShell
      title="Backlog"
      action={
        <div className="flex flex-wrap items-center justify-end gap-3">
          {queued.size > 0 ? (
            <TagChip color="emerald">{queued.size} queued this session</TagChip>
          ) : null}
          <span className="text-xs tabular-nums text-base-content/50">
            {visible.length} of {rows.length}
          </span>
          <label className="input input-sm w-64">
            <Search className="h-3.5 w-3.5 opacity-50" />
            <input
              type="search"
              className="grow"
              placeholder="Filter keywords…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
      }
      stamp="NULL volume rows are admitted by design — free long-tail sources live there (the min_volume=0 law). Harvested questions carry neutral prior scores and surface via the pool slot, never by outranking metric rows."
    >
      {visible.length === 0 ? (
        <div className="py-10 text-center">
          <div className="text-sm font-medium text-base-content/70">
            {rows.length === 0
              ? "The backlog is empty"
              : `No keywords match “${query.trim()}”`}
          </div>
          <div className="mt-1 text-sm text-base-content/50">
            {rows.length === 0 ? (
              "Run discovery or connect Search Console to start feeding it."
            ) : (
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={() => setQuery("")}
              >
                clear filter
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead className="text-xs">
              <tr>
                <th>Keyword</th>
                <SortableTh label="Volume" k="volume" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} alignRight />
                <SortableTh label="KD" k="difficulty" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} alignRight />
                <th>Intent</th>
                <SortableTh label="Score" k="score" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} alignRight />
                <th>Source</th>
                <th>Status</th>
                <th className="text-right">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const isQueued = queued.has(row.keyword);
                const status =
                  row.status === "discovered" && isQueued ? "queued" : row.status;
                return (
                  <tr key={row.keyword} className="hover:bg-base-300/30">
                    <td>
                      <div className="font-medium">{row.keyword}</div>
                      <div className="text-xs text-base-content/50">{row.category}</div>
                    </td>
                    <td className="text-right text-sm tabular-nums">
                      {row.volume === null ? (
                        <span
                          className="text-base-content/30"
                          title="no metrics — free long-tail source"
                        >
                          —
                        </span>
                      ) : (
                        fmtInt(row.volume)
                      )}
                    </td>
                    <td className="text-right">
                      <KdBadge value={row.difficulty} />
                    </td>
                    <td className="text-sm text-base-content/70">
                      {row.intent ?? <span className="text-base-content/30">—</span>}
                    </td>
                    <td className="text-right">
                      <ScoreBadge score={row.score} />
                    </td>
                    <td>
                      <TagChip color={SOURCE_CHIP[row.source] ?? "slate"}>
                        {row.source}
                      </TagChip>
                    </td>
                    <td>
                      <span className="badge badge-ghost badge-sm">{status}</span>
                    </td>
                    <td className="text-right">
                      {row.status === "discovered" ? (
                        isQueued ? (
                          <button
                            type="button"
                            className="cursor-pointer"
                            onClick={() => toggleQueue(row.keyword)}
                            title="click to remove from the backlog"
                          >
                            <TagChip color="emerald">queued</TagChip>
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => toggleQueue(row.keyword)}
                          >
                            <Plus className="h-3.5 w-3.5" />
                            Add to backlog
                          </button>
                        )
                      ) : (
                        <span className="text-xs text-base-content/30">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {toast ? (
        <div className="toast toast-end z-50">
          <div className="flex items-center gap-2 rounded-lg border border-base-300 bg-base-100 px-4 py-2.5 shadow-lg">
            <Check className="h-4 w-4 text-success" />
            <span className="text-sm">{toast}</span>
          </div>
        </div>
      ) : null}
    </CardShell>
  );
}
