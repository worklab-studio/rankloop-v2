import { UniverseRepository } from "@/server/features/rankloop/universe/repositories/UniverseRepository";
import { read28DayWindow } from "@/server/features/rankloop/universe/services/gscWindow";
import type { UniverseCandidate } from "@/server/features/rankloop/universe/services/keywordAdmission";
import { selectUnservedQueries } from "@/server/features/rankloop/universe/unserved.logic";

// The free source, wired: read the project's own 28-day memory, apply the
// incidental-serving rule, and hand the survivors to the shared admission
// path. Costs nothing, needs no API key, and runs on data the project already
// paid for with its own traffic — which is why it is the source that always
// runs, including on the weekly free block.

/**
 * Candidates from the queries this site earns impressions for and serves
 * only by accident.
 *
 * Everything the rule needs is already in the database, so the whole step is
 * three reads and a pure function. An empty result is the normal answer for a
 * project whose Search Console memory hasn't been synced yet — not an error,
 * and the run reports it as zero seen rather than as a failure.
 */
export async function collectUnservedCandidates(
  projectId: string,
): Promise<UniverseCandidate[]> {
  const [aggregates, servedKeywords, backlog] = await Promise.all([
    read28DayWindow(projectId),
    UniverseRepository.getContentPageKeywords(projectId),
    UniverseRepository.getBacklogKeywordNotes(projectId),
  ]);

  return selectUnservedQueries({
    aggregates,
    servedKeywords,
    existingBacklogKeywords: backlog.map((row) => row.keyword),
  }).map((candidate) => ({
    keyword: candidate.keyword,
    source: "gsc",
    impressions28: candidate.impressions28,
    clusterKey: candidate.clusterKey,
    notes: {
      // The phrasings this one row stands for, and how badly the site
      // currently serves them. Both are the evidence for the row: without
      // them the Keywords tab can only assert that Search Console said so.
      variants: candidate.variants,
      bestPosition: Math.round(candidate.bestPosition * 10) / 10,
    },
  }));
}
