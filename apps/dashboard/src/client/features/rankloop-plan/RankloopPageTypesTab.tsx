import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LayoutTemplate, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { EmptyCardBody } from "@/client/features/dashboard/cardParts";
import { planStamp } from "@/client/features/rankloop-plan/pagePlanDisplay.logic";
import { RankloopPagePlanKilled } from "@/client/features/rankloop-plan/RankloopPagePlanKilled";
import { RankloopPageTypeCard } from "@/client/features/rankloop-plan/RankloopPageTypeCard";
import { usePagePlanPolling } from "@/client/features/rankloop-plan/usePagePlanPolling";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { dataforseoHelpLinkOptions } from "@/client/navigation/items";
import { getSeoApiKeyStatus } from "@/serverFunctions/config";
import {
  decideRankloopPageType,
  startRankloopPagePlan,
} from "@/serverFunctions/rankloopPagePlan";

// Mirrors the loaded layout — a header row over two approval cards — so the
// shell stays put and only the data fills in.
function PagePlanLoadingState() {
  return (
    <div className="space-y-4" aria-busy>
      <div className="skeleton h-8 w-40" />
      {[0, 1].map((index) => (
        <div
          key={index}
          className="overflow-hidden rounded-xl border border-base-300 bg-base-100"
        >
          <div className="px-5 py-4">
            <div className="skeleton h-4 w-56" />
          </div>
          <div className="space-y-3 border-t border-base-300 p-5">
            <div className="skeleton h-3 w-72" />
            <div className="skeleton h-3 w-64" />
            <div className="skeleton h-3 w-52" />
            <div className="skeleton h-8 w-40" />
          </div>
        </div>
      ))}
    </div>
  );
}

// Blank slate, not a failure: page types are clustered from the backlog, so
// with nothing in it there is nothing to cluster and the fix lives one tab
// over.
function PagePlanEmptyState() {
  return (
    <section className="space-y-3 rounded-2xl border border-dashed border-base-300 bg-base-100/70 p-6 text-center text-base-content/50">
      <LayoutTemplate className="mx-auto size-10 opacity-40" />
      <p className="text-lg font-medium text-base-content/80">
        Build your keyword universe first
      </p>
      <p className="mx-auto max-w-md text-sm">
        Page types are clustered from it &mdash; every type is a group of
        backlog keywords that want the same shape of page.
      </p>
    </section>
  );
}

// SERP validation is the only key-gated half of this tab: detection, demand,
// competitor evidence and the contracts all run free. So the pitch sits above
// the cards rather than replacing them, and says what the key would add.
function MeteredValidationPitch() {
  return (
    <div className="rounded-xl border border-base-300 bg-base-100 p-5">
      <EmptyCardBody
        message="Add your DataForSEO API key to check each page type against live SERPs before you build it. Clustering runs without one — types propose with their verdict left honest at 'not sampled'."
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
  );
}

