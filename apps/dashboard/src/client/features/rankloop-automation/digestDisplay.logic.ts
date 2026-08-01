// What the Digest card says: the day a digest is for, and the reading of one
// closed receipt.
//
// Deliberately thin, like automationDisplay. The headline, the null band that
// decides win/no_change/loss, and the blocked lines are all rendered by the
// server (`digest.logic.ts`) — a card that re-derived the band would sooner or
// later call a win what the stored digest called nothing.

// ---------------------------------------------------------------------------
// The day
// ---------------------------------------------------------------------------

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const dayFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/**
 * A digest's `forDate` as "Aug 1".
 *
 * Formatted in UTC on purpose, and not through the cards' `formatDay`: a bare
 * "2026-08-01" parses as UTC midnight, so a browser anywhere west of Greenwich
 * renders it as Jul 31 and the card names a different day than the routine
 * that wrote it — on a list of consecutive days, off by one is the difference
 * between "yesterday's digest" and a duplicate. Everything upstream counts
 * days in UTC (the quota's arithmetic, the receipt windows, the brief's
 * publish date), so the card does too.
 */
export function digestDayLabel(forDate: string): string {
  const match = ISO_DAY.exec(forDate);
  if (!match) return forDate;
  const stamp = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  return dayFormat.format(new Date(stamp));
}

// ---------------------------------------------------------------------------
// A measured receipt
// ---------------------------------------------------------------------------

type MeasuredLine = {
  /** The server's verdict, which owns the null band. */
  verdict: "win" | "no_change" | "loss";
  /** Clicks gained or lost against the baseline, after site-wide drift is
   *  divided out. Null when the stored baseline could not anchor a delta. */
  adjustedClicksDelta: number | null;
  /** Positive is an improvement — positions move down as pages move up. */
  positionDelta: number | null;
};

const clicksFormat = new Intl.NumberFormat("en-US", {
  signDisplay: "exceptZero",
  maximumFractionDigits: 0,
});

const positionsFormat = new Intl.NumberFormat("en-US", {
  signDisplay: "exceptZero",
  maximumFractionDigits: 1,
});

/**
 * What one closed receipt actually moved.
 *
 * A `no_change` verdict says so in words instead of printing "+2 clicks" and
 * letting the reader award themselves a win the server already declined to
 * call one. Those flat rows are the reason anybody believes the other ones: a
 * digest that only ever reported gains would be a marketing email.
 */
export function measuredResultLine(line: MeasuredLine): string {
  if (line.verdict === "no_change") {
    return line.adjustedClicksDelta === null
      ? "measured, but the baseline can't anchor a delta"
      : "no measurable change";
  }
  const parts: string[] = [];
  if (line.adjustedClicksDelta !== null) {
    parts.push(`${clicksFormat.format(line.adjustedClicksDelta)} clicks`);
  }
  if (line.positionDelta !== null) {
    parts.push(`${positionsFormat.format(line.positionDelta)} positions`);
  }
  // A verdict with no numbers behind it cannot happen today, but printing the
  // bare word beats printing an empty cell if the shapes ever drift.
  return parts.length === 0 ? line.verdict : parts.join(" · ");
}

/** Wins read in success, losses in error, and the honest flats stay neutral —
 *  the same ladder the receipts table uses for its clicks column. */
export function measuredResultTone(line: MeasuredLine): string {
  if (line.verdict === "win") return "text-success";
  if (line.verdict === "loss") return "text-error";
  return "text-base-content/60";
}

// ---------------------------------------------------------------------------
// Where the digest went
// ---------------------------------------------------------------------------

type Delivery = {
  channel: "in_app" | "email" | "webhook";
  status: "stored" | "sent" | "failed";
  /** The recorded reason, when the channel gave one. */
  error: string | null;
};

/** The one channel whose stored name is not what a person calls it. */
const CHANNEL_LABEL: Record<Delivery["channel"], string> = {
  in_app: "in-app",
  email: "email",
  webhook: "webhook",
};

type DeliveryFragment = { label: string; failed: boolean };

/**
 * A failure reason is quoted, not summarised, and it is cut here.
 *
 * The webhook's own response body is what lands in this column, and an
 * endpoint that answers a 500 with an HTML page would otherwise push a
 * paragraph of markup into a stamp. Eighty characters is the length of a
 * useful status line ("502 Bad Gateway from the endpoint") and short of the
 * length at which anybody reads it as prose.
 */
const DELIVERY_ERROR_MAX = 80;

function truncate(text: string): string {
  return text.length <= DELIVERY_ERROR_MAX
    ? text
    : `${text.slice(0, DELIVERY_ERROR_MAX - 1).trimEnd()}…`;
}

/**
 * Where one digest actually went, channel by channel.
 *
 * Rendered from the stored list rather than assembled here, in-app included:
 * the row being on screen looks like proof of in-app delivery, but a row
 * whose delivery pass never ran looks exactly the same, and this stamp is the
 * only place that difference is visible. So an empty list says so instead of
 * printing the one fragment it could always safely print.
 *
 * A channel nobody configured has no fragment at all — this reports what was
 * attempted, and "email not sent" on a project that never asked for email
 * would be a warning about a setting rather than about an event.
 *
 * Failures carry their reason and their own tone. A digest that quietly
 * stopped reaching the one place its reader looks is the exact failure this
 * feature exists to prevent, so it may not render like a success.
 */
export function deliveryFragments(deliveries: Delivery[]): DeliveryFragment[] {
  if (deliveries.length === 0) {
    return [{ label: "delivery not recorded", failed: false }];
  }
  return deliveries.map((delivery) => {
    const channel = CHANNEL_LABEL[delivery.channel];
    if (delivery.status !== "failed") {
      return { label: `${channel} ${delivery.status}`, failed: false };
    }
    return {
      label: delivery.error
        ? `${channel} failed — ${truncate(delivery.error)}`
        : `${channel} failed`,
      failed: true,
    };
  });
}
