// The daily digest, wired to storage (spec 0024). `digest.logic.ts` decides
// what the day's news is and whether there is any; this file gathers the rows
// and writes the one that came back.
//
// The clock is a parameter for the same reason it is one on AutopilotService:
// the cron and the DO alarm both call the morning routine, and two halves of
// one run reading their own clocks could straddle midnight and report on two
// different yesterdays.

import type { z } from "zod";
import { IndexationService } from "@/server/features/rankloop/indexation/services/IndexationService";
import { ProposalsService } from "@/server/features/rankloop/proposals/services/ProposalsService";
import { shiftDate } from "@/server/features/rankloop/receipts/receipts.logic";
import {
  assembleDigest,
  type AwaitingProposal,
  type MeasuredReceipt,
} from "@/server/features/rankloop/routines/digest.logic";
import { DigestRepository } from "@/server/features/rankloop/routines/repositories/DigestRepository";
import { AutopilotService } from "@/server/features/rankloop/routines/services/AutopilotService";
import type {
  DigestPayload,
  DigestShippedLine,
  RankloopDigestListItem,
} from "@/types/schemas/rankloopRoutines";
import {
  digestDeliveriesSchema,
  digestPayloadSchema,
} from "@/types/schemas/rankloopRoutines";
import {
  receiptBaselineSchema,
  receiptResultSchema,
} from "@/types/schemas/rankloopReceipts";
import { parseLawReport } from "@/types/schemas/rankloopWriter";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The Dashboard card's window. Seven is a week of mornings — long enough to
 *  notice a pattern, short enough that scrolling is never the answer. */
const DIGEST_HISTORY_DAYS = 7;

// ---------------------------------------------------------------------------
// Parsing what is stored
// ---------------------------------------------------------------------------

/** A stored JSON column read back, or null when it is empty or no longer
 *  matches its shape. Every parse in this file degrades to null rather than
 *  throwing: one unreadable row must cost its own line, never the digest. */
function parseJson<T>(schema: z.ZodType<T>, raw: string | null): T | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const validated = schema.safeParse(parsed);
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Assembling the day
// ---------------------------------------------------------------------------

/** The proposal queue as the digest reads it: undecided rows with the
 *  evidence already parsed, which is what ProposalsService.getProposals
 *  returns — re-parsing the same JSON column here would fork the two views of
 *  what a proposal's evidence is. */
function toAwaiting(
  rows: Awaited<ReturnType<typeof ProposalsService.getProposals>>,
): AwaitingProposal[] {
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    target: row.target,
    title: row.title,
    score: row.score,
    createdAt: row.createdAt,
    evidence: row.evidence,
  }));
}

/** An article's own title, falling back to the keyword it was written for —
 *  a draft that failed before its frontmatter parsed has no title, and
 *  "(untitled)" tells the reader nothing about which one it was. */
function articleLabel(row: { title: string | null; keyword: string }): string {
  return row.title ?? row.keyword;
}

function toShipped(
  rows: Awaited<ReturnType<typeof DigestRepository.getShippedBetween>>,
): DigestShippedLine[] {
  return rows.map((row) => ({
    articleId: row.articleId,
    title: articleLabel(row),
    url: row.url,
  }));
}

function toMeasured(
  rows: Awaited<ReturnType<typeof DigestRepository.getMeasuredBetween>>,
): MeasuredReceipt[] {
  return rows.map((row) => {
    const baseline = parseJson(receiptBaselineSchema, row.baselineJson);
    const result = parseJson(receiptResultSchema, row.resultJson);
    return {
      receiptId: row.receiptId,
      actionType: row.actionType,
      // The page's current path when the manifest row still exists, else the
      // pinned target query — a receipt outlives its page.
      target: row.pagePath ?? row.targetQuery ?? "(page removed)",
      baselineClicks: baseline?.clicks ?? 0,
      adjustedClicksDelta: result?.adjustedClicksDelta ?? null,
      baselinePosition: baseline?.weightedPosition ?? null,
      resultPosition: result?.weightedPosition ?? null,
    };
  });
}

