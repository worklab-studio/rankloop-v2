import type { RoutineBlock } from "@/server/features/rankloop/routines/routineBlock";
import { SelectionRepository } from "@/server/features/rankloop/writing/repositories/SelectionRepository";
import { WriterSettingsRepository } from "@/server/features/rankloop/writing/repositories/WriterSettingsRepository";
import { NetNewProposalsService } from "@/server/features/rankloop/writing/services/NetNewProposalsService";
import { dueProjectsForNetNew } from "@/server/features/rankloop/writing/selection";

// Nothing here fetches, crawls or writes an article — a compute is a handful
// of reads and at most catchupCap inserts — so the per-dispatch cap is
// generous next to the sync blocks'. 20 projects clears any real backlog
// inside one 15-minute window.
const MAX_NET_NEW_COMPUTES_PER_TICK = 20;

// Daily, minus a margin. The quota accrues per calendar day, so a strict 24h
// gap would let the run drift an hour later each day until it crossed
// midnight and skipped one entirely; 20 hours keeps it anchored inside the
// day it is paying for. Running twice is harmless anyway — the slot
// arithmetic subtracts what is already in flight.
const NET_NEW_DUE_AFTER_HOURS = 20;

/**
 * Projects with the quota off are never due here — a null start date is the
 * user saying "I'll choose what gets written", and a schedule that proposed
 * anyway would be arguing with them once a day.
 */
async function dueProjects(now: Date, projectId?: string) {
  const [settings, stats] = await Promise.all([
    WriterSettingsRepository.getAllSettings(projectId),
    SelectionRepository.getNetNewProjectStats(projectId),
  ]);
  return dueProjectsForNetNew({
    settings,
    stats,
    cutoff: new Date(
      now.getTime() - NET_NEW_DUE_AFTER_HOURS * 60 * 60 * 1000,
    ).toISOString(),
    limit: projectId ? 1 : MAX_NET_NEW_COMPUTES_PER_TICK,
  });
}

async function runForProject(projectId: string) {
  const result = await NetNewProposalsService.computeNetNewProposals(projectId);
  if (result.created === 0) {
    // The reason is the point: a run that owed nothing and a run that found
    // nothing to write about look identical from the outside.
    console.log(
      `[routines] No net-new proposals for ${projectId} — ${result.reason ?? "nothing to select"}`,
    );
    return;
  }
  console.log(
    `[routines] Created ${result.created} net-new proposal(s) for ${projectId}`,
  );
}

/** Pay down today's quota. Ordered after the universe block so a dispatch
 *  that has just refilled a backlog proposes against the rows it found rather
 *  than against yesterday's. */
export const netNewBlock: RoutineBlock = {
  name: "net-new",
  dueProjects,
  runForProject,
};
