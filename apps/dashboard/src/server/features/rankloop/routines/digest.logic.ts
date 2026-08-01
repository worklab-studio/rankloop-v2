// Pure assembly of the daily digest (spec 0024): the four sections a solo
// operator reads in the morning — what needs a decision, what shipped, what
// the receipts finally said, and what is stuck. No I/O and no Date.now(); the
// service hands this module rows and a date, which is what lets the tests
// build a whole day's news out of literals. Unit-tested in digest.logic.test.ts.
//
// The rule the whole file is built around: a digest with nothing in it is not
// written and not sent. A card that arrives every morning regardless of
// content is a card people stop opening, and by the second week it is worse
// than no card at all — so `assembleDigest` returns null on a quiet day and
// the caller stores nothing.

import type {
  DigestBlockedLine,
  DigestMeasuredLine,
  DigestPayload,
  DigestProposalLine,
  DigestShippedLine,
} from "@/types/schemas/rankloopRoutines";

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** How many proposals the card carries. Five is what fits above the fold and
 *  what a person will actually adjudicate over coffee; the rest are counted,
 *  not listed, because a digest that dumps forty decisions gets none of them. */
const DIGEST_TOP_PROPOSALS = 5;

/** Below this the window did not move enough to call either way. One click a
 *  month is noise on any page, so a page with almost no baseline needs at
 *  least that much movement... */
const NULL_BAND_MIN_CLICKS = 1;

/** ...and a page with real traffic needs the movement to clear a share of its
 *  own baseline, because ±3 clicks on a page that gets 400 is the same
 *  nothing. */
const NULL_BAND_SHARE = 0.05;

/** Spend only reaches the digest once it is close enough to a ceiling that
 *  the operator can still do something about it. Reporting 40% of a budget is
 *  reporting the weather. */
const SPEND_WARN_SHARE = 0.8;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A proposal sitting at 'proposed'. `createdAt` is carried only to break
 *  score ties, so two runs on the same data produce the same five rows. */
export type AwaitingProposal = {
  id: string;
  type: string;
  target: string;
  title: string | null;
  score: number;
  createdAt: string;
  /** Short evidence lines, already rendered by the service — the digest shows
   *  WHY, not just what. */
  evidence: string[];
};

/** A receipt that flipped to 'measured' in the reporting day. Positions are
 *  null when a window had no impressions to weight. */
export type MeasuredReceipt = {
  receiptId: string;
  actionType: string;
  target: string;
  baselineClicks: number;
  /** Site-drift-adjusted, straight off the stored result. */
  adjustedClicksDelta: number | null;
  baselinePosition: number | null;
  resultPosition: number | null;
};

/** Everything the engine could not get past on its own. Each field is
 *  independently absent — a project can be throttled without any gate
 *  failures, and usually is. */
export type BlockedInput = {
  /** The indexation throttle, when it is clamping today's quota. */
  throttle: { cap: number; reason: string } | null;
  /** Drafts parked in review because the laws failed, not because a human
   *  hasn't looked yet. */
  gateFailures: { title: string; attempts: number; failedLaws: string[] }[];
  adapterErrors: { adapter: string; detail: string }[];
  autopilotPause: { reason: string; since: string } | null;
  /** Whatever ceiling this deployment actually has — hosted credits or a
   *  self-host budget. Null where there is no ceiling to be near. */
  spend: { label: string; usedUsd: number; ceilingUsd: number } | null;
};

export type DigestInput = {
  /** YYYY-MM-DD, the day being reported on. */
  forDate: string;
  awaiting: AwaitingProposal[];
  shipped: DigestShippedLine[];
  measured: MeasuredReceipt[];
  blocked: BlockedInput;
};

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Hand-pluralized counts, the house style everywhere else in the app. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Awaiting a decision
// ---------------------------------------------------------------------------

/**
 * The five highest-scoring undecided proposals, with the full count beside
 * them. Ties break on the older proposal first and then on id: two identical
 * scores are common (the signals round to one decimal), and a digest that
 * shuffles its own top five between runs reads as a system that changed its
 * mind overnight.
 */
