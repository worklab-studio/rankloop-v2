import { PublishConnectionRepository } from "@/server/features/rankloop/publish/repositories/PublishConnectionRepository";
import { PublishService } from "@/server/features/rankloop/publish/services/PublishService";
import { ProposalsService } from "@/server/features/rankloop/proposals/services/ProposalsService";
import { AutopilotRepository } from "@/server/features/rankloop/routines/repositories/AutopilotRepository";
import { AutopilotService } from "@/server/features/rankloop/routines/services/AutopilotService";
import { hasWriterProvider } from "@/server/features/rankloop/writing/draft";
import { ArticleWriteService } from "@/server/features/rankloop/writing/services/ArticleWriteService";
import { NetNewProposalsService } from "@/server/features/rankloop/writing/services/NetNewProposalsService";
import {
  AUTOPILOT_PROPOSAL_FAIL_LIMIT,
  AUTOPILOT_PUBLISH_CAP,
  AUTOPILOT_WRITE_CAP,
} from "@/shared/rankloop-autopilot";
import { parseLawReport } from "@/types/schemas/rankloopWriter";
import type { RankloopProposalListItem } from "@/types/schemas/rankloopProposals";

// The unattended run: three capped phases, and a recorded reason for every
// thing it decided not to do (spec 0025).
//
// Every refusal in this file is a no-op that says why. That is not politeness
// — it is the only way a machine that publishes without asking stays
// auditable: "autopilot did nothing this morning" and "autopilot was blocked
// by an indexation rate of 31%" look identical from the outside, and the
// second one is a fact somebody has to act on.
//
// The five preconditions from the spec, and where each is enforced:
//   1. trust dial          — `runAutopilot`, off the stored status
//   2. earned eligibility  — per action type, per phase, off AutopilotService
//   3. indexation throttle — the net-new cap in approve, and write
//   4. kill switch         — `AutopilotService.reconcile`, before anything
//   5. own preconditions   — a writer provider, a connected target, a passing
//                            gate, an approved proposal with no article yet

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

// The write and publish caps are imported rather than declared: Settings →
// Automation prints them as a promise about what runs while nobody is
// watching, and a promise typed out separately from the branch that enforces
// it is one edit away from being false. See shared/rankloop-autopilot.ts for
// why each number is what it is.

/** How deep into the review queue one run looks for something publishable.
 *  Drafts whose stored verdict is a fail sit here indefinitely, so a scan
 *  limited to the cap itself would let two of them block the queue forever. */
const REVIEW_SCAN_LIMIT = 10;

// ---------------------------------------------------------------------------
// What a run reports
// ---------------------------------------------------------------------------

type AutopilotPhase = "run" | "approve" | "write" | "publish";

/** One thing the machine actually did, with the id it did it to. Every one of
 *  these has a `decidedBy='autopilot'` row behind it. */
type AutopilotDecision = {
  phase: Exclude<AutopilotPhase, "run">;
  id: string;
  detail: string;
};

/** One thing the machine declined to do, and why. Deduplicated by reason:
 *  twenty proposals of one ineligible type are one fact, not twenty. */
type AutopilotRefusal = { phase: AutopilotPhase; reason: string };

type AutopilotRunResult = {
  decisions: AutopilotDecision[];
  refusals: AutopilotRefusal[];
};

type RunLog = {
  decided(phase: AutopilotDecision["phase"], id: string, detail: string): void;
  refused(phase: AutopilotPhase, reason: string): void;
  result(): AutopilotRunResult;
};

/** The run's own scratchpad: collects both lists and keeps the refusals
 *  unique, so callers never have to. */
