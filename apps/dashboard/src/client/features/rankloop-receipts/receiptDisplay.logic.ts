import type { TagColorKey } from "@/shared/tag-colors";

type ReceiptStatusDisplay = { label: string; color: TagColorKey };

// Status → chip mapping from spec 0013. 'baseline' reads "waiting" because
// that is what it means to the user: the action landed, and the evaluation
// window (days 14–42 after) hasn't opened yet.
const STATUS_DISPLAY = new Map<string, ReceiptStatusDisplay>([
  ["baseline", { label: "waiting", color: "slate" }],
  ["measuring", { label: "measuring", color: "sky" }],
  ["measured", { label: "measured", color: "emerald" }],
  ["contaminated", { label: "contaminated", color: "amber" }],
]);

export function receiptStatusDisplay(status: string): ReceiptStatusDisplay {
  return STATUS_DISPLAY.get(status) ?? { label: status, color: "slate" };
}

/**
 * Who decided the action this receipt measures.
 *
 * Three states, and the third one matters: null is a receipt from before
 * autopilot existed, where the database genuinely does not know. Labelling
 * those "human" would be a guess printed as a fact on the one screen whose
 * entire job is telling the truth about what the machine did — so they get no
 * chip, and the reader is left to notice the absence rather than trust a
 * wrong word.
 */
export function decidedByLabel(decidedBy: string | null): string | null {
  if (decidedBy === "autopilot") return "autopilot";
  if (decidedBy === "human") return "human";
  return null;
}

/** One decimal, matching every other position in the app; null renders the
 *  em dash the table uses for not-yet-measured cells. */
export function formatReceiptPosition(position: number | null): string {
  return position === null ? "—" : position.toFixed(1);
}

export function receiptClicksDelta(
  baseline: { clicks: number } | null,
  result: { clicks: number } | null,
): number | null {
  if (!baseline || !result) return null;
  return result.clicks - baseline.clicks;
}

/**
 * The clicks the action is actually credited with, in whole clicks.
 *
 * `trendAdjust` divides the site-wide drift out of the raw delta and stores
 * the remainder to two decimals, so a page that rose 80 clicks in a window
 * where the whole site rose 80% is credited with 0. That number is the one the
 * footer promises and the one the digest grades, so it belongs on this screen
 * beside the raw before→after rather than only in the database.
 *
 * Rounded here, not at the format call, because the cell's colour is decided
 * from the same value it prints: a "+0 adjusted" rendered in success green
 * would be this exact defect again, one decimal place down.
 */
export function receiptAdjustedClicksDelta(
  result: { adjustedClicksDelta: number | null } | null,
): number | null {
  const adjusted = result?.adjustedClicksDelta ?? null;
  if (adjusted === null) return null;
  // Math.round(-0.4) is -0; normalising keeps the value that decides the
  // colour identical to the one the cell prints.
  const rounded = Math.round(adjusted);
  return rounded === 0 ? 0 : rounded;
}

/**
 * What the clicks cell is allowed to claim.
 *
 * The raw delta is what the column prints — it mirrors the raw Position pair
 * beside it, and "clicks" on this screen means clicks somebody can go and
 * count. But the verdict the colour declares comes off the adjusted delta,
 * because that is what the panel's footer promises and what the digest card
 * says about the same receipt: green on a raw +80 the trend adjustment had
 * already taken back is the table calling a win nothing else in the product
 * agrees was one.
 *
 * The raw sign is the fallback only for receipts whose stored baseline never
 * parsed, where there is no adjustment to defer to. Same ladder as the digest
 * card: success, error, neutral — and no null band, which the server owns.
 */
export function receiptClicksTone(
  delta: number | null,
  adjustedDelta: number | null,
): string {
  const verdict = adjustedDelta ?? delta;
  if (verdict === null) return "text-base-content/40";
  if (verdict > 0) return "text-success";
  if (verdict < 0) return "text-error";
  return "";
}

const deltaFormat = new Intl.NumberFormat("en-US", {
  signDisplay: "exceptZero",
});

export function formatClicksDelta(delta: number | null): string {
  return delta === null ? "—" : deltaFormat.format(delta);
}
