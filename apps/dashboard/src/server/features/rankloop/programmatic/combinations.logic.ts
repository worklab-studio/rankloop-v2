// The programmatic combination engine (spec 0031).
//
// One template, thousands of pages, is the highest-leverage thing in
// programmatic SEO and the fastest way to build a site Google files as
// spam. The only difference between the two is whether each page says
// something the others do not — so almost everything in this file is a
// refusal, and each refusal is reported rather than applied quietly.
//
// Pure. Storage is `page_type_data`, which has carried `provenanceJson`,
// `confidence` and `needsReview` since S6 and has never been written to;
// this is what fills it.

/** One dimension of the grid: `city` with 50 values, `service` with 12. */
export interface VariableSet {
  name: string;
  values: string[];
}

/** One cell of a data row, with where it came from. */
export interface DataCell {
  value: string;
  /** Null means we have a value and cannot say where it came from. Such a
   *  cell is `needsReview` and does not count toward completeness — an
   *  unsourced fact is the thing the publish laws exist to keep out. */
  provenance: string | null;
  confidence: number | null;
}

/** The facts behind one combination. */
export type DataRow = Record<string, DataCell>;

export interface Combination {
  /** `{ city: "Austin", service: "plumbing" }` */
  values: Record<string, string>;
  /** Stable, order-independent identity for the combination. */
  key: string;
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

/**
 * Every combination of the variable sets.
 *
 * `maxCombinations` is a hard stop, not a page size. Generating 3,600
 * combinations to then drop 3,400 wastes the work and, worse, invites a UI
 * that shows "3,600 pages!" before anything has been checked.
 */
export function combinations(
  variables: readonly VariableSet[],
  maxCombinations = 2000,
): { combinations: Combination[]; truncated: number } {
  const usable = variables.filter((v) => v.values.length > 0);
  if (usable.length === 0) return { combinations: [], truncated: 0 };

  const total = usable.reduce((n, v) => n * v.values.length, 1);
  let rows: Record<string, string>[] = [{}];

  for (const variable of usable) {
    const next: Record<string, string>[] = [];
    for (const row of rows) {
      for (const value of variable.values) {
        if (next.length >= maxCombinations) break;
        next.push({ ...row, [variable.name]: value });
      }
    }
    rows = next;
  }

  return {
    combinations: rows.map((values) => ({ values, key: combinationKey(values) })),
    truncated: Math.max(0, total - rows.length),
  };
}

/** Order-independent so `{city, service}` and `{service, city}` are one
 *  combination, not two. */
export function combinationKey(values: Record<string, string>): string {
  return Object.keys(values)
    .toSorted()
    .map((k) => `${k}=${values[k]}`)
    .join("|");
}

// ---------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------

/**
 * How much of a row is usable, 0–1.
 *
 * A cell with no provenance counts as absent. That is the strict reading and
 * it is the intended one: a page assembled from unsourced values is exactly
 * the page that cannot survive being asked "where did you get that".
 */
export function completeness(row: DataRow, requiredFields: readonly string[]): number {
  if (requiredFields.length === 0) return 0;
  const usable = requiredFields.filter((field) => {
    const cell = row[field];
    return (
      cell !== undefined &&
      cell.value.trim() !== "" &&
      cell.provenance !== null &&
      cell.provenance.trim() !== ""
    );
  });
  return usable.length / requiredFields.length;
}

/** Cells that have a value but nothing behind it. Surfaced so a user can
 *  fill the gap rather than wonder why a page was dropped. */
export function unsourcedFields(row: DataRow): string[] {
  return Object.entries(row)
    .filter(([, cell]) => cell.value.trim() !== "" && !cell.provenance?.trim())
    .map(([field]) => field);
}

/**
 * Identity of a row by its VALUES, for duplicate detection.
 *
 * Hashing the data rather than comparing titles is the point: two pages
 * titled "CRM for dentists" and "CRM for orthodontists" whose rows are
 * identical are one page with two URLs, and the titles will never say so.
 */
export function rowFingerprint(row: DataRow, requiredFields: readonly string[]): string {
  return requiredFields
    .toSorted()
    .map((field) => (row[field]?.value ?? "").trim().toLowerCase())
    .join("");
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export type DropReason =
  | "no_data_row"
  | "row_too_thin"
  | "duplicate_row"
  | "over_cap";

export interface PageSpec {
  key: string;
  values: Record<string, string>;
  row: DataRow;
  completeness: number;
  /** Fields that had a value but no source. The page still ships; these are
   *  flagged for review rather than silently trusted. */
  needsReview: string[];
}

export interface Dropped {
  key: string;
  values: Record<string, string>;
  reason: DropReason;
  detail: string;
}

export interface ProgrammaticPlan {
  pages: PageSpec[];
  dropped: Dropped[];
  /** Reasons rolled up, so the UI can say "260 dropped: 180 had no data"
   *  rather than listing 260 rows nobody will read. */
  dropSummary: { reason: DropReason; count: number; label: string }[];
  truncated: number;
}

const DROP_LABEL: Record<DropReason, string> = {
  no_data_row: "no data to write about",
  row_too_thin: "not enough sourced data to say anything specific",
  duplicate_row: "identical data to another page",
  over_cap: "beyond the page limit for this run",
};

export interface PlanInput {
  variables: readonly VariableSet[];
  /** The data for each combination, keyed by `combinationKey`. */
  rows: Record<string, DataRow>;
  /** Fields a page needs to be worth writing. */
  requiredFields: readonly string[];
  /** Below this share of sourced required fields, the page is refused. */
  minCompleteness?: number;
  maxPages?: number;
  maxCombinations?: number;
}

/**
 * Turn a grid plus its data into the pages worth writing.
 *
 * Everything here is a refusal, and every refusal is reported. A builder
 * that silently turns a 600-combination grid into 340 pages has told the
 * user nothing about the 260 it dropped, and the 260 are where the
 * interesting problem is — usually a data source that did not cover half
 * the grid.
 */
export function planProgrammaticPages(input: PlanInput): ProgrammaticPlan {
  const minCompleteness = input.minCompleteness ?? 0.6;
  const maxPages = input.maxPages ?? 500;

  const { combinations: grid, truncated } = combinations(
    input.variables,
    input.maxCombinations ?? 2000,
  );

  const pages: PageSpec[] = [];
  const dropped: Dropped[] = [];
  const seenFingerprints = new Map<string, string>();

  for (const combo of grid) {
    const row = input.rows[combo.key];

    if (row === undefined || Object.keys(row).length === 0) {
      dropped.push({
        key: combo.key,
        values: combo.values,
        reason: "no_data_row",
        detail: "No data row was found for this combination.",
      });
      continue;
    }

    const score = completeness(row, input.requiredFields);
    if (score < minCompleteness) {
      const unsourced = unsourcedFields(row);
      dropped.push({
        key: combo.key,
        values: combo.values,
        reason: "row_too_thin",
        detail:
          unsourced.length > 0
            ? `${Math.round(score * 100)}% of the required fields are sourced. Unsourced: ${unsourced.join(", ")}.`
            : `${Math.round(score * 100)}% of the required fields are filled.`,
      });
      continue;
    }

    const fingerprint = rowFingerprint(row, input.requiredFields);
    const twin = seenFingerprints.get(fingerprint);
    if (twin !== undefined) {
      dropped.push({
        key: combo.key,
        values: combo.values,
        reason: "duplicate_row",
        detail: `Its data is identical to ${twin}.`,
      });
      continue;
    }

    // The cap is applied AFTER the quality refusals, so a run does not spend
    // its budget on pages that would have been dropped anyway.
    if (pages.length >= maxPages) {
      dropped.push({
        key: combo.key,
        values: combo.values,
        reason: "over_cap",
        detail: `This run is limited to ${maxPages} pages.`,
      });
      continue;
    }

    seenFingerprints.set(fingerprint, combo.key);
    pages.push({
      key: combo.key,
      values: combo.values,
      row,
      completeness: score,
      needsReview: unsourcedFields(row),
    });
  }

  return { pages, dropped, dropSummary: summarise(dropped), truncated };
}

function summarise(dropped: readonly Dropped[]) {
  const counts = new Map<DropReason, number>();
  for (const drop of dropped) {
    counts.set(drop.reason, (counts.get(drop.reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count, label: DROP_LABEL[reason] }))
    .toSorted((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// What it costs
// ---------------------------------------------------------------------------

/**
 * The bill, before anything runs.
 *
 * "One template, thousands of pages" is a sentence that should worry the
 * person reading it slightly, and the number that does that is the cost.
 */
export function quoteProgrammatic(
  plan: ProgrammaticPlan,
  costPerPageUsd: number,
): { pages: number; costUsd: number; dropped: number } {
  return {
    pages: plan.pages.length,
    costUsd: Math.round(plan.pages.length * costPerPageUsd * 100) / 100,
    dropped: plan.dropped.length,
  };
}

/** The URL slug for a combination, from its values in variable order. */
export function combinationSlug(
  values: Record<string, string>,
  order: readonly string[],
): string {
  return order
    .map((name) => values[name] ?? "")
    .filter((v) => v !== "")
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
