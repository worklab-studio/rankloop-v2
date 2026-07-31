import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { RankloopCompetitorsTable } from "@/client/features/rankloop-plan/RankloopCompetitorsTable";
import { RankloopCompetitorSuggestions } from "@/client/features/rankloop-plan/RankloopCompetitorSuggestions";
import { useCompetitorsPolling } from "@/client/features/rankloop-plan/useCompetitorsPolling";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  addRankloopCompetitor,
  decideRankloopCompetitor,
  discoverRankloopCompetitors,
} from "@/serverFunctions/rankloopCompetitors";
import { domainField } from "@/types/schemas/domain";

// Mirrors the loaded layout — add row over two panels — so the shell stays
// put and only the data fills in.
function CompetitorsLoadingState() {
  return (
    <div className="space-y-4" aria-busy>
      <div className="skeleton h-9 w-80" />
      {[0, 1].map((index) => (
        <div
          key={index}
          className="overflow-hidden rounded-xl border border-base-300 bg-base-100"
        >
          <div className="border-b border-base-300 px-4 py-3">
            <div className="skeleton h-4 w-24" />
          </div>
          <div className="space-y-3 p-4">
            {[0, 1, 2].map((row) => (
              <div key={row} className="skeleton h-8 w-full" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function RankloopCompetitorsTab({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [domainInput, setDomainInput] = useState("");

  const competitorsQuery = useCompetitorsPolling(projectId);

  const invalidateCompetitors = () =>
    queryClient.invalidateQueries({
      queryKey: ["rankloopCompetitors", projectId],
    });

  const addMutation = useMutation({
    mutationFn: (domain: string) =>
      addRankloopCompetitor({ data: { projectId, domain } }),
    onSuccess: () => {
      setDomainInput("");
      toast.success("Competitor added");
    },
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(
          error,
          "Couldn't add the competitor. Try again.",
        ),
      );
    },
    onSettled: () => {
      void invalidateCompetitors();
    },
  });

  // Track kicks a study, so no optimistic flip: the row should move only once
  // the server has a run to report, otherwise it lands in the tracked table
  // with an empty status cell and looks stuck.
  const decideMutation = useMutation({
    mutationFn: (input: {
      competitorId: string;
      decision: "tracked" | "skipped";
    }) => decideRankloopCompetitor({ data: { projectId, ...input } }),
    onSuccess: (_result, { decision }) => {
      toast.success(decision === "tracked" ? "Tracking" : "Skipped");
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
      void invalidateCompetitors();
    },
  });

  const discoverMutation = useMutation({
    mutationFn: () => discoverRankloopCompetitors({ data: { projectId } }),
    onSuccess: (result) => {
      if (result.suggested === 0) {
        toast.info("No new competitors found");
        return;
      }
      toast.success(
        `Found ${result.suggested} competitor${
          result.suggested === 1 ? "" : "s"
        }`,
      );
    },
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(error, "Couldn't look for competitors."),
      );
    },
    onSettled: () => {
      void invalidateCompetitors();
    },
  });

  const handleAdd = (event: React.FormEvent) => {
    event.preventDefault();
    if (addMutation.isPending) return;
    // Same tldts-backed field the rank-tracking modal validates with, so a
    // full URL, a www prefix or a fake TLD is caught before it costs a
    // round-trip.
    const parsed = domainField.safeParse(domainInput);
    if (!parsed.success) {
      toast.error("Enter a valid domain like example.com");
      return;
    }
    addMutation.mutate(parsed.data);
  };

  if (competitorsQuery.isPending) return <CompetitorsLoadingState />;

  if (competitorsQuery.isError) {
    return (
      <div className="alert alert-error">
        <span className="text-sm">
          {getStandardErrorMessage(competitorsQuery.error)}
        </span>
      </div>
    );
  }

  const { tracked, suggested } = competitorsQuery.data;

  return (
    <div className="space-y-4">
      <div>
        <form className="flex flex-wrap items-end gap-2" onSubmit={handleAdd}>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Add a competitor</span>
            <input
              type="text"
              value={domainInput}
              onChange={(event) => setDomainInput(event.target.value)}
              placeholder="competitor.com"
              className="input input-bordered input-sm w-64"
            />
          </label>
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={addMutation.isPending}
          >
            {addMutation.isPending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : null}
            Add
          </button>
        </form>
        <p className="mt-1.5 text-xs text-base-content/55">
          Studied as soon as you add it. The sitemap half of a study needs no
          API key.
        </p>
      </div>

      <RankloopCompetitorSuggestions
        rows={suggested}
        decidingId={
          decideMutation.isPending
            ? (decideMutation.variables?.competitorId ?? null)
            : null
        }
        discovering={discoverMutation.isPending}
        onDecide={(competitorId, decision) =>
          decideMutation.mutate({ competitorId, decision })
        }
        onDiscover={() => discoverMutation.mutate()}
      />

      <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100">
        <div className="flex items-center justify-between gap-4 border-b border-base-300 px-4 py-3">
          <h2 className="text-base font-semibold leading-tight">Tracked</h2>
          {competitorsQuery.isFetching ? (
            <Loader2 className="size-4 animate-spin text-base-content/40" />
          ) : null}
        </div>
        {tracked.length === 0 ? (
          <p className="p-6 text-sm text-base-content/60">
            No competitors tracked yet &mdash; add a domain above or track a
            suggestion.
          </p>
        ) : (
          <RankloopCompetitorsTable projectId={projectId} rows={tracked} />
        )}
      </div>
    </div>
  );
}
