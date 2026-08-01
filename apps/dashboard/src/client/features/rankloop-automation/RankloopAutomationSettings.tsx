import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import {
  behaviorDotClass,
  dispatcherCopy,
  nextRunCopy,
  pauseCopy,
  trustDialCopy,
} from "@/client/features/rankloop-automation/automationDisplay.logic";
import { proposalTypeDisplay } from "@/client/features/rankloop-articles/proposalDisplay.logic";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  getRankloopAutopilotStatus,
  getRankloopDispatcher,
} from "@/serverFunctions/rankloopRoutines";

type AutopilotStatus = Awaited<ReturnType<typeof getRankloopAutopilotStatus>>;
type DispatcherStatus = Awaited<ReturnType<typeof getRankloopDispatcher>>;

// The read-and-explain half of the trust dial. The dial itself is set on the
// Articles screen alongside the rest of the writing settings, because it is
// saved with them; what belongs here is everything the radio buttons cannot
// tell you — which mechanism is honouring the schedule on this deployment,
// which action types the receipts have actually cleared, and whether the loop
// has stopped itself.
//
// Every sentence with a threshold in it comes from the server verbatim
// (`autopilot.logic.ts` writes the eligibility clause and the pause reason),
// the same way the indexation card takes its throttle reason. A screen that
// re-derived "5 measured" would be a second opinion nobody asked for.

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-base-content/60">
        {title}
      </p>
      {children}
    </div>
  );
}

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
          <p className="text-xs text-base-content/55">
            {dispatcherCopy(dispatcher).detail}
          </p>
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
      <BehaviorList types={status.types} />
      <p className="text-xs text-base-content/55">
        A filled dot is an action type running unattended today; the clause
        beside each name is what its own receipts say.{" "}
        {status.trustDial === "autopilot"
          ? "A type publishes on its own the day its receipts say it works, and not before — the dial can't grant it early."
          : "This is what moving the dial to Autopilot would, and wouldn't, unlock today."}{" "}
        Receipts settle 90 days after their window closes, so a young site earns
        this slowly.{" "}
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

function PauseAlert({ status }: { status: AutopilotStatus }) {
  const copy = pauseCopy(status.pause);
  if (copy === null) return null;
  return (
    <div className="alert alert-warning">
      <AlertTriangle className="size-4 shrink-0" />
      <span className="text-sm">
        {copy}. Nothing publishes unattended until this clears — proposals keep
        queueing and stop at review.
        {status.adapterError
          ? ` Reconnect ${status.adapterError.adapter} to lift it.`
          : ""}
      </span>
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
            <PauseAlert status={status} />
            <TrustDialSection projectId={projectId} status={status} />
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
      </div>
    </div>
  );
}