/** The laws a failed draft still has unmet, named. The report stores every
 *  law with its verdict, so the failures are a filter rather than a
 *  separately-stored list that could disagree with the checklist on screen. */
function unmetLaws(lawReportJson: string | null): string[] {
  const report = parseLawReport(lawReportJson);
  if (!report) return [];
  return report.laws.filter((law) => !law.passed).map((law) => law.law);
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Build and store the project's digest for the morning of `now`.
 *
 * Returns null on a quiet day, and stores nothing — see the header of
 * digest.logic.ts for why silence is the feature and not an omission. Returns
 * the payload without storing it a second time when the day's digest already
 * exists, which is what makes the morning routine safe to re-run.
 */
async function generateDigest(input: {
  projectId: string;
  now: Date;
}): Promise<DigestPayload | null> {
  const forDate = input.now.toISOString().slice(0, 10);
  // "Yesterday" is the whole previous calendar day: the routine runs in the
  // morning, so bounding the window at `now` would drop everything that
  // happened after the previous morning's run and before midnight.
  const fromIso = `${shiftDate(forDate, -1)}T00:00:00.000Z`;
  const toIso = `${forDate}T00:00:00.000Z`;

  const [awaiting, shipped, measured, gateFailures, indexation, autopilot] =
    await Promise.all([
      ProposalsService.getProposals(input.projectId, "proposed"),
      DigestRepository.getShippedBetween({
        projectId: input.projectId,
        fromIso,
        toIso,
      }),
      DigestRepository.getMeasuredBetween({
        projectId: input.projectId,
        fromIso,
        toIso,
      }),
      DigestRepository.getGateFailures(input.projectId),
      IndexationService.getIndexationStatus(input.projectId),
      AutopilotService.getStatus({
        projectId: input.projectId,
        now: input.now,
      }),
    ]);

  const payload = assembleDigest({
    forDate,
    awaiting: toAwaiting(awaiting),
    shipped: toShipped(shipped),
    measured: toMeasured(measured),
    blocked: {
      throttle: indexation.throttle,
      gateFailures: gateFailures.map((row) => ({
        title: articleLabel(row),
        attempts: row.attempts,
        failedLaws: unmetLaws(row.lawReportJson),
      })),
      adapterErrors: autopilot.adapterError ? [autopilot.adapterError] : [],
      autopilotPause: autopilot.pause,
      // No per-project spend ceiling exists yet, and a budget the user never
      // set is not a ceiling — it is a number we made up to have something to
      // warn about. The logic already carries the threshold and the line, so
      // the day a ceiling is configurable this becomes one read.
      spend: null,
    },
  });
  if (!payload) return null;

  await DigestRepository.insertDigest({
    projectId: input.projectId,
    forDate,
    payloadJson: JSON.stringify(payload),
  });
  return payload;
}

// ---------------------------------------------------------------------------
// Reading them back
// ---------------------------------------------------------------------------

/** The last week of digests, newest first. A row whose payload no longer
 *  parses is dropped rather than rendered half-empty: the card's whole claim
 *  is that it shows what the operator was told that morning. */
async function getRecentDigests(
  projectId: string,
): Promise<RankloopDigestListItem[]> {
  const rows = await DigestRepository.getRecentDigests(
    projectId,
    DIGEST_HISTORY_DAYS,
  );
  const items: RankloopDigestListItem[] = [];
  for (const row of rows) {
    const payload = parseJson(digestPayloadSchema, row.payloadJson);
    if (!payload) continue;
    items.push({
      id: row.id,
      forDate: row.forDate,
      createdAt: row.createdAt,
      payload,
      deliveries: parseJson(digestDeliveriesSchema, row.deliveredJson) ?? [],
    });
  }
  return items;
}

export const DigestService = {
  generateDigest,
  getRecentDigests,
};
