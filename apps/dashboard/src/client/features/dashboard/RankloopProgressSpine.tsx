import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useCompetitorsPolling } from "@/client/features/rankloop-plan/useCompetitorsPolling";
import { useKeywordUniversePolling } from "@/client/features/rankloop-plan/useKeywordUniversePolling";
import { usePagePlanPolling } from "@/client/features/rankloop-plan/usePagePlanPolling";
import { getRankloopGscMemory } from "@/serverFunctions/rankloopGsc";
import type { getRankloopSiteStudy } from "@/serverFunctions/rankloopSiteStudy";

type SiteStudy = Awaited<ReturnType<typeof getRankloopSiteStudy>>;

// Marker column for the spine rows, rendered in a fixed size-4 slot so row
// text stays aligned while a row moves between states under it.
function RowMarker({
  state,
}: {
  state: "done" | "active" | "error" | "future";
}) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      {state === "done" ? (
        <Check className="size-4 text-success" />
      ) : state === "active" ? (
        <span className="loading loading-spinner loading-xs" />
      ) : state === "error" ? (
        <span className="size-2 rounded-full bg-error" />
      ) : (
        <span className="size-1.5 rounded-full bg-base-content/25" />
      )}
    </span>
  );
}

// The backlog's row, carrying its own query rather than a prop: the count is
// the whole backlog and not the Keywords tab's filtered total, so the spine
// reads the run payload the tab polls rather than the table's page query.
function KeywordsRow({ projectId }: { projectId: string }) {
  const universe = useKeywordUniversePolling(projectId).data;
  const run = universe?.latestRun ?? null;
  const filling = run?.status === "pending" || run?.status === "running";
  const backlogCount = universe?.backlogCount ?? 0;
  const counts = `${backlogCount.toLocaleString()} in the backlog`;

  return (
    <li className="flex items-center gap-2.5 text-sm">
      {filling ? (
        <>
          <RowMarker state="active" />
          <span>
            Filling the keyword backlog
            {backlogCount > 0 ? (
              <span className="tabular-nums text-base-content/60">
                {" · "}
                {counts}
              </span>
            ) : null}
          </span>
        </>
      ) : backlogCount > 0 ? (
        <>
          <RowMarker state="done" />
          <Link
            to="/p/$projectId/plan"
            params={{ projectId }}
            className="group"
          >
            Keywords
            <span className="tabular-nums text-base-content/60 transition-colors group-hover:text-base-content">
              {" · "}
              {counts}
            </span>
          </Link>
        </>
      ) : run?.status === "error" ? (
        <>
          <RowMarker state="error" />
          <span>
            Keywords
            <span className="text-base-content/60"> · last run failed</span>
          </span>
        </>
      ) : (
        <>
          <RowMarker state="future" />
          <span className="text-base-content/50">
            Keywords · nothing gathered yet
          </span>
        </>
      )}
    </li>
  );
}

// Gate 1's row, carrying its own query rather than a prop: the plan is the
// only phase the spine links to a decision screen, and the row has four
// states of its own to narrate.
function PagePlanRow({ projectId }: { projectId: string }) {
  // Same query key the Page types tab reads, so the spine and the tab strip
  // agree on what the planner proposed and one poll serves both while a plan
  // run is going.
  const plan = usePagePlanPolling(projectId).data;
  const planRun = plan?.lastRun ?? null;
  const planning =
    planRun?.status === "pending" || planRun?.status === "running";
  const proposedCount = plan?.proposed.length ?? 0;
  const approvedCount = plan?.approved.length ?? 0;
  // Approved types leave the proposed pile, so the proposed count alone would
  // read as a regression the moment Gate 1 is answered — the approved half
  // only appears once there is one.
  const counts = `${proposedCount} type${
    proposedCount === 1 ? "" : "s"
  } proposed${approvedCount > 0 ? `, ${approvedCount} approved` : ""}`;

  return (
    <li className="flex items-center gap-2.5 text-sm">
      {planning ? (
        <>
          <RowMarker state="active" />
          <span>Planning page types</span>
        </>
      ) : proposedCount > 0 || approvedCount > 0 ? (
        <>
          <RowMarker state="done" />
          <Link
            to="/p/$projectId/plan"
            params={{ projectId }}
            className="group"
          >
            Page plan
            <span className="tabular-nums text-base-content/60 transition-colors group-hover:text-base-content">
              {" · "}
              {counts}
            </span>
          </Link>
        </>
      ) : planRun?.status === "error" ? (
        <>
          <RowMarker state="error" />
          <span>
            Page plan
            <span className="text-base-content/60"> · last run failed</span>
          </span>
        </>
      ) : (
        <>
          <RowMarker state="future" />
          <span className="text-base-content/50">Page plan · not run yet</span>
        </>
      )}
    </li>
  );
}

