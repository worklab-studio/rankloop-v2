// The keyword_backlog.notesJson contract (spec 0016). Pure — unit-tested
// directly in notes.logic.test.ts.
//
// notesJson is the one place a source may say something the columns can't:
// which competitor a gap row came from, the phrasings a clustered GSC row
// stands for, whether a harvested row belongs to the question pool. It is a
// blob, which means the only thing keeping two features from disagreeing
// about its shape is this module — so both the writer (the universe upsert
// path) and the readers (the page planner's volume imputation) go through it.

import { z } from "zod";

/**
 * 28-day Search Console impressions, on rows Search Console proved.
 *
 * This exact key is load-bearing across two features. The universe step
 * writes it for every GSC-evidenced row and scores with it; the page planner
 * reads it back to impute demand a vendor priced at zero. Renaming it on one
 * side only would not fail a build or a test — the planner would simply stop
 * imputing, quietly, and every clustered candidate's demand would collapse to
 * whatever the vendor happened to say. Hence one constant, both sides.
 */
export const IMPRESSIONS_28_NOTE_KEY = "impr28";

const impressions28Schema = z.object({
  [IMPRESSIONS_28_NOTE_KEY]: z.number(),
});

const notesSchema = z.record(z.string(), z.unknown());

/** A row's 28-day impressions, or null when no source ever measured any.
 *  Rows written by autocomplete, harvest or a keyword the user typed simply
 *  haven't got one, and that absence is a real answer. */
export function readImpressions28(notesJson: string | null): number | null {
  if (!notesJson) return null;
  try {
    const parsed = impressions28Schema.safeParse(JSON.parse(notesJson));
    return parsed.success ? parsed.data[IMPRESSIONS_28_NOTE_KEY] : null;
  } catch {
    return null;
  }
}

/**
 * Fold a source's facts into whatever the row already carried.
 *
 * Merge rather than replace, because the same keyword legitimately arrives
 * from several sources: an autocomplete run that lands on a query Search
 * Console already proved must not overwrite `impr28` with a blob that has
 * never heard of it. Incoming keys win — a re-run of the same source is
 * reporting fresher facts — and keys it says nothing about survive. An empty
 * result stays null rather than becoming the string "{}", so a row with
 * nothing to say looks like one in the database.
 */
export function mergeNotes(
  existingJson: string | null,
  incoming: Record<string, unknown>,
): string | null {
  const merged = { ...parseNotes(existingJson), ...incoming };
  return Object.keys(merged).length === 0 ? null : JSON.stringify(merged);
}

function parseNotes(notesJson: string | null): Record<string, unknown> {
  if (!notesJson) return {};
  try {
    const parsed = notesSchema.safeParse(JSON.parse(notesJson));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}
