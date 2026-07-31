import { SelectionRepository } from "@/server/features/rankloop/writing/repositories/SelectionRepository";
import { WriterSettingsRepository } from "@/server/features/rankloop/writing/repositories/WriterSettingsRepository";
import { NetNewProposalsService } from "@/server/features/rankloop/writing/services/NetNewProposalsService";
import { dueProjectsForNetNew } from "@/server/features/rankloop/writing/selection";

// Nothing here fetches, crawls or writes an article — a compute is a handful
// of reads and at most catchupCap inserts — so the per-tick cap is generous
// next to the sync blocks'. 20 projects a tick clears any real backlog inside
// one 15-minute window.
const MAX_NET_NEW_COMPUTES_PER_TICK = 20;

// Daily, minus a margin. The quota accrues per calendar day, so a strict 24h
// gap would let the run drift an hour later each day until it crossed
// midnight and skipped one entirely; 20 hours keeps it anchored inside the
// day it is paying for. Running twice is harmless anyway — the slot
// arithmetic subtracts what is already in flight.
const NET_NEW_DUE_AFTER_HOURS = 20;

/**
 * Cron body for the `scheduled` Worker handler: pay down today's quota for
 * every project whose quota is on. Wrapped in `withPgClient` at the
 * entrypoint (server.ts). Runs after the universe block so a tick that has
 * just refilled a backlog proposes against the rows it found rather than
 * against yesterday's.
 *
 * Projects with the quota off are never computed here — a null start date is
 * the user saying "I'll choose what gets written", and a schedule that
 * proposed anyway would be arguing with them once a day.
 */
export async function runScheduledNetNewProposals() {
  const [settings, stats] = await Promise.all([
    WriterSettingsRepository.getAllSettings(),
    SelectionRepository.getNetNewProjectStats(),
  ]);
  const due = dueProjectsForNetNew({
    settings,
    stats,
    cutoff: new Date(
      Date.now() - NET_NEW_DUE_AFTER_HOURS * 60 * 60 * 1000,
    ).toISOString(),
    limit: MAX_NET_NEW_COMPUTES_PER_TICK,
  });

  for (const projectId of due) {
    try {
      const result =
        await NetNewProposalsService.computeNetNewProposals(projectId);
      if (result.created === 0) {
        // The reason is the point: a run that owed nothing and a run that
        // found nothing to write about look identical from the outside.
        console.log(
          `[cron] No net-new proposals for ${projectId} — ${result.reason ?? "nothing to select"}`,
        );
      } else {
        console.log(
          `[cron] Created ${result.created} net-new proposal(s) for ${projectId}`,
        );
      }
    } catch (err) {
      console.error(
        `[cron] Error computing net-new proposals for ${projectId}:`,
        err,
      );
    }
  }
}
