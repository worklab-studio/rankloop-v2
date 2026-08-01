import { DigestRepository } from "@/server/features/rankloop/routines/repositories/DigestRepository";
import { DigestService } from "@/server/features/rankloop/routines/services/DigestService";
import type { RoutineBlock } from "@/server/features/rankloop/routines/routineBlock";

// The digest is the cheapest block to run and the most expensive one to run
// twice, so the cap is generous: a dispatch that finds fifty projects owed a
// digest writes fifty small rows, and every one of them is a morning somebody
// would otherwise have had to reconstruct from four screens.
const MAX_DIGESTS_PER_TICK = 50;

/**
 * Projects with no digest for today.
 *
 * "Once a day" is enforced by the row's own unique, not by a clock: the first
 * dispatch of the calendar day writes it and every later dispatch finds the
 * project not due. That is what makes the answer identical whether the day's
 * first dispatch came from the Cloudflare cron or from a self-host's alarm —
 * neither one gets to be "the morning run".
 */
async function dueProjects(now: Date, projectId?: string) {
  const rows = await DigestRepository.getProjectsWithoutDigest({
    forDate: now.toISOString().slice(0, 10),
    limit: projectId ? 1 : MAX_DIGESTS_PER_TICK,
    projectId,
  });
  return rows.map((row) => row.projectId);
}

async function runForProject(projectId: string, now: Date) {
  const payload = await DigestService.generateDigest({ projectId, now });
  // A quiet day writes nothing, so the project stays "due" and every later
  // dispatch re-asks — which is the behavior we want: news that arrives at
  // four in the afternoon still gets a digest that day. The log line is the
  // one place that distinguishes "no digest yet" from "no digest ever".
  if (!payload) return;
  console.log(`[routines] Digest for ${projectId}: ${payload.headline}`);
}

/** Last, and deliberately so: the digest reports on the run it closes, so
 *  every block above it has already had its turn at the day's news. */
export const digestBlock: RoutineBlock = {
  name: "digest",
  dueProjects,
  runForProject,
};
