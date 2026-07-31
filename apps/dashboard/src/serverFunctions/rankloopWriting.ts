import { createServerFn } from "@tanstack/react-start";
import { waitUntil } from "cloudflare:workers";
import { WriterSettingsRepository } from "@/server/features/rankloop/writing/repositories/WriterSettingsRepository";
import { BriefService } from "@/server/features/rankloop/writing/services/BriefService";
import { NetNewProposalsService } from "@/server/features/rankloop/writing/services/NetNewProposalsService";
import { captureServerEvent } from "@/server/lib/posthog";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  getRankloopBriefCostSchema,
  getRankloopBriefSchema,
  getRankloopWriterSettingsSchema,
  getRankloopWritingQuotaSchema,
  proposeRankloopNetNewSchema,
  saveRankloopWriterSettingsSchema,
} from "@/types/schemas/rankloopWriting";

// Nothing in this file calls a model. Selection is the engine's quota and
// pool-mix arithmetic over stored rows, and the brief is assembled from stored
// rows and rendered by @rankloop/engine; generation is S7b's job, against the
// documents these endpoints return.

// Read-only: the quota line renders on every visit to the Articles screen, so
// it must never create a proposal as a side effect of being looked at.
export const getRankloopWritingQuota = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getRankloopWritingQuotaSchema)
  .handler(async ({ context }) => {
    return NetNewProposalsService.getWritingQuota(context.projectId);
  });

// The manual trigger; the routine path is the daily scheduled block. Both
// funnel into the same computeNetNewProposals, whose slot arithmetic
// subtracts what is already in flight — so mashing the button can't
// duplicate the queue.
export const proposeRankloopNetNew = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(proposeRankloopNetNewSchema)
  .handler(async ({ context }) => {
    const result = await NetNewProposalsService.computeNetNewProposals(
      context.projectId,
    );
    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "rankloop_writing:propose_net_new",
        organizationId: context.organizationId,
        properties: {
          project_id: context.projectId,
          created: result.created,
          owed: result.owed,
          outstanding: result.outstanding,
        },
      }),
    );
    return result;
  });

// Null means "never saved" — the form falls back to the same defaults the
// columns carry, rather than this endpoint inserting a row because somebody
// opened the Collapsible.
export const getRankloopWriterSettings = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getRankloopWriterSettingsSchema)
  .handler(async ({ context }) => {
    return WriterSettingsRepository.getSettings(context.projectId);
  });

export const saveRankloopWriterSettings = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(saveRankloopWriterSettingsSchema)
  .handler(async ({ context, data }) => {
    await WriterSettingsRepository.upsertSettings({
      projectId: context.projectId,
      postsPerDay: data.postsPerDay,
      catchupCap: data.catchupCap,
      quotaStartDate: data.quotaStartDate,
      voiceCardMd: data.voiceCardMd,
      trustDial: data.trustDial,
    });
    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "rankloop_writing:settings_save",
        organizationId: context.organizationId,
        properties: {
          project_id: context.projectId,
          posts_per_day: data.postsPerDay,
          catchup_cap: data.catchupCap,
          quota_on: data.quotaStartDate !== null,
          trust_dial: data.trustDial,
        },
      }),
    );
    return { saved: true };
  });

// Read-only, and the drawer's first call: it answers "does this brief need a
// SERP, and what would that SERP cost" so the button can say so before it
// spends anything.
export const getRankloopBriefCost = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getRankloopBriefCostSchema)
  .handler(async ({ context, data }) => {
    return BriefService.getBriefCost({
      projectId: context.projectId,
      proposalId: data.proposalId,
    });
  });

export const getRankloopBrief = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getRankloopBriefSchema)
  .handler(async ({ context, data }) => {
    const result = await BriefService.buildBrief({
      projectId: context.projectId,
      proposalId: data.proposalId,
      billingCustomer: {
        userId: context.userId,
        userEmail: context.userEmail,
        organizationId: context.organizationId,
        projectId: context.projectId,
      },
      allowSerpFetch: data.allowSerpFetch,
    });

    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "rankloop_writing:brief_view",
        organizationId: context.organizationId,
        properties: {
          project_id: context.projectId,
          serp_source: result.serpSource,
          cost_usd: result.costUsd,
        },
      }),
    );
    return result;
  });
