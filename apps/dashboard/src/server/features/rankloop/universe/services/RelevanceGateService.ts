import { z } from "zod";
import type { EngineConfig } from "@rankloop/engine";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { brandTokens } from "@/server/features/rankloop/proposals/signals.logic";
import {
  deriveRelevanceGate,
  toEngineConfig,
} from "@/server/features/rankloop/universe/gate.logic";
import {
  computeKdCeiling,
  FIXED_KD_CEILING,
} from "@/server/features/rankloop/universe/kdCeiling.logic";
import type { KdCeilingResult } from "@/server/features/rankloop/universe/kdCeiling.logic";
import { UniverseRepository } from "@/server/features/rankloop/universe/repositories/UniverseRepository";
import { read28DayWindow } from "@/server/features/rankloop/universe/services/gscWindow";
import {
  INCIDENTAL_POSITION,
  rollUpQueries,
} from "@/server/features/rankloop/universe/unserved.logic";

// The gate row's whole lifecycle: derive it from the project's own evidence,
// hand it to the engine as an EngineConfig, and keep its difficulty ceiling
// current. Every source in the universe step goes through the config this
// service hands out, which is what makes "no source can write a row that
// fails the gate" a structural fact rather than a convention.

const tokenListSchema = z.array(z.string());

/** Stored tokens are written by us and edited through a validated endpoint,
 *  but they are still JSON in a text column — parse defensively and treat
 *  anything unreadable as an empty list rather than throwing a run away. */
function parseTokens(json: string): string[] {
  try {
    const parsed = tokenListSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * Derive the gate from the project's own pages and earned queries, and store
 * it — unless a human has edited this gate, in which case nothing is written.
 *
 * The never-overwrite rule lives in the repository's UPDATE predicate, so the
 * `derived: false` this returns is the database's answer, not a guess made
 * before the write. The Keywords tab disables its Re-derive button on the
 * same flag; this is the half that holds when something else calls it.
 */
async function deriveGate(projectId: string): Promise<{ derived: boolean }> {
  const project = await ProjectRepository.getProjectById(projectId);
  // Archived or deleted mid-run: nothing to derive against, and the caller
  // treats a gate-less project as one that admits nothing.
  if (!project) return { derived: false };

  const [pages, aggregates] = await Promise.all([
    UniverseRepository.getContentPageDocuments(projectId),
    read28DayWindow(projectId),
  ]);
  // One document per distinct query, not per (page, query) pair: a query
  // three pages happen to serve is one piece of evidence about what this site
  // is about, and counting it three times would let a single popular query
  // buy its words a positive slot on its own.
  const queries = [...new Set(aggregates.map((row) => row.query))];

  const gate = deriveRelevanceGate({
    evidence: { pages, queries },
    brandTokens: brandTokens(project.name, project.domain),
  });

  const derived = await UniverseRepository.saveDerivedGate({
    projectId,
    positivesJson: JSON.stringify(gate.positives),
    negativesJson: JSON.stringify(gate.negatives),
    brandTokensJson: JSON.stringify(gate.brandTokens),
  });
  return { derived };
}

// ---------------------------------------------------------------------------
// The config every source writes through
// ---------------------------------------------------------------------------

/**
 * The EngineConfig for this project's gate, deriving one first if the project
 * has never had a gate row.
 *
 * Deriving on first use rather than at project creation is what lets a
 * project's very first universe run gate against evidence that exists by
 * then — a gate derived at signup, before a single page was crawled, would be
 * empty and would stay empty until somebody noticed.
 */
async function loadEngineConfig(
  projectId: string,
): Promise<EngineConfig | null> {
  const project = await ProjectRepository.getProjectById(projectId);
  if (!project) return null;

  let gate = await UniverseRepository.getGate(projectId);
  if (!gate) {
    await deriveGate(projectId);
    gate = await UniverseRepository.getGate(projectId);
  }
  if (!gate) return null;

  return toEngineConfig({
    project,
    positives: parseTokens(gate.positivesJson),
    negatives: parseTokens(gate.negativesJson),
  });
}

// ---------------------------------------------------------------------------
// The adaptive ceiling
// ---------------------------------------------------------------------------

/**
 * Recompute the difficulty ceiling from what the project already ranks for,
 * and store it.
 *
 * Samples are the queries whose best-serving page sits inside the top 10 —
 * the same INCIDENTAL_POSITION line the unserved rule reads from the other
 * side, because "a page already serves this" and "this ranking is something
 * you earned" are the same sentence. Their difficulty comes from the upstream
 * metrics cache; a query nobody has priced contributes no sample, which is
 * why a keyless project keeps the fixed floor.
 */
async function refreshKdCeiling(
  projectId: string,
): Promise<KdCeilingResult | null> {
  const project = await ProjectRepository.getProjectById(projectId);
  if (!project) return null;

  const [gate, aggregates] = await Promise.all([
    UniverseRepository.getGate(projectId),
    read28DayWindow(projectId),
  ]);
  // No gate row yet means no place to store the answer; deriving one here
  // keeps "refresh the ceiling" from being an operation that silently does
  // nothing on a project's first run.
  if (!gate) await deriveGate(projectId);

  const ranked = rollUpQueries(aggregates).filter(
    (rollup) => rollup.bestPosition <= INCIDENTAL_POSITION,
  );
  const difficulties = await UniverseRepository.getKeywordDifficulties({
    projectId,
    locationCode: project.locationCode,
    languageCode: project.languageCode,
  });
  const kdByKeyword = new Map(
    difficulties.map((row) => [row.keyword, row.keywordDifficulty]),
  );

  const result = computeKdCeiling({
    rankedTop10WithKd: ranked.map((rollup) => ({
      keyword: rollup.query,
      keywordDifficulty: kdByKeyword.get(rollup.query) ?? null,
    })),
    brandTokens: brandTokens(project.name, project.domain),
    previousCeiling: gate?.kdCeiling ?? FIXED_KD_CEILING,
  });

  await UniverseRepository.updateKdCeiling({
    projectId,
    kdCeiling: result.ceiling,
    kdCeilingUpdatedAt: result.earned ? new Date().toISOString() : null,
  });
  return result;
}

export const RelevanceGateService = {
  deriveGate,
  loadEngineConfig,
  refreshKdCeiling,
};