export function RankloopPageTypesTab({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const planQuery = usePagePlanPolling(projectId);

  const keyStatusQuery = useQuery({
    queryKey: ["seoApiKeyStatus"],
    queryFn: () => getSeoApiKeyStatus(),
  });
  // An unverifiable key check lands in the pitch too, rather than
  // error-coloring a tab that may work fine on retry.
  const keyless =
    keyStatusQuery.isError ||
    (keyStatusQuery.isSuccess && !keyStatusQuery.data.configured);

  const invalidatePlan = () =>
    queryClient.invalidateQueries({
      queryKey: ["rankloopPagePlan", projectId],
    });

  // Idempotent server-side: the partial unique index on page_plan_runs is the
  // arbiter, so a second click while a run is active reports the run it found
  // instead of starting a rival one.
  const recomputeMutation = useMutation({
    mutationFn: () => startRankloopPagePlan({ data: { projectId } }),
    onSuccess: (result) => {
      if (result.alreadyRunning) toast.info("A plan run is already running");
    },
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(error, "Couldn't start the plan run."),
      );
    },
    onSettled: () => {
      void invalidatePlan();
    },
  });

  // No optimistic flip: approving binds every keyword in the type, and the
  // card should only change once the server has done it — a card that says
  // "approved" over an unbound backlog is the one lie this screen can't
  // afford.
  const decideMutation = useMutation({
    mutationFn: (input: {
      pageTypeId: string;
      decision: "approved" | "declined";
    }) => decideRankloopPageType({ data: { projectId, ...input } }),
    onSuccess: (result, { decision }) => {
      toast.success(
        decision === "approved"
          ? `Approved — ${result.boundKeywords.toLocaleString("en-US")} keyword${
              result.boundKeywords === 1 ? "" : "s"
            } bound`
          : "Declined",
      );
    },
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(
          error,
          "Couldn't save the decision. Try again.",
        ),
      );
    },
    onSettled: () => {
      void invalidatePlan();
    },
  });

  if (planQuery.isPending) return <PagePlanLoadingState />;

  if (planQuery.isError) {
    return (
      <div className="alert alert-error">
        <span className="text-sm">
          {getStandardErrorMessage(planQuery.error)}
        </span>
      </div>
    );
  }

  const { lastRun, backlogCount, proposed, approved, declined, authority } =
    planQuery.data;
  const planning =
    lastRun?.status === "pending" || lastRun?.status === "running";
  const decidingId = decideMutation.isPending
    ? (decideMutation.variables?.pageTypeId ?? null)
    : null;
  const nothingPlanned =
    proposed.length === 0 && approved.length === 0 && declined.length === 0;

  if (backlogCount === 0 && nothingPlanned) return <PagePlanEmptyState />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <button
            type="button"
            className="btn btn-sm"
            disabled={recomputeMutation.isPending || planning}
            onClick={() => recomputeMutation.mutate()}
          >
            {recomputeMutation.isPending || planning ? (
              <Loader2 className="size-4 animate-spin" />
            ) : null}
            {planning ? "Planning…" : "Recompute plan"}
          </button>
          <p className="mt-1.5 text-xs text-base-content/55">
            ~$0.08 per recompute &middot; SERP samples are reused when you write
          </p>
        </div>
        {planQuery.isFetching && !planning ? (
          <Loader2 className="size-4 animate-spin text-base-content/40" />
        ) : null}
      </div>

      {lastRun?.status === "error" ? (
        <div className="alert alert-error">
          <span className="text-sm">
            The last plan run failed before it finished. Recompute to try again.
          </span>
        </div>
      ) : null}

      {keyless ? <MeteredValidationPitch /> : null}

      {proposed.map((pageType) => (
        <RankloopPageTypeCard
          key={pageType.id}
          projectId={projectId}
          pageType={pageType}
          authority={authority}
          deciding={decidingId === pageType.id}
          onDecide={(decision) =>
            decideMutation.mutate({ pageTypeId: pageType.id, decision })
          }
        />
      ))}

      {proposed.length === 0 && !planning ? (
        <div className="rounded-xl border border-dashed border-base-300 p-10 text-center text-sm text-base-content/55">
          {approved.length > 0
            ? "Nothing new to decide — every type the planner proposed has an answer."
            : "Nothing proposed from your backlog yet. Recompute the plan to cluster it again."}
        </div>
      ) : null}

      {approved.length > 0 ? (
        <div className="space-y-4">
          <p className="text-xs font-medium uppercase tracking-wide text-base-content/60">
            Approved ({approved.length})
          </p>
          {approved.map((pageType) => (
            <RankloopPageTypeCard
              key={pageType.id}
              projectId={projectId}
              pageType={pageType}
              authority={authority}
              deciding={decidingId === pageType.id}
              onDecide={(decision) =>
                decideMutation.mutate({ pageTypeId: pageType.id, decision })
              }
            />
          ))}
        </div>
      ) : null}

      <RankloopPagePlanKilled rows={declined} />

      {lastRun ? (
        <p className="text-[11px] text-base-content/45">
          {planStamp({
            keywordsClustered: lastRun.keywordsClustered,
            proposed: proposed.length + approved.length,
            notWorthBuilding: declined.length,
          })}
        </p>
      ) : null}
    </div>
  );
}
