import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Check, Circle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  advanceRankloopPipeline,
  getRankloopPipeline,
} from "@/serverFunctions/rankloopPipeline";
import type { Stage } from "@/server/features/rankloop/pipeline/pipeline.logic";

// The pipeline, rendered from the stage model (spec 0028).
//
// The old spine narrated the pipeline without ever starting it, which is why
// a new project sat at "not run yet" forever unless somebody found the right
// button on the right tab. This one calls advance() on arrival and keeps
// calling it while anything is in flight, so the chain walks itself.

const POLL_MS = 3000;

function StageMarker({ status }: { status: Stage["status"] }) {
  return (
    <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
      {status === "done" ? (
        <Check className="size-4 text-success" />
      ) : status === "running" ? (
        <span className="loading loading-spinner loading-xs" />
      ) : status === "error" ? (
        <AlertTriangle className="size-3.5 text-error" />
      ) : status === "needs_you" ? (
        <Circle className="size-2.5 fill-warning text-warning" />
      ) : (
        // `waiting` and `idle` share a marker on purpose: from the user's
        // side both mean "rankloop will get to this", and the difference
        // between them is an implementation detail of the scheduler.
        <span className="size-1.5 rounded-full bg-base-content/25" />
      )}
    </span>
  );
}

function StageRow({
  stage,
  projectId,
}: {
  stage: Stage;
  projectId: string;
}) {
  const muted =
    stage.status === "waiting" || stage.status === "idle"
      ? "text-base-content/40"
      : "";

  return (
    <li className="flex items-start gap-2.5 py-1 text-sm">
      <StageMarker status={stage.status} />
      <span className={`min-w-0 flex-1 ${muted}`}>
        <span className="font-medium">{stage.label}</span>
        <span className="text-base-content/60"> · {stage.detail}</span>
      </span>
      {/* Only a stage that actually needs a human gets a button. A `waiting`
          row offering an action would invite the user to do rankloop's job. */}
      {stage.status === "needs_you" && stage.action ? (
        <Link
          to={stage.action.to}
          params={{ projectId }}
          className="btn btn-xs shrink-0 gap-1"
        >
          {stage.action.label}
          <ArrowRight className="size-3" />
        </Link>
      ) : null}
    </li>
  );
}

export function RankloopSpine({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();

  const pipelineQuery = useQuery({
    queryKey: ["rankloopPipeline", projectId],
    queryFn: () => getRankloopPipeline({ data: { projectId } }),
    // Poll while anything is in flight so counts climb live, then stop. A
    // settled project costs no requests.
    refetchInterval: (query) => (query.state.data?.busy ? POLL_MS : false),
  });

  // What the last advance could not start, and why. Held here rather than
  // dropped: a cascade that silently skips a stage is indistinguishable from
  // one still thinking about it, and the user stares at "Nothing gathered
  // yet" with no idea that a harvest source is missing.
  const [skipped, setSkipped] = useState<
    { stage: string; reason: string }[]
  >([]);

  const advance = useMutation({
    mutationFn: () => advanceRankloopPipeline({ data: { projectId } }),
    onSuccess: (result) => {
      queryClient.setQueryData(["rankloopPipeline", projectId], result.pipeline);
      setSkipped(result.skipped);
    },
  });

  // Advance on arrival, and again each time the pipeline settles with work
  // still startable — that is the chain walking itself one link per poll.
  //
  // Guarded by a ref rather than a dependency array: `advance.mutate` is a
  // new function identity on every render, so depending on it would fire an
  // advance per render and hammer the endpoint.
  const advanceRef = useRef(advance.mutate);
  advanceRef.current = advance.mutate;
  const pipeline = pipelineQuery.data;
  const settled = pipeline?.settled ?? true;
  const busy = pipeline?.busy ?? false;

  useEffect(() => {
    if (pipeline === undefined) return;
    // Nothing to start and nothing running means the chain is genuinely
    // done; calling advance again would be a wasted round trip forever.
    if (settled && !busy) return;
    if (busy) return;
    // A stage that already refused to start will refuse again for the same
    // reason. Without this the effect re-fires on every poll and retries a
    // missing harvest source forever, several times a minute.
    if (skipped.length > 0) return;
    advanceRef.current();
  }, [pipeline, settled, busy, skipped.length]);

  if (pipelineQuery.isPending) {
    return (
      <div className="rounded-xl border border-base-300 bg-base-100 p-5">
        <div className="skeleton h-32" />
      </div>
    );
  }

  if (pipelineQuery.isError || pipeline === undefined) {
    return (
      <div className="rounded-xl border border-error/30 bg-error/5 p-4 text-sm">
        {getStandardErrorMessage(pipelineQuery.error)}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-base-300 bg-base-100 shadow-sm">
      <div className="flex items-center justify-between px-5 pt-4">
        <p className="text-xs font-medium uppercase tracking-wide text-base-content/50">
          Pipeline
        </p>
        {advance.isPending || pipeline.busy ? (
          <span className="text-[11px] text-base-content/40">working…</span>
        ) : null}
      </div>
      <ul className="space-y-0.5 p-5 pt-3">
        {pipeline.stages.map((stage) => (
          <StageRow key={stage.id} stage={stage} projectId={projectId} />
        ))}
      </ul>
      {skipped.length > 0 ? (
        <div className="border-t border-base-300 px-5 py-3">
          <p className="text-xs font-medium text-base-content/60">
            {skipped.length === 1
              ? "One step could not start"
              : `${skipped.length} steps could not start`}
          </p>
          <ul className="mt-1 space-y-1">
            {skipped.map((item) => (
              <li key={item.stage} className="text-xs text-base-content/50">
                <span className="font-medium">{item.stage}</span> —{" "}
                {item.reason}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="btn btn-xs mt-2"
            onClick={() => {
              setSkipped([]);
              advance.mutate();
            }}
          >
            Try again
          </button>
        </div>
      ) : null}
      {advance.isError ? (
        <p className="border-t border-base-300 px-5 py-2 text-xs text-error">
          {getStandardErrorMessage(advance.error)}
        </p>
      ) : null}
    </div>
  );
}
