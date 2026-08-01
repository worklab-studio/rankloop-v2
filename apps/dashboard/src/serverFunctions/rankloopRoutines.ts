import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { AutopilotService } from "@/server/features/rankloop/routines/services/AutopilotService";
import { DigestService } from "@/server/features/rankloop/routines/services/DigestService";
import { getRoutineDispatchStatus } from "@/server/features/rankloop/routines/services/routineDispatch";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  getRankloopAutopilotStatusSchema,
  getRankloopDigestsSchema,
} from "@/types/schemas/rankloopRoutines";

const projectScopedSchema = z.object({ projectId: z.string().uuid() });

/**
 * Which mechanism is honouring the schedule on THIS deployment, and when the
 * next run is due.
 *
 * Read before the Automation surface renders anything about the routine: the
 * 15-minute cron only fires on real Cloudflare, so a Docker or local install
 * runs on the per-project Durable Object alarm instead — and a screen that
 * showed a schedule without naming who honours it is exactly the silence this
 * endpoint exists to break. Both mechanisms call the same
 * `runProjectRoutines`, so neither answer is worse news than the other.
 */
export const getRankloopDispatcher = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) =>
    getRoutineDispatchStatus(env, context.projectId),
  );

/**
 * The last week of digests, newest first.
 *
 * Read-only, and deliberately so: the digest is written by the morning
 * routine, never by a page load. A screen that could generate one on demand
 * would let a refresh manufacture the morning's news out of the afternoon's
 * data, and the whole claim of the card is that it shows what the operator
 * was told when it happened. Days with nothing on them have no row, so the
 * gaps in the list are real quiet, not a failed read.
 */
export const getRankloopDigests = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getRankloopDigestsSchema)
  .handler(async ({ context }) =>
    DigestService.getRecentDigests(context.projectId),
  );

/**
 * What the trust dial means for this project today, per action type, plus the
 * kill switch.
 *
 * `now` comes from the server rather than the browser: eligibility is a
 * function of how long ago a receipt's window settled, and a clock the client
 * could set is a clock that could age a cohort into eligibility.
 */
export const getRankloopAutopilotStatus = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getRankloopAutopilotStatusSchema)
  .handler(async ({ context }) =>
    AutopilotService.getStatus({
      projectId: context.projectId,
      now: new Date(),
    }),
  );
