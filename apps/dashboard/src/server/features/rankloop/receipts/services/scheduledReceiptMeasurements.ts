import type { RoutineBlock } from "@/server/features/rankloop/routines/routineBlock";
import { ReceiptsRepository } from "@/server/features/rankloop/receipts/repositories/ReceiptsRepository";
import { isoDay } from "@/server/features/rankloop/receipts/receipts.logic";
import { ReceiptsService } from "@/server/features/rankloop/receipts/services/ReceiptsService";

// Advancing a receipt costs stored reads, not API calls, but a measurement
// resolves a page and two windows — so the block still bounds how many
// projects one dispatch touches. Ten a tick is 960 a day against a due-set
// that is empty on almost every tick.
const MAX_RECEIPT_PROJECTS_PER_TICK = 10;

// Daily-ish work riding the 15-minute cadence: a receipt only becomes due
// twice in its six-week life, and the due-check is one indexed read that
// returns nothing on almost every tick, so no separate daily scheduler is
// worth its moving parts.
async function dueProjects(now: Date, projectId?: string) {
  return ReceiptsRepository.getProjectIdsWithDueReceipts(
    isoDay(now.toISOString()),
    projectId ? 1 : MAX_RECEIPT_PROJECTS_PER_TICK,
    projectId,
  );
}

async function runForProject(projectId: string, now: Date) {
  const result = await ReceiptsService.runMeasurementPass(() => now, projectId);
  const acted =
    result.flipped +
    result.measured +
    result.contaminated +
    result.lagged +
    result.skipped;
  // Quiet dispatches stay quiet — logging "0 receipts" 96 times a day buries
  // the lines that matter.
  if (acted === 0) return;
  console.log(
    `[routines] Receipt measurements for ${projectId}: ${result.flipped} now measuring, ` +
      `${result.measured} measured, ${result.contaminated} contaminated, ` +
      `${result.lagged} waiting on data, ${result.skipped} skipped`,
  );
}

/** Advance due receipts through baseline → measuring → measured/contaminated. */
export const receiptsBlock: RoutineBlock = {
  name: "receipts",
  dueProjects,
  runForProject,
};
