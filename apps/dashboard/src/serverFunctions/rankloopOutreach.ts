import { createServerFn } from "@tanstack/react-start";
import { waitUntil } from "cloudflare:workers";
import { OutreachService } from "@/server/features/rankloop/outreach/services/OutreachService";
import { captureServerEvent } from "@/server/lib/posthog";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  getRankloopOutreachSchema,
  recomputeRankloopOutreachSchema,
  saveRankloopOutreachDraftSchema,
  updateRankloopOutreachStatusSchema,
} from "@/types/schemas/rankloopOutreach";

// Every endpoint in this file reads, computes or stores text. None of them
// sends anything, and there is no address to send to — outreach_targets has
// no email column and nothing here writes contactUrl.

export const getRankloopOutreach = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getRankloopOutreachSchema)
  .handler(async ({ context }) => {
    return OutreachService.getOutreach(context.projectId);
  });

// The same recompute the competitor study runs at the end of every study,
// on the user's own clock. Metered only through the backlinks read it needs,
// which is cached for six hours — a second click inside that window costs
// nothing.
export const recomputeRankloopOutreach = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(recomputeRankloopOutreachSchema)
  .handler(async ({ context }) => {
    const result = await OutreachService.recomputeTargets({
      projectId: context.projectId,
      billingCustomer: {
        userId: context.userId,
        userEmail: context.userEmail,
        organizationId: context.organizationId,
        projectId: context.projectId,
      },
    });

    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "rankloop_outreach:recompute",
        organizationId: context.organizationId,
        properties: {
          project_id: context.projectId,
          targets: result.targets,
        },
      }),
    );
    return result;
  });

export const updateRankloopOutreachStatus = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(updateRankloopOutreachStatusSchema)
  .handler(async ({ context, data }) => {
    await OutreachService.updateStatus({
      projectId: context.projectId,
      targetId: data.targetId,
      status: data.status,
    });

    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "rankloop_outreach:status",
        organizationId: context.organizationId,
        properties: { project_id: context.projectId, status: data.status },
      }),
    );
    return { status: data.status };
  });

export const saveRankloopOutreachDraft = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(saveRankloopOutreachDraftSchema)
  .handler(async ({ context, data }) => {
    await OutreachService.saveDraft({
      projectId: context.projectId,
      targetId: data.targetId,
      draftMessage: data.draftMessage,
    });

    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "rankloop_outreach:draft_save",
        organizationId: context.organizationId,
        properties: { project_id: context.projectId },
      }),
    );
    return { saved: true };
  });
