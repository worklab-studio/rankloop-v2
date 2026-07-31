import { createServerFn } from "@tanstack/react-start";
import { waitUntil } from "cloudflare:workers";
import { CompetitorDiscoveryService } from "@/server/features/rankloop/competitors/services/CompetitorDiscoveryService";
import { CompetitorsService } from "@/server/features/rankloop/competitors/services/CompetitorsService";
import { AppError } from "@/server/lib/errors";
import { captureServerEvent } from "@/server/lib/posthog";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  addRankloopCompetitorSchema,
  decideRankloopCompetitorSchema,
  discoverRankloopCompetitorsSchema,
  getRankloopCompetitorSchema,
  getRankloopCompetitorsSchema,
} from "@/types/schemas/rankloopCompetitors";

export const getRankloopCompetitors = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getRankloopCompetitorsSchema)
  .handler(async ({ context }) => {
    return CompetitorsService.getCompetitors(context.projectId);
  });

export const getRankloopCompetitor = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getRankloopCompetitorSchema)
  .handler(async ({ context, data }) => {
    return CompetitorsService.getCompetitor({
      projectId: context.projectId,
      competitorId: data.competitorId,
    });
  });

// The one metered endpoint in this file. Keyless it throws, and the
// Competitors tab renders that as the discovery setup pitch — manual add sits
// above it and keeps working either way.
export const discoverRankloopCompetitors = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(discoverRankloopCompetitorsSchema)
  .handler(async ({ context }) => {
    if (!context.project.domain) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Set your project domain before discovering competitors.",
      );
    }

    const result = await CompetitorDiscoveryService.discoverCompetitors({
      projectId: context.projectId,
      organizationId: context.organizationId,
      domain: context.project.domain,
      locationCode: context.project.locationCode,
      languageCode: context.project.languageCode,
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
        event: "rankloop_competitors:discover",
        organizationId: context.organizationId,
        properties: {
          project_id: context.projectId,
          suggested: result.suggested,
        },
      }),
    );
    return result;
  });

export const addRankloopCompetitor = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(addRankloopCompetitorSchema)
  .handler(async ({ context, data }) => {
    const result = await CompetitorsService.addCompetitor({
      projectId: context.projectId,
      domain: data.domain,
    });

    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "rankloop_competitors:add",
        organizationId: context.organizationId,
        properties: { project_id: context.projectId, source: "manual" },
      }),
    );
    return result;
  });

export const decideRankloopCompetitor = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(decideRankloopCompetitorSchema)
  .handler(async ({ context, data }) => {
    const result = await CompetitorsService.decide({
      projectId: context.projectId,
      competitorId: data.competitorId,
      decision: data.decision,
    });

    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event:
          data.decision === "tracked"
            ? "rankloop_competitors:track"
            : "rankloop_competitors:skip",
        organizationId: context.organizationId,
        properties: { project_id: context.projectId },
      }),
    );
    return result;
  });
