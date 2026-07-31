import { z } from "zod";
import { writerSettings } from "@/db/schema";
import { MAX_CATCHUP_CAP, MAX_POSTS_PER_DAY } from "@/shared/rankloop-writing";

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

/** What opening the brief drawer would cost. Read-only — it never fetches, so
 *  the UI can state the price before the user commits to it. */
export const getRankloopBriefCostSchema = z.object({
  projectId: z.string().uuid(),
  proposalId: z.string().uuid(),
});

/**
 * Assemble the brief. `allowSerpFetch` is the user's answer to the price the
 * cost endpoint quoted: false renders from cached grounding only, true lets
 * the one live SERP happen. Defaulting it to false is deliberate — a client
 * that forgets the field spends nothing.
 */
export const getRankloopBriefSchema = z.object({
  projectId: z.string().uuid(),
  proposalId: z.string().uuid(),
  allowSerpFetch: z.boolean().default(false),
});

/** The quota line's read. Computes nothing that writes — the header renders on
 *  every visit and must never create a proposal as a side effect of looking. */
export const getRankloopWritingQuotaSchema = z.object({
  projectId: z.string().uuid(),
});

export const proposeRankloopNetNewSchema = z.object({
  projectId: z.string().uuid(),
});

export const getRankloopWriterSettingsSchema = z.object({
  projectId: z.string().uuid(),
});

/**
 * The writer dials. `quotaStartDate` is a bare YYYY-MM-DD because that is what
 * the engine's quota parses — a full timestamp would silently fail to parse
 * and read as "quota off", which is the one failure mode a date field must
 * not have. Null is the explicit off switch and is spelled that way.
 */
export const saveRankloopWriterSettingsSchema = z.object({
  projectId: z.string().uuid(),
  postsPerDay: z.number().int().min(0).max(MAX_POSTS_PER_DAY),
  catchupCap: z.number().int().min(0).max(MAX_CATCHUP_CAP),
  quotaStartDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date")
    .nullable(),
  voiceCardMd: z.string().max(4000).nullable(),
  trustDial: z.enum(writerSettings.trustDial.enumValues),
});
