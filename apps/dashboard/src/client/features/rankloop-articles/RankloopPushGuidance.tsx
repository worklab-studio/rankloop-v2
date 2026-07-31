import { useQuery } from "@tanstack/react-query";
import { CopyButton } from "@/client/features/ai-mcp/SetupControls";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { getRankloopPushGuidance } from "@/serverFunctions/rankloopPublish";

/**
 * The expandable detail behind an approved push: where to add the internal
 * links and what anchor to use. Fetched on expand — the candidate heuristic
 * walks the whole manifest, so it runs when someone actually looks, not for
 * every row in the tab.
 */
export function RankloopPushGuidance({
  projectId,
  proposalId,
}: {
  projectId: string;
  proposalId: string;
}) {
  const guidanceQuery = useQuery({
    queryKey: ["rankloopPushGuidance", projectId, proposalId],
    queryFn: () => getRankloopPushGuidance({ data: { projectId, proposalId } }),
  });

  if (guidanceQuery.isPending) {
    return (
      <div className="flex items-center gap-2 text-sm text-base-content/50">
        <span className="loading loading-spinner loading-xs" />
        Loading…
      </div>
    );
  }

  if (guidanceQuery.isError) {
    return (
      <p className="text-sm text-base-content/60">
        {getStandardErrorMessage(
          guidanceQuery.error,
          "Couldn't load link guidance.",
        )}
      </p>
    );
  }

  const guidance = guidanceQuery.data;

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <p className="text-xs font-medium uppercase tracking-wide text-base-content/60">
          Link from these posts
        </p>
        {guidance.candidates.length === 0 ? (
          <p className="text-sm text-base-content/60">
            No related posts found in the manifest yet.
          </p>
        ) : (
          <ul className="space-y-1">
            {guidance.candidates.map((candidate) => (
              <li
                key={candidate.path}
                className="flex flex-wrap items-baseline gap-x-3 text-sm"
              >
                <span className="font-mono text-xs">{candidate.path}</span>
                {candidate.title ? (
                  <span className="max-w-md truncate text-xs text-base-content/50">
                    {candidate.title}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {guidance.anchorQuery ? (
        <div className="space-y-1.5">
          <p className="text-xs font-medium uppercase tracking-wide text-base-content/60">
            Anchor suggestion
          </p>
          <div className="flex items-center gap-2">
            <span className="rounded-md border border-base-300 bg-base-100 px-2 py-1 font-mono text-xs">
              {guidance.anchorQuery}
            </span>
            <CopyButton
              value={guidance.anchorQuery}
              successMessage="Anchor copied"
            />
          </div>
        </div>
      ) : null}

      <p className="text-xs text-base-content/55">
        Add these links yourself, then mark done — automated link insertion
        arrives later.
      </p>
    </div>
  );
}
