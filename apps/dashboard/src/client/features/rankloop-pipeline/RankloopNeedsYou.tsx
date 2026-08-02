import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { getRankloopPipeline } from "@/serverFunctions/rankloopPipeline";

// The only card on Today that asks for anything (spec 0028).
//
// It is populated exclusively by `needs_you` stages, which is the whole
// point: a project with eight unfinished stages and two real decisions shows
// two rows, not ten. Everything else rankloop is getting to on its own, and
// listing those as tasks would hand the user work that is not theirs.
export function RankloopNeedsYou({ projectId }: { projectId: string }) {
  const pipelineQuery = useQuery({
    queryKey: ["rankloopPipeline", projectId],
    queryFn: () => getRankloopPipeline({ data: { projectId } }),
  });

  const needsYou = pipelineQuery.data?.needsYou ?? [];

  // Nothing to say beats an empty card saying nothing. The spine below
  // already shows the state; a permanent "You're all caught up!" panel is
  // just furniture.
  if (pipelineQuery.isPending || needsYou.length === 0) return null;

  return (
    <div className="rounded-xl border border-warning/30 bg-warning/5 shadow-sm">
      <p className="px-5 pt-4 text-xs font-medium uppercase tracking-wide text-warning">
        {needsYou.length === 1 ? "One thing needs you" : `${needsYou.length} things need you`}
      </p>
      <ul className="divide-y divide-warning/10 px-5 py-2">
        {needsYou.map((stage) => (
          <li
            key={stage.id}
            className="flex items-center justify-between gap-4 py-2.5"
          >
            <span className="min-w-0">
              <span className="block text-sm font-medium">
                {stage.blockedBy ?? stage.label}
              </span>
              <span className="block text-xs text-base-content/60">
                {stage.detail}
              </span>
            </span>
            {stage.action ? (
              <Link
                to={stage.action.to}
                params={{ projectId }}
                className="btn btn-sm shrink-0 gap-1"
              >
                {stage.action.label}
                <ArrowRight className="size-3.5" />
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
