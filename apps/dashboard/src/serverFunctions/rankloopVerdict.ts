import { createServerFn } from "@tanstack/react-start";
import { waitUntil } from "cloudflare:workers";
import { AiAccessService } from "@/server/features/rankloop/verdict/services/AiAccessService";
import { captureServerEvent } from "@/server/lib/posthog";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  getRankloopAiAccessSchema,
  runRankloopAiAccessSchema,
} from "@/types/schemas/rankloopVerdict";

// The AI access card. Both endpoints are free: the probe talks only to the
// user's own site, and nothing here touches a metered API.

export const getRankloopAiAccess = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getRankloopAiAccessSchema)
  .handler(async ({ context }) => {
    return AiAccessService.getCard(context.projectId);
  });

export const runRankloopAiAccess = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(runRankloopAiAccessSchema)
  .handler(async ({ context }) => {
    const card = await AiAccessService.runProbe(context.projectId);

    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        organizationId: context.organizationId,
        event: "rankloop_ai_access:probe",
        properties: {
          projectId: context.projectId,
          reachable: card.reachable,
          blockedAgents: card.agents.filter((a) => !a.allowed).length,
          findings: card.findings.length,
        },
      }),
    );

    return card;
  });
