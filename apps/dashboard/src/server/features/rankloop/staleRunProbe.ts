// Stale-run probe shared by rankloop's run-per-workflow services (gsc-sync,
// site-study). Both coordinate the way rank checks do: workflow instance
// id === run row id, and the partial unique on (project_id) WHERE status IN
// ('pending','running') is the only lock. A workflow that dies without
// reaching its mark-error step leaves that row active forever and the slot
// wedged — this probe is how the next start decides the blocker is a zombie.

type WorkflowInstanceStatus = {
  status:
    | "queued"
    | "running"
    | "paused"
    | "errored"
    | "terminated"
    | "complete"
    | "waiting"
    | "waitingForPause"
    | "unknown";
  error?: { message: string };
};

/** Structural subset of a workflow binding — the generated `Workflow`
 *  classes satisfy it, and tests can hand in a plain object. */
type ProbeWorkflow = {
  get(id: string): Promise<{ status(): Promise<WorkflowInstanceStatus> }>;
};

const ACTIVE_WORKFLOW_STATUSES = new Set<WorkflowInstanceStatus["status"]>([
  "queued",
  "running",
  "waiting",
  "waitingForPause",
  "paused",
]);

// A just-created instance can report 'unknown' — or not be gettable at all —
// for a beat before the engine registers it. Within this window a missing
// status is startup latency, not death (the rank-check guards' 60 seconds).
const STALE_RUN_STARTUP_GRACE_MS = 60 * 1000;

/**
 * Probe the workflow instance behind an active run row and return why it is
 * stale, or null while the instance is genuinely live (or the row is too
 * young to judge). Callers flip the row to error themselves — the run tables
 * differ per service, the verdict doesn't.
 */
export async function getStaleRunReason(input: {
  workflow: ProbeWorkflow;
  runId: string;
  ageMs: number;
}): Promise<string | null> {
  let workflowStatus: WorkflowInstanceStatus | null = null;
  try {
    const instance = await input.workflow.get(input.runId);
    workflowStatus = await instance.status();
  } catch {
    // get() rejects for ids the engine has no record of.
  }

  if (workflowStatus && ACTIVE_WORKFLOW_STATUSES.has(workflowStatus.status)) {
    return null;
  }

  if (
    input.ageMs < STALE_RUN_STARTUP_GRACE_MS &&
    (!workflowStatus || workflowStatus.status === "unknown")
  ) {
    return null;
  }

  if (!workflowStatus) {
    return "Workflow instance was not found";
  }
  if (
    workflowStatus.status === "errored" ||
    workflowStatus.status === "terminated"
  ) {
    return workflowStatus.error?.message ?? `Workflow ${workflowStatus.status}`;
  }
  if (workflowStatus.status === "complete") {
    return "Workflow completed without finalizing the run";
  }
  return `Workflow is no longer active (${workflowStatus.status})`;
}
