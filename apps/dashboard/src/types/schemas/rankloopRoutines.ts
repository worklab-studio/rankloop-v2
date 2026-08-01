import { z } from "zod";

// ---------------------------------------------------------------------------
// JSON column shapes
// ---------------------------------------------------------------------------

/** One proposal the operator has not answered yet, with the evidence lines
 *  that justified it — a decision surface that shows the ask without the WHY
 *  is asking for a coin flip. */
const digestProposalLineSchema = z.object({
  id: z.string(),
  type: z.string(),
  target: z.string(),
  title: z.string().nullable(),
  score: z.number(),
  evidence: z.array(z.string()),
});

export type DigestProposalLine = z.infer<typeof digestProposalLineSchema>;

/** A page that went live. `url` is null when the adapter computed a path it
 *  could not confirm — the digest says so rather than linking somewhere that
 *  may 404. */
const digestShippedLineSchema = z.object({
  articleId: z.string(),
  title: z.string(),
  url: z.string().nullable(),
});

export type DigestShippedLine = z.infer<typeof digestShippedLineSchema>;

/** A receipt that closed. `verdict` carries the null case as a first-class
 *  answer: "we did this and nothing measurable happened" is the finding that
 *  makes the wins believable. */
const digestMeasuredLineSchema = z.object({
  receiptId: z.string(),
  actionType: z.string(),
  target: z.string(),
  verdict: z.enum(["win", "no_change", "loss"]),
  adjustedClicksDelta: z.number().nullable(),
  positionDelta: z.number().nullable(),
});

export type DigestMeasuredLine = z.infer<typeof digestMeasuredLineSchema>;

/** Something the engine cannot get past on its own. `kind` exists so a
 *  surface can route the operator to the screen that fixes it. */
const digestBlockedLineSchema = z.object({
  kind: z.enum(["throttle", "gate", "adapter", "autopilot_paused", "spend"]),
  detail: z.string(),
});

export type DigestBlockedLine = z.infer<typeof digestBlockedLineSchema>;

/** payloadJson. `awaiting.total` is the full count while `top` is the five
 *  the card shows — a digest that silently truncated to five would understate
 *  a queue of forty. */
export const digestPayloadSchema = z.object({
  forDate: z.string(),
  headline: z.string(),
  awaiting: z.object({
    total: z.number(),
    top: z.array(digestProposalLineSchema),
  }),
  shipped: z.array(digestShippedLineSchema),
  measured: z.array(digestMeasuredLineSchema),
  blocked: z.array(digestBlockedLineSchema),
});

export type DigestPayload = z.infer<typeof digestPayloadSchema>;

/**
 * deliveredJson: one entry per channel the digest went out on.
 *
 * `in_app` is always present at `stored` — the row itself is that delivery,
 * and recording it is what makes an empty list mean "the delivery pass never
 * ran" instead of "nothing was configured". A channel the project opted into
 * but the deployment cannot serve records `failed` with the reason rather
 * than vanishing: a digest email that never arrives should be answerable from
 * the card, not from the logs.
 */
const digestDeliverySchema = z.object({
  channel: z.enum(["in_app", "email", "webhook"]),
  status: z.enum(["stored", "sent", "failed"]),
  at: z.string(),
  error: z.string().nullable(),
});

export type DigestDelivery = z.infer<typeof digestDeliverySchema>;

export const digestDeliveriesSchema = z.array(digestDeliverySchema);

// ---------------------------------------------------------------------------
// API / UI types
// ---------------------------------------------------------------------------

/** A digest row with its payload parsed. Rows whose payload no longer parses
 *  are dropped by the service rather than rendered half-empty. */
export type RankloopDigestListItem = {
  id: string;
  forDate: string;
  createdAt: string;
  payload: DigestPayload;
  deliveries: DigestDelivery[];
};

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

export const getRankloopDigestsSchema = z.object({
  projectId: z.string().uuid(),
});

export const getRankloopAutopilotStatusSchema = z.object({
  projectId: z.string().uuid(),
});

export const resumeRankloopAutopilotSchema = z.object({
  projectId: z.string().uuid(),
});

// An http(s) address, not just any string zod would call a URL — `mailto:`
// and `file:` both pass `.url()`, and neither is somewhere a digest can be
// POSTed. Same rule the publish endpoint's URL uses (rankloopPublish.ts);
// stated again rather than shared because these schema files are read one at
// a time and a receiver has to be able to see what its URL must look like.
const digestWebhookUrl = z
  .string()
  .url()
  .max(2000)
  .refine(
    (value) => value.startsWith("https://") || value.startsWith("http://"),
    "The address must start with http:// or https://",
  );

/** Both channels in one save, and both nullable-or-off rather than optional:
 *  the form always sends its whole state, so an absent field would mean
 *  "unchanged" on one screen and "turn it off" on another. */
export const saveRankloopDigestDeliverySchema = z.object({
  projectId: z.string().uuid(),
  digestEmail: z.boolean(),
  digestWebhookUrl: digestWebhookUrl.nullable(),
});
