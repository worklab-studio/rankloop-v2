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

const deltaFormat = new Intl.NumberFormat("en-US", {
  signDisplay: "exceptZero",
});

export function formatClicksDelta(delta: number | null): string {
  return delta === null ? "—" : deltaFormat.format(delta);
}
