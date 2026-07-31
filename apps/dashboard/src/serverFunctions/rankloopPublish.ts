import { createServerFn } from "@tanstack/react-start";
import { waitUntil } from "cloudflare:workers";
import { ExecutionService } from "@/server/features/rankloop/proposals/services/ExecutionService";
import { PublishConnectionService } from "@/server/features/rankloop/publish/services/PublishConnectionService";
import { captureServerEvent } from "@/server/lib/posthog";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  attestProposalSchema,
  executeRetitleProposalSchema,
  getPublishConnectionSchema,
  getPushGuidanceSchema,
  getRetitleContextSchema,
  savePublishConnectionSchema,
  testPublishConnectionSchema,
} from "@/types/schemas/rankloopPublish";

// Credentials cross this file exactly once, inward, on save. Reads return
// the masked shape and analytics properties never include the baseUrl's
// credentials or the password — grep before adding a property here.

export const getRankloopPublishConnection = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getPublishConnectionSchema)
  .handler(async ({ context }) => {
    return PublishConnectionService.getMaskedConnection(context.projectId);
  });

export const saveRankloopPublishConnection = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(savePublishConnectionSchema)
  .handler(async ({ context, data }) => {
    const masked = await PublishConnectionService.saveConnection({
      projectId: context.projectId,
      adapter: data.adapter,
      baseUrl: data.baseUrl,
      username: data.username,
      applicationPassword: data.applicationPassword,
    });
    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "rankloop_publish:connection_save",
        organizationId: context.organizationId,
        properties: { project_id: context.projectId, adapter: masked.adapter },
      }),
    );
    return masked;
  });

export const testRankloopPublishConnection = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(testPublishConnectionSchema)
  .handler(async ({ context }) => {
    const result = await PublishConnectionService.testConnection(
      context.projectId,
    );
    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "rankloop_publish:connection_test",
        organizationId: context.organizationId,
        properties: { project_id: context.projectId, status: result.status },
      }),
    );
    return result;
  });

export const executeRetitleProposal = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(executeRetitleProposalSchema)
  .handler(async ({ context, data }) => {
    const result = await ExecutionService.executeRetitleProposal({
      projectId: context.projectId,
      proposalId: data.proposalId,
      newTitle: data.newTitle,
      newMetaDescription: data.newMetaDescription,
    });
    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "rankloop_publish:retitle_execute",
        organizationId: context.organizationId,
        properties: {
          project_id: context.projectId,
          proposal_id: result.id,
          meta_description_applied: result.metaDescriptionApplied,
        },
      }),
    );
    return result;
  });

export const attestPushProposal = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(attestProposalSchema)
  .handler(async ({ context, data }) => {
    const result = await ExecutionService.attestPushProposal({
      projectId: context.projectId,
      proposalId: data.proposalId,
    });
    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "rankloop_publish:push_attest",
        organizationId: context.organizationId,
        properties: { project_id: context.projectId, proposal_id: result.id },
      }),
    );
    return result;
  });

export const attestRetitleProposal = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(attestProposalSchema)
  .handler(async ({ context, data }) => {
    const result = await ExecutionService.attestRetitleProposal({
      projectId: context.projectId,
      proposalId: data.proposalId,
    });
    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "rankloop_publish:retitle_attest",
        organizationId: context.organizationId,
        properties: { project_id: context.projectId, proposal_id: result.id },
      }),
    );
    return result;
  });

export const getRankloopPushGuidance = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getPushGuidanceSchema)
  .handler(async ({ context, data }) => {
    return ExecutionService.getPushGuidance({
      projectId: context.projectId,
      proposalId: data.proposalId,
    });
  });

export const getRankloopRetitleContext = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getRetitleContextSchema)
  .handler(async ({ context, data }) => {
    return ExecutionService.getRetitleContext({
      projectId: context.projectId,
      proposalId: data.proposalId,
    });
  });