// The one primary-tinted rankloop surface: a full-width checklist card
// narrating the pipeline (site study → search memory → competitors → page
// plan) with live counts. It sits directly under the onboarding checklist
// and inherits the accent outright once that card retires itself — tinted
// cards mean "act on this", and this is the card that says what rankloop
// does next.
export function RankloopProgressSpine({
  projectId,
  study,
}: {
  projectId: string;
  study: SiteStudy | undefined;
}) {
  // Same query key as the GSC Insights memory stamp so the two surfaces
  // never disagree about sync state; polls while a sync runs so the day
  // count climbs live during a back-fill.
  const memoryQuery = useQuery({
    queryKey: ["rankloopGscMemory", projectId],
    queryFn: () => getRankloopGscMemory({ data: { projectId } }),
    refetchInterval: (query) => {
      const status = query.state.data?.lastRun?.status;
      if (status === "pending" || status === "running") return 3000;
      return false;
    },
  });
  const memory = memoryQuery.data;

  const run = study?.lastRun ?? null;
  const inventory = study?.inventory ?? null;
  const progress = study?.auditProgress ?? null;
  const studying = run?.status === "pending" || run?.status === "running";

  const syncStatus = memory?.lastRun?.status;
  const syncing = syncStatus === "pending" || syncStatus === "running";
  const dayCount = memory?.dayCount ?? 0;

  // Same query key the Plan screen reads, so the spine and the tab strip
  // agree on the tracked count and one poll serves both when a study runs.
  const tracked = useCompetitorsPolling(projectId).data?.tracked ?? [];
  const studyingCompetitors = tracked.some(
    (row) => row.studyStatus === "pending" || row.studyStatus === "running",
  );
  const competitorStudyFailed = tracked.some(
    (row) => row.studyStatus === "error",
  );
  // "Studied" counts competitors with a finished study behind them, not rows
  // that merely have a run — a failed first study leaves the count at zero,
  // which is the honest reading.
  const studiedCount = tracked.filter(
    (row) => row.lastStudiedAt !== null,
  ).length;
  const competitorCounts = `${tracked.length} tracked, ${studiedCount} studied`;

  return (
    <div className="rounded-xl border border-primary/25 bg-primary/5 shadow-sm">
      <p className="px-5 pt-4 text-xs font-medium uppercase tracking-wide text-primary">
        Rankloop pipeline
      </p>
      <ul className="space-y-2.5 p-5 pt-3">
        {/* Site study: live crawl progress while a run is active, then the
            corpus counts. Deep-links nowhere yet — the inventory has no page
            of its own until proposals land. */}
        <li className="flex items-center gap-2.5 text-sm">
          {studying ? (
            <>
              <RowMarker state="active" />
              <span>
                Studying your site
                {progress && progress.pagesTotal > 0 ? (
                  <span className="tabular-nums text-base-content/60">
                    {" · "}
                    {progress.pagesCrawled}/{progress.pagesTotal} pages
                  </span>
                ) : null}
              </span>
            </>
          ) : run?.status === "error" ? (
            <>
              <RowMarker state="error" />
              <span>
                Site study
                <span className="text-base-content/60"> · last run failed</span>
              </span>
            </>
          ) : inventory ? (
            <>
              <RowMarker state="done" />
              <span>
                Site studied
                <span className="tabular-nums text-base-content/60">
                  {" · "}
                  {inventory.totalPages.toLocaleString()} page
                  {inventory.totalPages === 1 ? "" : "s"},{" "}
                  {inventory.kindCounts.post.toLocaleString()} post
                  {inventory.kindCounts.post === 1 ? "" : "s"}
                </span>
              </span>
            </>
          ) : (
            <>
              <RowMarker state="future" />
              <span className="text-base-content/50">
                Site study · not run yet
              </span>
            </>
          )}
        </li>

        {/* Search memory: stored day-grain GSC rows; links into GSC Insights
            where the memory stamp and manual sync live. */}
        <li className="flex items-center gap-2.5 text-sm">
          {syncing ? (
            <>
              <RowMarker state="active" />
              <span>
                Syncing search memory
                {dayCount > 0 ? (
                  <span className="tabular-nums text-base-content/60">
                    {" · "}
                    {dayCount} day{dayCount === 1 ? "" : "s"} stored
                  </span>
                ) : null}
              </span>
            </>
          ) : dayCount > 0 ? (
            <>
              <RowMarker state="done" />
              <Link
                to="/p/$projectId/search-performance"
                params={{ projectId }}
                className="group"
              >
                Search memory
                <span className="tabular-nums text-base-content/60 transition-colors group-hover:text-base-content">
                  {" · "}
                  {dayCount} day{dayCount === 1 ? "" : "s"} stored
                </span>
              </Link>
            </>
          ) : syncStatus === "error" ? (
            <>
              <RowMarker state="error" />
              <span>
                Search memory
                <span className="text-base-content/60">
                  {" "}
                  · last sync failed
                </span>
              </span>
            </>
          ) : (
            <>
              <RowMarker state="future" />
              <span className="text-base-content/50">
                Search memory · not synced yet
              </span>
            </>
          )}
        </li>

        {/* Competitors: tracked rows and how many carry a finished study;
            links into the Plan screen where tracking and the drill-in live. */}
        <li className="flex items-center gap-2.5 text-sm">
          {studyingCompetitors ? (
            <>
              <RowMarker state="active" />
              <span>
                Studying competitors
                <span className="tabular-nums text-base-content/60">
                  {" · "}
                  {competitorCounts}
                </span>
              </span>
            </>
          ) : tracked.length > 0 ? (
            <>
              {/* A failed study flips the marker but keeps the counts: with
                  three tracked competitors, "last study failed" alone would
                  hide the two that worked. */}
              <RowMarker state={competitorStudyFailed ? "error" : "done"} />
              <Link
                to="/p/$projectId/plan"
                params={{ projectId }}
                className="group"
              >
                Competitors
                <span className="tabular-nums text-base-content/60 transition-colors group-hover:text-base-content">
                  {" · "}
                  {competitorCounts}
                  {competitorStudyFailed ? " · a study failed" : ""}
                </span>
              </Link>
            </>
          ) : (
            <>
              <RowMarker state="future" />
              <span className="text-base-content/50">
                Competitors · none tracked yet
              </span>
            </>
          )}
        </li>

        <KeywordsRow projectId={projectId} />

        <PagePlanRow projectId={projectId} />
      </ul>
    </div>
  );
}
