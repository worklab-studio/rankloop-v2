import {
  POSITIVE_TOKEN_CAP,
  topicTokens,
} from "@/server/features/rankloop/universe/gate.logic";
import { CurationRepository } from "@/server/features/rankloop/universe/repositories/CurationRepository";
import { UniverseRepository } from "@/server/features/rankloop/universe/repositories/UniverseRepository";
import { AppError } from "@/server/lib/errors";
import type { GateCard } from "@/types/schemas/rankloopUniverse";

// What a person does to the universe by hand: read the gate that decides what
// counts as on-topic here, edit it, and skip backlog rows that are somebody
// else's keywords. The run path never calls anything in this file — that
// separation is the never-overwrite rule expressed as code layout.

/** Stored token lists are JSON in a text column. Anything unreadable becomes
 *  an empty list rather than a 500: a gate the UI can't parse is one the user
 *  needs to re-derive, and they can only do that if the card renders. */
function parseTokens(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

/**
 * The gate as the card shows it: tokens, the counts that admitted them, the
 * ceiling and the flags that decide what the card lets you do.
 *
 * Counts are recomputed from the project's own pages on read rather than
 * stored beside the tokens. The derivation stores literals only, and a count
 * frozen at derivation time would drift every time a page is published — a
 * chip reading "41 pages" has to mean 41 pages now, or it is decoration.
 */
async function getGateCard(projectId: string): Promise<GateCard | null> {
  const gate = await UniverseRepository.getGate(projectId);
  if (!gate) return null;

  const positives = parseTokens(gate.positivesJson);
  const documents = await UniverseRepository.getContentPageDocuments(projectId);
  const pageCounts = new Map<string, number>();
  for (const document of documents) {
    for (const token of new Set(
      topicTokens(`${document.title ?? ""} ${document.path}`),
    )) {
      pageCounts.set(token, (pageCounts.get(token) ?? 0) + 1);
    }
  }

  return {
    positives: positives.map((token) => ({
      token,
      // Zero becomes null, not "0 pages": a positive can be earned entirely
      // from the queries the site already ranks for, or typed in by hand, and
      // a zero beside it would read as a broken token rather than a true one.
      documentCount: pageCounts.get(token) ?? null,
    })),
    negatives: parseTokens(gate.negativesJson),
    kdCeiling: gate.kdCeiling,
    kdCeilingUpdatedAt: gate.kdCeilingUpdatedAt,
    userEdited: gate.userEdited,
    derivedAt: gate.derivedAt,
  };
}

/**
 * Normalize a hand-edited token list.
 *
 * Lowercased, trimmed, de-duplicated and capped at the same 40 the derivation
 * uses — the cap is what keeps the gate a statement about a niche rather than
 * a list of every word the site has ever used, and a hand-edited gate has no
 * document-frequency ordering to fall back on if it grows past readable.
 */
function normalizeTokens(tokens: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of tokens) {
    const token = raw.trim().toLowerCase();
    if (token.length > 0) seen.add(token);
  }
  return [...seen].slice(0, POSITIVE_TOKEN_CAP);
}

/**
 * Save a hand-edited gate. Refuses on a project that has never derived one —
 * there is nothing to edit yet, and creating a row here would produce a gate
 * marked user-edited that no derivation is ever allowed to fill in.
 */
async function editGate(input: {
  projectId: string;
  positives: string[];
  negatives: string[];
}): Promise<{ positives: number; negatives: number }> {
  const positives = normalizeTokens(input.positives);
  const negatives = normalizeTokens(input.negatives);
  const saved = await CurationRepository.saveEditedGate({
    projectId: input.projectId,
    positivesJson: JSON.stringify(positives),
    negativesJson: JSON.stringify(negatives),
  });
  if (!saved) {
    throw new AppError(
      "NOT_FOUND",
      "This project has no relevance gate yet. Run a keyword source first.",
    );
  }
  return { positives: positives.length, negatives: negatives.length };
}

/** Skip rows the user does not want in the plan. Returns what actually moved,
 *  which is smaller than the selection whenever a row has already been bound
 *  to a page type — the toast quotes the real number. */
async function skipKeywords(input: {
  projectId: string;
  keywordIds: string[];
}): Promise<{ skipped: number }> {
  return { skipped: await CurationRepository.skipKeywords(input) };
}

export const CurationService = {
  getGateCard,
  editGate,
  skipKeywords,
};
