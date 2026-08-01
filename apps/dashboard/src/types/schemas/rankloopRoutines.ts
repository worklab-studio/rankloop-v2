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

/** deliveredJson: one entry per channel that was attempted. In-app delivery
 *  never appears here — the row itself is the in-app delivery. */
const digestDeliverySchema = z.object({
  channel: z.enum(["email", "webhook"]),
  status: z.enum(["sent", "failed"]),
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
