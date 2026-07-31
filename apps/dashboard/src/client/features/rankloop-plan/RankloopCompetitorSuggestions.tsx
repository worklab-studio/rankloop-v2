import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { EmptyCardBody } from "@/client/features/dashboard/cardParts";
import { formatCount } from "@/client/features/rankloop-plan/competitorDisplay.logic";
import { dataforseoHelpLinkOptions } from "@/client/navigation/items";
import { getSeoApiKeyStatus } from "@/serverFunctions/config";
import type { getRankloopCompetitors } from "@/serverFunctions/rankloopCompetitors";

type CompetitorRow = Awaited<
  ReturnType<typeof getRankloopCompetitors>
>["suggested"][number];

function SuggestionsTable({
  rows,
  decidingId,
  onDecide,
}: {
  rows: CompetitorRow[];
  decidingId: string | null;
  onDecide: (competitorId: string, decision: "tracked" | "skipped") => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="table table-sm">
        <thead>
          <tr>
            <th>Domain</th>
            <th className="text-right">Overlap keywords</th>
            <th className="text-right" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="font-medium">{row.domain}</td>
              <td className="text-right tabular-nums">
                {row.overlapKeywords === null ? (
                  <span className="text-base-content/40">—</span>
                ) : (
                  formatCount(row.overlapKeywords)
                )}
              </td>
              <td className="text-right">
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={decidingId === row.id}
                    onClick={() => onDecide(row.id, "tracked")}
                  >
                    Track
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={decidingId === row.id}
                    onClick={() => onDecide(row.id, "skipped")}
                  >
                    Skip
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Discovery is the only key-gated half of this screen — manual adds work
// without a key, which is why the pitch replaces this section's body and
// never the whole tab.
export function RankloopCompetitorSuggestions({
  rows,
  decidingId,
  discovering,
  onDecide,
  onDiscover,
}: {
  rows: CompetitorRow[];
  decidingId: string | null;
  discovering: boolean;
  onDecide: (competitorId: string, decision: "tracked" | "skipped") => void;
  onDiscover: () => void;
}) {
  const keyStatusQuery = useQuery({
    queryKey: ["seoApiKeyStatus"],
    queryFn: () => getSeoApiKeyStatus(),
  });
  // null = still checking; the section renders its shell either way, so there
  // is nothing to skeleton.
  const keyConfigured = keyStatusQuery.isSuccess
    ? keyStatusQuery.data.configured
    : null;
  // An unverifiable key check lands in the pitch too, rather than
  // error-coloring a section that may work fine on retry.
  const keyless = keyConfigured === false || keyStatusQuery.isError;

  return (
    <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100">
      <div className="flex items-center justify-between gap-4 border-b border-base-300 px-4 py-3">
        <h2 className="text-base font-semibold leading-tight">Suggested</h2>
        {keyless ? null : (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={discovering}
            onClick={onDiscover}
          >
            {discovering ? <Loader2 className="size-4 animate-spin" /> : null}
            Find competitors
          </button>
        )}
      </div>

      {keyless ? (
        <div className="p-5">
          <EmptyCardBody
            message="Add your DataForSEO API key to see which domains compete for the keywords you want. Adding a competitor by hand works without one."
            cta={
              <Link
                {...dataforseoHelpLinkOptions}
                className="link link-primary text-sm font-medium"
              >
                Open setup guide →
              </Link>
            }
          />
        </div>
      ) : rows.length === 0 ? (
        <p className="p-6 text-sm text-base-content/60">
          No suggestions yet &mdash; discovery looks for the domains already
          ranking for your keywords.
        </p>
      ) : (
        <SuggestionsTable
          rows={rows}
          decidingId={decidingId}
          onDecide={onDecide}
        />
      )}

      <p className="border-t border-base-300 px-4 py-3 text-[11px] text-base-content/45">
        studying a competitor costs ~$0.15 and refreshes monthly
      </p>
    </div>
  );
}