function runLog(): RunLog {
  const decisions: AutopilotDecision[] = [];
  const refusals: AutopilotRefusal[] = [];
  return {
    decided: (phase, id, detail) => decisions.push({ phase, id, detail }),
    refused: (phase, reason) => {
      const held = refusals.some(
        (refusal) => refusal.phase === phase && refusal.reason === reason,
      );
      if (!held) refusals.push({ phase, reason });
    },
    result: () => ({ decisions, refusals }),
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

type Status = Awaited<ReturnType<typeof AutopilotService.getStatus>>;
type Quota = Awaited<ReturnType<typeof NetNewProposalsService.getWritingQuota>>;

/**
 * Act, for one project, on the freshest state the routine could give us.
 *
 * Ordered approve → write → publish because that is the pipeline's own
 * direction, and because each phase feeds the next one's queue on the FOLLOWING
 * run rather than this one: an article started here is not finished here, and a
 * phase that waited for the workflow it started would turn a routine tick into
 * a five-minute request.
 */
export async function runAutopilot(input: {
  projectId: string;
  now: Date;
}): Promise<AutopilotRunResult> {
  const log = runLog();

  // Precondition 4, first and on its own: everything below this line writes to
  // somebody's site or spends their money.
  const pause = await AutopilotService.reconcile(input);
  if (pause) {
    log.refused("run", pause.reason);
    return log.result();
  }

  const status = await AutopilotService.getStatus(input);
  // Precondition 1. The due-set already filtered on the dial, but a dial that
  // moved between the sweep and this call is exactly the case this exists for.
  if (status.trustDial !== "autopilot") {
    log.refused("run", `the trust dial is set to ${status.trustDial}`);
    return log.result();
  }

  const quota = await NetNewProposalsService.getWritingQuota(input.projectId);
  await approvePhase({ ...input, status, quota, log });
  await writePhase({ ...input, status, quota, log });
  await publishPhase({ ...input, status, log });
  return log.result();
}

/** What the dial means for one action type today, or the sentence explaining
 *  why the machine may not touch it. Merge and prune always land here — no
 *  cohort makes them eligible (autopilot.logic.ts). */
function earned(status: Status, actionType: string): string | null {
  const match = status.types.find((type) => type.actionType === actionType);
  if (!match) return `no receipts exist for ${actionType}`;
  if (match.behavior !== "autopilot") {
    return `${actionType}: ${match.fallbackReason ?? match.reason}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Phase 1 — approve
// ---------------------------------------------------------------------------

/**
 * Say yes, up to what today still owes.
 *
 * The cap is the day's quota minus the net-new proposals already approved and
 * not yet published — the debt this loop has already committed to. Without the
 * subtraction the same quota would be handed out again every fifteen minutes
 * until the queue held a week of work.
 *
 * Optimize types are not quota-bound (the quota counts posts, and a retitle
 * publishes nothing), but they share the phase cap: one number the Automation
 * surface can state in a sentence beats two nobody can predict. Their own
 * suppression rules already ran — a suppressed target never became a proposal.
 *
 * A project with the quota off therefore approves nothing at all, optimize
 * included. That is the deliberate reading of a null quota: "I'll choose what
 * gets written" is an instruction about the queue, not about one track of it,
 * and a machine deciding alone with no ceiling anywhere is not a state this
 * loop should be able to reach.
 */
async function approvePhase(input: {
  projectId: string;
  now: Date;
  status: Status;
  quota: Quota;
  log: RunLog;
}): Promise<void> {
  const committed = await AutopilotRepository.countCommittedNetNew(
    input.projectId,
  );
  const cap = Math.max(0, (input.quota.owed ?? 0) - committed);
  if (cap === 0) {
    input.log.refused(
      "approve",
      input.quota.reason ?? "today's quota is already committed",
    );
    return;
  }

  const queue = await ProposalsService.getProposals(
    input.projectId,
    "proposed",
  );
  // Precondition 3. A throttled site may still improve the pages it has — a
  // site Google is not indexing is exactly the site that should keep working
  // on what it already published — so the cap lands on net-new alone.
  const throttle = input.quota.throttle;
  const netNewCap = throttle?.cap ?? cap;
  let approved = 0;
  // Today's, not this run's. The throttle's cap is a per-day ceiling and this
  // is one wake of ninety-six, so a counter that started at zero every time
  // would pace the queue and never bound the day — the refusal sentence below
  // would print each tick while the cap was handed out again. Only paid for
  // when a throttle is actually on, so the healthy path keeps its one query.
  let netNew = throttle
    ? await AutopilotRepository.countNetNewApprovedSince(
        input.projectId,
        `${input.now.toISOString().slice(0, 10)}T00:00:00.000Z`,
      )
    : 0;

  for (const proposal of queue) {
    if (approved >= cap) {
      input.log.refused("approve", `today's quota of ${cap} is spent`);
      return;
    }
    const throttled =
      proposal.track === "net_new" && netNew >= netNewCap
        ? (throttle?.reason ?? `net-new is capped at ${netNewCap} this run`)
        : null;
    if (!(await approveOne({ ...input, proposal, throttled }))) continue;
    approved += 1;
    if (proposal.track === "net_new") netNew += 1;
  }
}

/** One proposal: eligible, inside the throttle, then approved as the machine.
 *  False means it was refused — the reason is already logged. */
async function approveOne(input: {
  projectId: string;
  proposal: RankloopProposalListItem;
  status: Status;
  /** The throttle's own sentence when it is what stops this row, else null. */
  throttled: string | null;
  log: RunLog;
}): Promise<boolean> {
  // Precondition 2. Merge and prune always land here.
  const notEarned = earned(input.status, input.proposal.type);
  if (notEarned) {
    input.log.refused("approve", notEarned);
    return false;
  }
  if (input.throttled) {
    input.log.refused("approve", input.throttled);
    return false;
  }

  await ProposalsService.decideProposal({
    projectId: input.projectId,
    proposalId: input.proposal.id,
    decision: "approved",
    // The whole point of the spec, on every row it writes.
    decidedBy: "autopilot",
  });
  input.log.decided(
    "approve",
    input.proposal.id,
    `${input.proposal.type} ${input.proposal.target}`,
  );
  return true;
}

// ---------------------------------------------------------------------------
// Phase 2 — write
// ---------------------------------------------------------------------------

/**
 * Put approved net-new work in front of the writer, two at a time.
 *
 * `startArticle` claims the article row through the partial unique on
 * `articles(proposal_id)`, which is the real concurrency guard: two dispatchers
 * reaching this line for one proposal produce one article and one
 * `alreadyWriting`, never two drafts and two bills.
 *
 * That guard is about two writers at once, not about the same writer forever.
 * A `failed` article frees the slot deliberately — it is what lets a human
 * write again after fixing the page type — so unattended, the same proposal
 * comes back every wake and is bought again. AUTOPILOT_PROPOSAL_FAIL_LIMIT is
 * where that stops, and it is a skip in this loop rather than a WHERE clause
 * because a proposal filtered out in SQL is one nobody can be told about.
 */
async function writePhase(input: {
  projectId: string;
  status: Status;
  quota: Quota;
  log: RunLog;
}): Promise<void> {
  const notEarned = earned(input.status, "write_new");
  if (notEarned) {
    input.log.refused("write", notEarned);
    return;
  }
  if (input.quota.throttle?.cap === 0) {
    input.log.refused("write", input.quota.throttle.reason);
    return;
  }
  // Its own precondition, checked rather than caught: `startArticle` throws
  // WRITER_NOT_CONFIGURED, and a throw per proposal per tick is the retry
  // storm this file exists to avoid.
  if (!(await hasWriterProvider())) {
    input.log.refused("write", "no writer provider is configured");
    return;
  }

  const writable = await AutopilotRepository.getWritableNetNewProposals(
    input.projectId,
    AUTOPILOT_WRITE_CAP,
  );
  if (writable.length === 0) {
    input.log.refused("write", "no approved net-new work is waiting");
    return;
  }

  for (const proposal of writable) {
    if (proposal.failedArticles >= AUTOPILOT_PROPOSAL_FAIL_LIMIT) {
      input.log.refused(
        "write",
        `${proposal.target}: ${proposal.failedArticles} drafts failed before reaching review — it needs a human`,
      );
      continue;
    }
    try {
      const started = await ArticleWriteService.startArticle({
        projectId: input.projectId,
        proposalId: proposal.id,
      });
      if (started.alreadyWriting) {
        input.log.refused(
          "write",
          "a draft for this proposal is already in flight",
        );
        continue;
      }
      input.log.decided("write", started.articleId, proposal.target);
    } catch (error) {
      input.log.refused("write", describeError(error));
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 3 — publish
// ---------------------------------------------------------------------------

/**
 * Publish the drafts that already cleared the laws, two at a time.
 *
 * `review` is only reached after a passing gate, and the stored verdict is
 * checked again here — but the decision that matters is preflight's, which
 * re-runs the laws against the stored draft microseconds before the adapter is
 * touched. This phase is the trigger, not the judge.
 */
async function publishPhase(input: {
  projectId: string;
  status: Status;
  log: RunLog;
}): Promise<void> {
  const notEarned = earned(input.status, "write_new");
  if (notEarned) {
    input.log.refused("publish", notEarned);
    return;
  }
  // Its own precondition. A rejected credential has already paused the run
  // upstream; this is the ordinary "nobody connected a target yet" case.
  const connection = await PublishConnectionRepository.getForProject(
    input.projectId,
  );
  if (!connection) {
    input.log.refused("publish", "no publish target is connected");
    return;
  }

  const review = await AutopilotRepository.getReviewArticles(
    input.projectId,
    REVIEW_SCAN_LIMIT,
  );
  let published = 0;
  for (const article of review) {
    if (published >= AUTOPILOT_PUBLISH_CAP) {
      input.log.refused(
        "publish",
        `${AUTOPILOT_PUBLISH_CAP} per run is the cap`,
      );
      return;
    }
    const report = parseLawReport(article.lawReportJson);
    if (!report?.passed) {
      input.log.refused(
        "publish",
        "a draft in review has not passed the gate — it needs a human",
      );
      continue;
    }
    try {
      const run = await PublishService.startPublish({
        projectId: input.projectId,
        articleId: article.id,
      });
      if (run.alreadyPublishing) {
        input.log.refused(
          "publish",
          "a publish for this article is already running",
        );
        continue;
      }
      input.log.decided("publish", article.id, article.keyword);
      published += 1;
    } catch (error) {
      input.log.refused("publish", describeError(error));
    }
  }
}

/** One bounded line — an adapter error body pasted whole into Workers Logs is
 *  how a useful log becomes an unreadable one. */
function describeError(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/\s+/g, " ").slice(0, 200)
    : "unknown error";
}