function topAwaiting(proposals: AwaitingProposal[]): {
  total: number;
  top: DigestProposalLine[];
} {
  const ranked = proposals.toSorted((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
  return {
    total: proposals.length,
    top: ranked.slice(0, DIGEST_TOP_PROPOSALS).map((proposal) => ({
      id: proposal.id,
      type: proposal.type,
      target: proposal.target,
      title: proposal.title,
      score: proposal.score,
      evidence: proposal.evidence,
    })),
  };
}

// ---------------------------------------------------------------------------
// What the receipts said
// ---------------------------------------------------------------------------

/**
 * Win, loss, or the honest null.
 *
 * The null band is the point of this function. A receipt whose adjusted delta
 * is +2 clicks on a page that was getting 400 did not "win" — reporting it as
 * one is how a tool teaches its owner to distrust it. The band scales with the
 * baseline for exactly that reason, with a floor so a page starting at zero
 * isn't graded against a threshold of zero.
 */
export function measurementVerdict(input: {
  baselineClicks: number;
  adjustedClicksDelta: number | null;
}): DigestMeasuredLine["verdict"] {
  // No adjusted delta means the stored baseline failed to parse; the window
  // still measured something, but nothing here can say what it means.
  if (input.adjustedClicksDelta === null) return "no_change";
  const band = Math.max(
    NULL_BAND_MIN_CLICKS,
    input.baselineClicks * NULL_BAND_SHARE,
  );
  if (input.adjustedClicksDelta >= band) return "win";
  if (input.adjustedClicksDelta <= -band) return "loss";
  return "no_change";
}

/** Positive means the page moved up the results. Null when either window had
 *  no impressions — there is no position to weight, and calling that a delta
 *  of zero would report a page nobody saw as a page that held its ground. */
export function positionDelta(
  baselinePosition: number | null,
  resultPosition: number | null,
): number | null {
  if (baselinePosition === null || resultPosition === null) return null;
  return round2(baselinePosition - resultPosition);
}

function measuredLines(receipts: MeasuredReceipt[]): DigestMeasuredLine[] {
  return receipts.map((receipt) => ({
    receiptId: receipt.receiptId,
    actionType: receipt.actionType,
    target: receipt.target,
    verdict: measurementVerdict(receipt),
    adjustedClicksDelta: receipt.adjustedClicksDelta,
    positionDelta: positionDelta(
      receipt.baselinePosition,
      receipt.resultPosition,
    ),
  }));
}

// ---------------------------------------------------------------------------
// What is stuck
// ---------------------------------------------------------------------------

/**
 * The blocked section, in the order an operator can act on it: a paused
 * autopilot and a rejected credential stop everything downstream, so they go
 * above a throttle that is merely slowing the day down.
 *
 * Spend is the one entry with a threshold of its own — see SPEND_WARN_SHARE.
 */
function blockedLines(blocked: BlockedInput): DigestBlockedLine[] {
  const lines: DigestBlockedLine[] = [];
  if (blocked.autopilotPause) {
    lines.push({
      kind: "autopilot_paused",
      detail: `${blocked.autopilotPause.reason} (since ${blocked.autopilotPause.since})`,
    });
  }
  for (const error of blocked.adapterErrors) {
    lines.push({
      kind: "adapter",
      detail: `${error.adapter}: ${error.detail}`,
    });
  }
  if (blocked.throttle) {
    lines.push({ kind: "throttle", detail: blocked.throttle.reason });
  }
  for (const failure of blocked.gateFailures) {
    const laws =
      failure.failedLaws.length > 0
        ? failure.failedLaws.join(", ")
        : "no law named";
    lines.push({
      kind: "gate",
      detail: `"${failure.title}" failed the gate ${plural(failure.attempts, "time")} — ${laws}`,
    });
  }
  if (
    blocked.spend &&
    blocked.spend.ceilingUsd > 0 &&
    blocked.spend.usedUsd / blocked.spend.ceilingUsd >= SPEND_WARN_SHARE
  ) {
    const used = blocked.spend.usedUsd.toFixed(2);
    const ceiling = blocked.spend.ceilingUsd.toFixed(2);
    lines.push({
      kind: "spend",
      detail: `${blocked.spend.label}: $${used} of $${ceiling} spent`,
    });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// The digest
// ---------------------------------------------------------------------------

/** The collapsed card's one line. Empty sections are omitted rather than
 *  printed as zeros — "0 shipped" is a sentence about nothing. */
function headlineFor(payload: Omit<DigestPayload, "headline">): string {
  const parts: string[] = [];
  if (payload.awaiting.total > 0) {
    parts.push(`${plural(payload.awaiting.total, "decision")} waiting`);
  }
  if (payload.shipped.length > 0) {
    parts.push(`${payload.shipped.length} shipped`);
  }
  if (payload.measured.length > 0) {
    parts.push(`${plural(payload.measured.length, "receipt")} in`);
  }
  if (payload.blocked.length > 0) {
    parts.push(`${plural(payload.blocked.length, "thing")} blocked`);
  }
  return parts.join(" · ");
}

/**
 * The day's digest, or null when there is nothing to say.
 *
 * Null is the important return value. Every section can legitimately be empty
 * — a project between publishes, with an empty queue and no receipts due, is a
 * healthy project having a quiet week — and the honest report of that is
 * nothing at all. Callers store and send only what comes back non-null.
 */
export function assembleDigest(input: DigestInput): DigestPayload | null {
  const awaiting = topAwaiting(input.awaiting);
  const measured = measuredLines(input.measured);
  const blocked = blockedLines(input.blocked);

  // Note what is NOT counted here: the raw `blocked` input. A spend entry
  // below its warning share produces no line, and a day whose only news was
  // "you have used 40% of your budget" is a quiet day.
  const sections =
    awaiting.total + input.shipped.length + measured.length + blocked.length;
  if (sections === 0) return null;

  const body = {
    forDate: input.forDate,
    awaiting,
    shipped: input.shipped,
    measured,
    blocked,
  };
  return { ...body, headline: headlineFor(body) };
}
