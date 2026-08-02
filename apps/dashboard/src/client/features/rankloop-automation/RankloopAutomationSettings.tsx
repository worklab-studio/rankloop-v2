import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Section } from "@/client/features/rankloop-automation/RankloopAutomationParts";
import { RankloopDigestDelivery } from "@/client/features/rankloop-automation/RankloopDigestDelivery";
import {
  behaviorDotClass,
  dispatcherCopy,
  hasEarnedAnything,
  nextRunCopy,
  nothingEarnedYetCopy,
  pauseCopy,
  trustDialCopy,
  unattendedCapsCopy,
} from "@/client/features/rankloop-automation/automationDisplay.logic";
import { proposalTypeDisplay } from "@/client/features/rankloop-articles/proposalDisplay.logic";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  getRankloopAutopilotStatus,
  getRankloopDispatcher,
  resumeRankloopAutopilot,
} from "@/serverFunctions/rankloopRoutines";

type AutopilotStatus = Awaited<ReturnType<typeof getRankloopAutopilotStatus>>;
type DispatcherStatus = Awaited<ReturnType<typeof getRankloopDispatcher>>;

// The read-and-explain half of the trust dial. The dial itself is set on the
// Articles screen alongside the rest of the writing settings, because it is
// saved with them; what belongs here is everything the radio buttons cannot
// tell you — which mechanism is honouring the schedule on this deployment,
// which action types the receipts have actually cleared, how much one
// unattended run may do, whether the loop has stopped itself, and where the
// morning digest goes.
//
// Every sentence with a threshold in it comes from the server verbatim
// (`autopilot.logic.ts` writes the eligibility clause and the pause reason),
// the same way the indexation card takes its throttle reason. A screen that
// re-derived "5 measured" would be a second opinion nobody asked for.

function DispatcherSection({ projectId }: { projectId: string }) {
  const dispatcherQuery = useQuery({
    queryKey: ["rankloopDispatcher", projectId],
    queryFn: () => getRankloopDispatcher({ data: { projectId } }),
  });
  const dispatcher: DispatcherStatus | undefined = dispatcherQuery.data;

  return (
    <Section title="Dispatcher">
      {dispatcher ? (
        <>
          <p className="text-sm">
            {dispatcherCopy(dispatcher).label}
            <span className="text-base-content/60">
              {" · "}
              {nextRunCopy(dispatcher.nextRunAt)}
            </span>
          </p>
          {/* Which mechanism honours the schedule matters to whoever
              deployed this; on the first morning it is trivia sitting above
              the thing the operator came to read. Available, not shouted. */}
          <details className="group">
            <summary className="cursor-pointer text-xs text-base-content/45 hover:text-base-content/70">
              How this deployment runs it
            </summary>
            <p className="mt-1 text-xs text-base-content/55">
              {dispatcherCopy(dispatcher).detail}
            </p>
          </details>
        </>
      ) : dispatcherQuery.isError ? (
        <p className="text-sm text-base-content/60">
          Couldn&rsquo;t read the schedule. Try again shortly.
        </p>
      ) : (
        <div aria-busy className="space-y-2">
          <div className="skeleton h-4 w-56" />
          <div className="skeleton h-3 w-72" />
        </div>
      )}
    </Section>
  );
}

