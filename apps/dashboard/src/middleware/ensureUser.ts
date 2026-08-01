import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env, waitUntil } from "cloudflare:workers";
import { resolveUserContextFromHeaders } from "@/middleware/ensure-user/resolve";
import type { EnsuredProject } from "@/middleware/ensure-user/types";
import { AppError } from "@/server/lib/errors";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { ensureRoutinesArmed } from "@/server/features/rankloop/routines/services/routineDispatch";

function extractProjectId(data: unknown) {
  if (!data || typeof data !== "object" || !("projectId" in data)) {
    return null;
  }

  const projectId = (data as { projectId?: unknown }).projectId;
  return typeof projectId === "string" && projectId.length > 0
    ? projectId
    : null;
}

export const ensureUserMiddleware = createMiddleware({
  type: "function",
}).server(async ({ next, data }) => {
  const context = await resolveUserContextFromHeaders(getRequest().headers);

  const projectId = extractProjectId(data);

  let project: EnsuredProject | undefined;

  if (projectId) {
    // ADR 0001 intentionally keeps project authorization here so every
    // project-scoped server function gets the same request-scoped org+project
    // check before handlers run. Function-level middleware narrows the type.
    project = await ProjectRepository.getProjectForOrganization(
      projectId,
      context.organizationId,
    );

    if (!project) {
      throw new AppError("NOT_FOUND");
    }

    // Re-arm this project's routine alarm if it was lost. Throttled in
    // memory to at most one Durable Object wake per project per half hour per
    // isolate, so the hot path pays nothing — and a self-host whose scheduler
    // storage was wiped repairs itself the next time someone opens the app,
    // instead of going quiet until an operator notices.
    waitUntil(ensureRoutinesArmed(env, project.id));
  }

  return next({
    context: {
      ...context,
      project,
    },
  });
});
