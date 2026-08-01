import { competitorsBlock } from "@/server/features/rankloop/competitors/services/scheduledCompetitorStudies";
import { gscSyncBlock } from "@/server/features/rankloop/gsc-sync/services/scheduledGscSyncs";
import { indexationBlock } from "@/server/features/rankloop/indexation/services/scheduledIndexationChecks";
import { receiptsBlock } from "@/server/features/rankloop/receipts/services/scheduledReceiptMeasurements";
import { siteStudyBlock } from "@/server/features/rankloop/site-study/services/scheduledSiteStudies";
import { universeBlock } from "@/server/features/rankloop/universe/services/scheduledKeywordUniverse";
import { netNewBlock } from "@/server/features/rankloop/writing/services/scheduledNetNewProposals";
import { digestBlock } from "@/server/features/rankloop/routines/services/scheduledDigests";
import { autopilotBlock } from "@/server/features/rankloop/routines/autopilotBlock";
import type { RoutineBlock } from "@/server/features/rankloop/routines/routineBlock";

/**
 * The routine, in order. Order is a real dependency chain, not a list: memory
 * lands before anything reads it, receipts measure before the blocks that
 * spend money queue crawls in front of them, and net-new proposes last so it
 * selects from the backlog the universe block just refilled, and the digest
 * reports on everything above it. Autopilot is terminal: it is the only block
 * that acts unattended, and it goes after every producer so it decides on the
 * freshest state the routine can give it. Each block's own comment carries the
 * reason it sits where it sits.
 *
 * One array, both dispatchers. Adding a block here adds it to the cron sweep
 * and to the Durable Object alarm at the same time, which is the whole point
 * of the indirection.
 */
export const ROUTINE_BLOCKS: readonly RoutineBlock[] = [
  gscSyncBlock,
  siteStudyBlock,
  receiptsBlock,
  indexationBlock,
  competitorsBlock,
  universeBlock,
  netNewBlock,
  digestBlock,
  autopilotBlock,
];