function BehaviorList({ types }: { types: AutopilotStatus["types"] }) {
  return (
    <ul className="space-y-1.5">
      {types.map((row) => (
        <li key={row.actionType} className="flex items-start gap-2 text-sm">
          <span
            className={`mt-1.5 size-2 shrink-0 rounded-full ${behaviorDotClass(row)}`}
          />
          <span className="min-w-0">
            <span className="font-medium">
              {proposalTypeDisplay(row.actionType).label}
            </span>
            <span className="text-base-content/60">
              {": "}
              {row.reason}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function TrustDialSection({
  projectId,
  status,
}: {
  projectId: string;
  status: AutopilotStatus;
}) {
  return (
    <Section title="Trust dial">
      <p className="text-sm">{trustDialCopy(status.trustDial)}</p>
      {hasEarnedAnything(status.types) ? (
        <BehaviorList types={status.types} />
      ) : (
        <>
          <p className="text-sm text-base-content/70">
            {nothingEarnedYetCopy()}
          </p>
          <details className="group">
            <summary className="cursor-pointer text-xs text-base-content/45 hover:text-base-content/70">
              What each action type is waiting for
            </summary>
            <div className="mt-2">
              <BehaviorList types={status.types} />
            </div>
          </details>
        </>
      )}
      {/* The legend explains the dot list, so it travels with it: printed
          beside a collapsed list it describes something the reader cannot
          see. What survives in both states is the one link that lets them
          act. */}
      <p className="text-xs text-base-content/55">
        {hasEarnedAnything(status.types) ? (
          <>
            A filled dot is an action type running unattended today; the clause
            beside each name is what its own receipts say.{" "}
            {status.trustDial === "autopilot"
              ? "A type publishes on its own the day its receipts say it works, and not before — the dial can't grant it early."
              : "This is what moving the dial to Autopilot would, and wouldn't, unlock today."}{" "}
            Receipts settle 90 days after their window closes, so a young site
            earns this slowly.{" "}
          </>
        ) : null}
        <Link
          to="/p/$projectId/articles"
          params={{ projectId }}
          className="link link-primary font-medium"
        >
          Set the dial in Articles →
        </Link>
      </p>
    </Section>
  );
}

// What a machine is allowed to do in one wake, stated in numbers before
// anybody needs them. The caps come from the constants the block stops at, and
// the paragraph after them names the two actions that are NOT in this list:
// a surface that described three unattended phases and left the reader to
// infer the rest would be promising automation the loop does not do.
function UnattendedRunSection({ projectId }: { projectId: string }) {
  return (
    <Section title="Unattended runs">
      <p className="text-sm">
        On the types that have earned it, autopilot {unattendedCapsCopy()}.
      </p>
      <p className="text-xs text-base-content/55">
        Every one of those decisions is stamped{" "}
        <span className="font-medium">autopilot</span> on the receipt it
        creates, which is what makes a bad week readable afterwards instead of
        indistinguishable from your own.{" "}
        <Link
          to="/p/$projectId/receipts"
          params={{ projectId }}
          className="link link-primary font-medium"
        >
          See who decided what in Receipts →
        </Link>
      </p>
      <p className="text-xs text-base-content/55">
        Retitle and push still need your click. Autopilot can approve one, but
        applying it edits a page that is already live through your publish
        adapter, and that path is not gated by receipts the way writing and
        publishing are — so it waits for you on the Opportunities screen.
      </p>
    </Section>
  );
}

// The pause and the one action that clears it, in the same block: a switch a
// person is told about and cannot see the release for is a support ticket.
function PauseAlert({
  projectId,
  status,
}: {
  projectId: string;
  status: AutopilotStatus;
}) {
  const queryClient = useQueryClient();
  const resumeMutation = useMutation({
    mutationFn: () => resumeRankloopAutopilot({ data: { projectId } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["rankloopAutopilotStatus", projectId],
      });
      toast.success("Autopilot resumed");
    },
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(error, "Couldn't resume autopilot. Try again."),
      );
    },
  });

  const copy = pauseCopy(status.pause);
  if (copy === null) return null;
  return (
    <div className="alert alert-warning flex-wrap items-start">
      <AlertTriangle className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 text-sm">
        {copy}. Nothing publishes unattended until this clears — proposals keep
        queueing and stop at review.
        {status.adapterError
          ? ` Reconnect ${status.adapterError.adapter} to lift it.`
          : ""}
      </span>
      <button
        type="button"
        className="btn btn-sm"
        disabled={resumeMutation.isPending}
        onClick={() => resumeMutation.mutate()}
      >
        {resumeMutation.isPending ? (
          <Loader2 className="size-3 animate-spin" />
        ) : null}
        Resume autopilot
      </button>
    </div>
  );
}

function StatusPill({ paused }: { paused: boolean }) {
  return (
    <span
      className={[
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        paused
          ? "border-warning/30 bg-warning/10 text-warning"
          : "border-base-300 bg-base-200 text-base-content/60",
      ].join(" ")}
    >
      <span
        className={`size-1.5 rounded-full ${paused ? "bg-warning" : "bg-base-content/40"}`}
      />
      {paused ? "Paused" : "Running"}
    </span>
  );
}

export function RankloopAutomationSettings({
  projectId,
}: {
  projectId: string;
}) {
  const statusQuery = useQuery({
    queryKey: ["rankloopAutopilotStatus", projectId],
    queryFn: () => getRankloopAutopilotStatus({ data: { projectId } }),
  });
  const status: AutopilotStatus | undefined = statusQuery.data;

  return (
    <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100 shadow-sm">
      <div className="flex items-start justify-between gap-4 p-5 sm:p-6">
        <h2 className="text-base font-semibold leading-tight">
          Daily routines
        </h2>
        {status ? <StatusPill paused={status.pause !== null} /> : null}
      </div>
      <div className="space-y-5 border-t border-base-300 p-5 sm:p-6">
        {/* The dispatcher reads from the dispatch lane and the dial from the
            autopilot lane, so they load independently: a schedule this app
            cannot read is no reason to hide what the receipts earned. */}
        <DispatcherSection projectId={projectId} />

        {status ? (
          <>
            <PauseAlert projectId={projectId} status={status} />
            <TrustDialSection projectId={projectId} status={status} />
            {/* Caps on unattended work are worth stating before they bind —
                but not to a project where nothing can run unattended at all.
                Until a type has earned it, this section describes a machine
                that cannot move, which is how a true paragraph becomes noise. */}
            {hasEarnedAnything(status.types) ? (
              <UnattendedRunSection projectId={projectId} />
            ) : null}
          </>
        ) : statusQuery.isError ? (
          <p className="text-sm text-base-content/60">
            {getStandardErrorMessage(
              statusQuery.error,
              "Couldn't read what autopilot has earned. Try again shortly.",
            )}
          </p>
        ) : (
          // Mirrors the loaded layout — an eyebrow, a sentence, then a row per
          // action type — so the card keeps its height and the words fill in.
          <div aria-busy className="space-y-2">
            <div className="skeleton h-3 w-20" />
            <div className="skeleton h-4 w-64" />
            <div className="skeleton h-24 w-full" />
          </div>
        )}

        {/* Delivery is about the digest rather than about the dial, so it
            renders whether or not the autopilot read succeeded. */}
        <RankloopDigestDelivery projectId={projectId} />
      </div>
    </div>
  );
}
