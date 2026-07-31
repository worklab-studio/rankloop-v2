import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import {
  CardShell,
  EmptyCardBody,
  formatDay,
  formatRelative,
  Stat,
} from "@/client/features/dashboard/cardParts";
import { TagChip } from "@/client/features/saved-keywords/TagChip";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  startRankloopSiteStudy,
  type getRankloopSiteStudy,
} from "@/serverFunctions/rankloopSiteStudy";

type SiteStudy = Awaited<ReturnType<typeof getRankloopSiteStudy>>;

// "2026-03" → "Mar". Anchored to UTC noon-less midnight with an explicit
// timeZone so a viewer west of Greenwich doesn't see every bar shift into
// the previous month.
function monthLabel(month: string): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return month;
  return date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
}

function kindChipLabel(kind: string, count: number): string {
  // "other" is already plural-neutral ("12 other"); the real kinds take a
  // plain s.
  if (kind === "other") return `${count.toLocaleString()} other`;
  return `${count.toLocaleString()} ${kind}${count === 1 ? "" : "s"}`;
}

// The corpus manifest surface: what rankloop knows the site has published.
// Data arrives from the site-study run (audit crawl → content_pages derive);
// until one has run, the card is a single-button pitch.
export function ContentInventoryCard({
  projectId,
  study,
}: {
  projectId: string;
  study: SiteStudy | undefined;
}) {
  const queryClient = useQueryClient();

  // A duplicate start returns the existing active run rather than erroring,
  // so success always means a run is active — the polling query flips the
  // button into its studying state.
  const studyMutation = useMutation({
    mutationFn: () => startRankloopSiteStudy({ data: { projectId } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["rankloopSiteStudy", projectId],
      });
    },
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(
          error,
          "Couldn't start the site study. Try again.",
        ),
      );
    },
  });

  if (!study) {
    return (
      <CardShell title="Content inventory">
        <div className="grid grid-cols-2 gap-3" aria-busy>
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="skeleton h-20" />
          ))}
        </div>
      </CardShell>
    );
  }

  const run = study.lastRun;
  const inventory = study.inventory;
  const studying = run?.status === "pending" || run?.status === "running";

  if (!inventory) {
    const busy = studying || studyMutation.isPending;
    return (
      <CardShell title="Content inventory">
        <EmptyCardBody
          message="Study your site to see what you've published."
          cta={
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => studyMutation.mutate()}
            >
              {busy ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Studying…
                </>
              ) : (
                "Study my site"
              )}
            </button>
          }
        />
      </CardShell>
    );
  }

  // "crawled N pages": the derive count from the run when it finished
  // cleanly, otherwise the manifest total (a failed re-study leaves
  // pagesDerived null but the previous corpus intact).
  const crawled = run?.pagesDerived ?? inventory.totalPages;
  const stamp = `crawled ${crawled.toLocaleString()} page${
    crawled === 1 ? "" : "s"
  }${run ? ` · ${formatRelative(run.finishedAt ?? run.startedAt)}` : ""}${
    studying ? " · studying again…" : ""
  }`;

  const months = inventory.monthlyPosts;
  const maxCount = months.reduce((max, m) => Math.max(max, m.count), 0);

  const kindChips = [
    { kind: "post", count: inventory.kindCounts.post },
    { kind: "page", count: inventory.kindCounts.page },
    { kind: "hub", count: inventory.kindCounts.hub },
    { kind: "other", count: inventory.kindCounts.other },
  ].filter((entry) => entry.count > 0);

  return (
    <CardShell title="Content inventory" stamp={stamp}>
      <div className="grid grid-cols-2 gap-3">
        <Stat
          label="Posts"
          value={inventory.kindCounts.post.toLocaleString()}
        />
        <Stat
          label="Pages"
          value={inventory.kindCounts.page.toLocaleString()}
        />
        <Stat
          label="Median words"
          value={
            inventory.medianWordCount === null
              ? "—"
              : inventory.medianWordCount.toLocaleString()
          }
        />
        <Stat
          label="Last published"
          value={
            inventory.lastPublishedAt === null
              ? "—"
              : formatDay(inventory.lastPublishedAt)
          }
        />
      </div>

      {/* Div-based cadence bar: 12 columns is too small a chart to justify
          recharts. The max month gets the full primary fill so the eye finds
          the peak without an axis; zero months keep a 2px baseline so gaps in
          the cadence read as gaps, not missing bars. */}
      <div className="mt-4">
        <p className="text-xs uppercase tracking-wide text-base-content/60">
          Posts per month
        </p>
        <div className="mt-2 flex h-8 items-end gap-1">
          {months.map((m) => (
            <div
              key={m.month}
              className={`flex-1 rounded-sm ${
                maxCount > 0 && m.count === maxCount
                  ? "bg-primary"
                  : "bg-primary/20"
              }`}
              style={{
                height:
                  m.count === 0 || maxCount === 0
                    ? "2px"
                    : // Non-zero months never render under 20% of h-8, so a
                      // single post stays distinguishable from none.
                      `${Math.max(Math.round((m.count / maxCount) * 100), 20)}%`,
              }}
              title={`${monthLabel(m.month)} · ${m.count} post${
                m.count === 1 ? "" : "s"
              }`}
            />
          ))}
        </div>
      </div>

      {/* Detected kinds as quiet slate chips — informational, not filters,
          so they all share one color instead of the tag palette. */}
      {kindChips.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {kindChips.map((entry) => (
            <TagChip
              key={entry.kind}
              size="xs"
              tag={{
                id: entry.kind,
                name: kindChipLabel(entry.kind, entry.count),
                color: "slate",
              }}
            />
          ))}
        </div>
      ) : null}
    </CardShell>
  );
}
