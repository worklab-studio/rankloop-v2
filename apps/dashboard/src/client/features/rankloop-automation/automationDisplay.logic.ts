import { parseDbTimestamp } from "@/client/features/dashboard/cardParts";

// What the Automation surface says about the parts of the loop nobody could
// work out from the settings form: which mechanism is honouring the schedule
// on THIS deployment, when the next run is due, where the trust dial puts the
// brakes, and how to read a per-action verdict.
//
// Deliberately thin. The eligibility clause and the pause sentence are
// rendered by the server (`autopilot.logic.ts`), the same way the indexation
// throttle's reason is — the thresholds live in one place, and a screen that
// re-derived them would eventually disagree with the routine that obeys them.
//
// Structural inputs rather than server types, the same way indexationDisplay
// and proposalDisplay take them: this layer states facts in English and has no
// business knowing which repository produced them.

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

type Dispatcher = {
  /** 'cron' is the worker's scheduled handler, which only fires on a real
   *  Cloudflare deploy; 'alarm' is the per-project Durable Object alarm, which
   *  is the one that fires under miniflare — local dev and Docker self-host. */
  mechanism: "cron" | "alarm";
  nextRunAt: string | null;
};

/**
 * Which mechanism is driving this deployment, named rather than implied.
 *
 * This line is why the surface exists at all. The 15-minute cron fires only on
 * Cloudflare, so on a Docker or local install every scheduled block silently
 * never ran and nothing in the app admitted it — the schedule was on screen
 * and the runs were not happening. Both mechanisms call the same
 * `runProjectRoutines`, so neither reading is worse news than the other; what
 * is not allowed is a screen that shows a schedule without saying who honours
 * it.
 */
export function dispatcherCopy(dispatcher: Dispatcher): {
  label: string;
  detail: string;
} {
  if (dispatcher.mechanism === "cron") {
    return {
      label: "Cloudflare cron",
      detail:
        "the deploy's own scheduler wakes the routines every 15 minutes, and the alarm idles behind it as a backstop",
    };
  }
  return {
    label: "Durable Object alarm",
    detail:
      "cron triggers never fire outside Cloudflare, so this install runs on a per-project alarm instead — same blocks, same order, same code path",
  };
}

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;

/**
 * When the next run is due, in the units a person would say it in.
 *
 * "Overdue" is a real state worth showing rather than rounding down to "due
 * now": an alarm that was lost is re-armed by the next request through the
 * app, so a number climbing here is the symptom somebody should be able to see
 * on the screen before they go reading logs.
 */
export function nextRunCopy(
  nextRunAt: string | null,
  now: number = Date.now(),
): string {
  if (nextRunAt === null) return "no run scheduled yet";
  const ms = parseDbTimestamp(nextRunAt);
  if (Number.isNaN(ms)) return "no run scheduled yet";
  const delta = ms - now;
  if (delta <= 0) {
    const late = Math.floor(-delta / MS_PER_MINUTE);
    return late < 2 ? "next run due now" : `next run ${late}m overdue`;
  }
  if (delta < MS_PER_MINUTE) return "next run due in under a minute";
  if (delta < MS_PER_HOUR) {
    return `next run in ${Math.round(delta / MS_PER_MINUTE)}m`;
  }
  return `next run in ${Math.round(delta / MS_PER_HOUR)}h`;
}

// ---------------------------------------------------------------------------
// The trust dial
// ---------------------------------------------------------------------------

type TrustDial = "titles" | "drafts" | "autopilot";

/** Where the dial currently puts the brakes, in one sentence. The autopilot
 *  line names its own fallback instead of promising the setting alone does
 *  anything: a dial set to autopilot with nothing eligible behaves exactly
 *  like Drafts, and any other wording here would be the screen lying. */
export function trustDialCopy(trustDial: TrustDial): string {
  if (trustDial === "titles") {
    return "Titles only — rankloop picks the keyword and assembles the brief, and you write the post.";
  }
  if (trustDial === "drafts") {
    return "Drafts — rankloop writes and stops at review. Nothing reaches your site without a yes.";
  }
  return "Autopilot — action types that have earned it run without you. Everything else falls back to Drafts.";
}

// ---------------------------------------------------------------------------
// Per-action verdicts
// ---------------------------------------------------------------------------

/** The severity dot beside each action type. It tracks the BEHAVIOR, not the
 *  eligibility: a type whose receipts have earned autopilot still runs through
 *  review while the dial says Drafts or the kill switch is down, and a filled
 *  dot in that state would be the screen promising something that isn't
 *  happening. The clause beside it carries what the receipts say. */
export function behaviorDotClass(row: { behavior: string }): string {
  return row.behavior === "autopilot" ? "bg-success" : "bg-base-content/30";
}

// ---------------------------------------------------------------------------
// The kill switch
// ---------------------------------------------------------------------------

type Pause = {
  /** The server's whole sentence, rendered verbatim so this screen and the
   *  digest can never disagree about why autopilot stopped. */
  reason: string;
  since: string;
};

const MS_PER_DAY = 86_400_000;

function pausedAgo(since: string, now: number): string | null {
  const ms = parseDbTimestamp(since);
  if (Number.isNaN(ms)) return null;
  const hours = Math.floor((now - ms) / MS_PER_HOUR);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor((now - ms) / MS_PER_DAY)}d ago`;
}

/**
 * The kill-switch line, or null when the switch has not tripped.
 *
 * Null rather than a reassuring "not tripped" row: a switch that has never
 * fired is not news, and a permanent green line about it is how people stop
 * reading the place the red one will appear.
 */
export function pauseCopy(
  pause: Pause | null,
  now: number = Date.now(),
): string | null {
  if (pause === null) return null;
  const ago = pausedAgo(pause.since, now);
  return ago === null ? pause.reason : `${pause.reason} · ${ago}`;
}
