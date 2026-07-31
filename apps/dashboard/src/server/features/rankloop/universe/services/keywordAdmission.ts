import { classify, relevant, score } from "@rankloop/engine";
import type { EngineConfig } from "@rankloop/engine";
import {
  IMPRESSIONS_28_NOTE_KEY,
  mergeNotes,
} from "@/server/features/rankloop/universe/notes.logic";
import { UniverseRepository } from "@/server/features/rankloop/universe/repositories/UniverseRepository";
import type {
  BacklogSource,
  BacklogUpsert,
} from "@/server/features/rankloop/universe/repositories/UniverseRepository";
import { RelevanceGateService } from "@/server/features/rankloop/universe/services/RelevanceGateService";

// The one road into keyword_backlog. Every source — the free GSC flywheel,
// the metered competitor gap, autocomplete, harvested questions, a keyword
// somebody typed — hands its candidates to this module and nothing else
// writes the table. That is what makes "no source can write a row that fails
// the gate" true by construction rather than by five sources each remembering
// to call relevant() first.

/** What a source produces: the keyword and whatever facts it happens to
 *  know. Everything optional is genuinely optional — a harvested question
 *  arrives with a keyword and nothing else, and that is a complete
 *  candidate. */
export type UniverseCandidate = {
  keyword: string;
  source: BacklogSource;
  /** The row this candidate was expanded from, for the metered sources. */
  seed?: string | null;
  searchVolume?: number | null;
  keywordDifficulty?: number | null;
  intent?: string | null;
  /** 28-day Search Console impressions, on candidates the project's own
   *  memory proved. Drives the volume imputation below and is stored for the
   *  page planner to impute demand from later. */
  impressions28?: number | null;
  clusterKey?: string | null;
  /** Source-specific facts for notesJson: the competitor and position behind
   *  a gap row, the phrasings behind a clustered GSC row, the pool flag on a
   *  harvested question. */
  notes?: Record<string, unknown>;
};

export type AdmissionResult = {
  /** Candidates the sources returned, gate rejects included. Half of the
   *  run's honesty: "1,284 candidates seen · 312 passed your gate". */
  seen: number;
  kept: number;
};

/**
 * Search Console impressions beat a vendor zero.
 *
 * A query the site already earns 400 impressions a month for has demand that
 * has been observed, not estimated; the keyword tools routinely price exactly
 * those long-tail queries at 0 or null because they are below the tools' own
 * reporting floor. Scoring off `max(volume, impr28)` stops proven demand from
 * sorting below a keyword a vendor guessed at.
 *
 * Note what this does NOT do: it never writes the imputed number into
 * search_volume. That column means "what the vendor priced", the table shows
 * an honest "—" when nobody did, and the planner does the same max() again
 * from the stored impr28. Faking the column would make the two disagree about
 * where the number came from.
 */
export function imputeVolume(
  searchVolume: number | null,
  impressions28: number | null,
): number | null {
  if (impressions28 === null) return searchVolume;
  return Math.max(searchVolume ?? 0, impressions28);
}

/** Keywords are matched, deduped and stored by exact string against the
 *  (project_id, keyword) unique, so a stray capital or a double space would
 *  buy a second row for the same keyword. */
function normalizeKeyword(keyword: string): string {
  return keyword.trim().replaceAll(/\s+/g, " ").toLowerCase();
}

/**
 * Gate, classify and score a batch of candidates into rows ready to upsert.
 *
 * Pure, so the invariant every source depends on can be tested without a
 * database: rejects are counted and dropped, never stored, and the seen/kept
 * pair reconciles against what came in. Duplicates inside one batch count as
 * seen once each and are kept once — two sources finding the same keyword in
 * one run is normal, and letting both through would make the batch's own
 * upserts race each other for the same conflict target.
 */
export function admitCandidates(input: {
  candidates: UniverseCandidate[];
  config: EngineConfig;
  /** keyword → the row's current notesJson. Merged into rather than replaced
   *  so a second source's facts never erase the first's evidence. */
  existingNotes: Map<string, string | null>;
}): { seen: number; rows: BacklogUpsert[] } {
  const rows: BacklogUpsert[] = [];
  const admitted = new Set<string>();
  let seen = 0;

  for (const candidate of input.candidates) {
    const keyword = normalizeKeyword(candidate.keyword);
    // A parser that returned an empty string never produced a candidate;
    // counting it as seen would inflate the rejection rate with its own bug.
    if (keyword === "") continue;
    seen++;
    if (admitted.has(keyword)) continue;
    if (!relevant(input.config, keyword)) continue;

    const [category, format] = classify(input.config, keyword);
    const impressions28 = candidate.impressions28 ?? null;
    const searchVolume = candidate.searchVolume ?? null;
    const keywordDifficulty = candidate.keywordDifficulty ?? null;
    const intent = candidate.intent ?? null;

    rows.push({
      keyword,
      source: candidate.source,
      seed: candidate.seed ?? null,
      category,
      format,
      searchVolume,
      keywordDifficulty,
      intent,
      score: score(
        imputeVolume(searchVolume, impressions28),
        keywordDifficulty,
        intent,
      ),
      clusterKey: candidate.clusterKey ?? null,
      notesJson: mergeNotes(input.existingNotes.get(keyword) ?? null, {
        ...candidate.notes,
        ...(impressions28 === null
          ? {}
          : { [IMPRESSIONS_28_NOTE_KEY]: impressions28 }),
      }),
    });
    admitted.add(keyword);
  }

  return { seen, rows };
}

/**
 * Admit a source's candidates and write what survives.
 *
 * The gate config is loaded per call rather than threaded through the
 * workflow: a run's steps are separate invocations, and re-reading one small
 * row is cheaper than making every source carry a config it must not modify.
 * A project with no gate — archived mid-run — admits nothing rather than
 * falling back to an open gate.
 */
export async function admitAndStore(input: {
  projectId: string;
  candidates: UniverseCandidate[];
}): Promise<AdmissionResult> {
  const config = await RelevanceGateService.loadEngineConfig(input.projectId);
  if (!config) return { seen: input.candidates.length, kept: 0 };

  const existing = await UniverseRepository.getBacklogKeywordNotes(
    input.projectId,
  );
  const { seen, rows } = admitCandidates({
    candidates: input.candidates,
    config,
    existingNotes: new Map(existing.map((row) => [row.keyword, row.notesJson])),
  });

  await UniverseRepository.upsertBacklogRows(input.projectId, rows);
  return { seen, kept: rows.length };
}
