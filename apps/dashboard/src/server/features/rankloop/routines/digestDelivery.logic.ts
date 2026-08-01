// What the digest looks like on its way out (spec 0025 §"Digest delivery"):
// the JSON a webhook receiver is handed, and the three strings a mail template
// is filled with. No I/O, no clock, no secrets — DigestDeliveryService hands
// this module a stored payload and gets back the bytes it sends, which is what
// lets the tests assert the envelope and the mail body out of literals.
//
// The rendering is deliberately plain text rather than HTML. The mail template
// lives in Loops and belongs to whoever runs the deployment; sending it markup
// would decide their design for them, and sending it the payload as JSON would
// make every template author write this renderer again.

import type { DigestPayload } from "@/types/schemas/rankloopRoutines";

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

/** The event name on the envelope and in the `X-Rankloop-Event` header. Named
 *  `digest.daily` in the same `noun.verb` shape as the publish adapter's
 *  `post.create` and `hub.ensure`, so one receiver can switch on all of them. */
export const DIGEST_WEBHOOK_EVENT = "digest.daily";

/**
 * The signed body.
 *
 * `payload` is the stored digest verbatim — the same object the card renders —
 * because a receiver that reformats the morning news should be reformatting
 * what the operator was actually told, not a second summary that could drift
 * from it. `projectId` rides along because a receiver may serve several
 * projects and the URL alone does not say which one this is.
 */
export function digestEnvelope(input: {
  projectId: string;
  payload: DigestPayload;
}): Record<string, unknown> {
  return {
    event: DIGEST_WEBHOOK_EVENT,
    projectId: input.projectId,
    forDate: input.payload.forDate,
    payload: input.payload,
  };
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/** A signed number, so a receipt line reads "+40" and not "40" when it won. */
function signed(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

function awaitingSection(payload: DigestPayload): string[] {
  if (payload.awaiting.total === 0) return [];
  const lines = [`Waiting on you (${payload.awaiting.total}):`];
  for (const line of payload.awaiting.top) {
    lines.push(`- ${line.type} ${line.target} — score ${line.score}`);
  }
  // The card counts the whole queue and lists five; the mail says so out loud
  // rather than letting a queue of forty look like a queue of five.
  const hidden = payload.awaiting.total - payload.awaiting.top.length;
  if (hidden > 0) lines.push(`- …and ${hidden} more`);
  return lines;
}

function shippedSection(payload: DigestPayload): string[] {
  if (payload.shipped.length === 0) return [];
  return [
    "Shipped:",
    ...payload.shipped.map((line) =>
      // A null URL is the adapter saying it could not confirm where the page
      // landed. Printing a guessed link in an email is worse than printing
      // none, because nobody checks a link they were mailed.
      line.url ? `- ${line.title} — ${line.url}` : `- ${line.title}`,
    ),
  ];
}

function measuredSection(payload: DigestPayload): string[] {
  if (payload.measured.length === 0) return [];
  return [
    "Measured:",
    ...payload.measured.map((line) => {
      const delta =
        line.adjustedClicksDelta === null
          ? "no clicks to compare"
          : `${signed(line.adjustedClicksDelta)} clicks`;
      return `- ${line.verdict.replace("_", " ")}: ${line.target} (${delta})`;
    }),
  ];
}

function blockedSection(payload: DigestPayload): string[] {
  if (payload.blocked.length === 0) return [];
  return ["Blocked:", ...payload.blocked.map((line) => `- ${line.detail}`)];
}

/**
 * The digest as a plain-text block, sections in the order the card shows them.
 *
 * Empty sections are omitted entirely rather than printed with "none": the
 * digest exists only on a day that had news, and a mail listing four headings
 * with nothing under three of them buries the one that matters.
 */
export function digestSummaryText(payload: DigestPayload): string {
  const sections = [
    awaitingSection(payload),
    shippedSection(payload),
    measuredSection(payload),
    blockedSection(payload),
  ].filter((section) => section.length > 0);
  return sections.map((section) => section.join("\n")).join("\n\n");
}

/**
 * The template's variables — the contract a deployment's Loops template is
 * written against, and the reason it is three fields and not the payload:
 * every field added here is a field an already-published template does not
 * render, so the set stays small enough to be permanent.
 */
export function digestEmailVariables(
  payload: DigestPayload,
): Record<string, string> {
  return {
    forDate: payload.forDate,
    headline: payload.headline,
    summary: digestSummaryText(payload),
  };
}
