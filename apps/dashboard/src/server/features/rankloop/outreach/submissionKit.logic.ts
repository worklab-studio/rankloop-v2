// The Submission Kit (spec 0029): your product's canonical facts, filled
// once, rendered per target's field limits.
//
// Most directories are manual forms and always will be. The kit removes the
// retyping, not the human — nothing here submits anything.

export interface SubmissionKit {
  name: string;
  /** ~60 chars. The one-line pitch most directories ask for first. */
  tagline: string;
  /** ~160 chars. Meta-description length; the most commonly requested field. */
  shortDescription: string;
  /** ~500 chars. The "tell us about your product" box. */
  longDescription: string;
  url: string;
  logoUrl: string | null;
  categories: string[];
  pricing: string | null;
  founder: string | null;
  launchDate: string | null;
}

export interface KitField {
  label: string;
  value: string;
  /** True when the source text was longer than the target's limit. The UI
   *  says so — a silently clipped description is how a submission goes out
   *  ending mid-sentence. */
  truncated: boolean;
  limit: number | null;
}

/**
 * Shorten to `limit` characters without cutting a word in half.
 *
 * Falls back to a hard cut only when the first word is itself longer than
 * the limit, which is the one case where a word boundary does not exist.
 * No ellipsis: directories count characters, and spending three of them on
 * punctuation that says "there was more" helps nobody.
 */
export function truncateAtWord(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;

  const cut = trimmed.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace <= 0) return cut.trimEnd();

  // Drop trailing punctuation left dangling by the cut.
  return cut.slice(0, lastSpace).replace(/[,;:.\-–—]+$/, "").trimEnd();
}

/** Field limits a target asks for. All optional — an unlimited field is
 *  common and must not be treated as a zero-length one. */
export interface TargetFieldLimits {
  tagline?: number;
  shortDescription?: number;
  longDescription?: number;
}

function field(
  label: string,
  value: string,
  limit: number | undefined,
): KitField {
  if (limit === undefined) {
    return { label, value: value.trim(), truncated: false, limit: null };
  }
  const rendered = truncateAtWord(value, limit);
  return {
    label,
    value: rendered,
    truncated: rendered.length < value.trim().length,
    limit,
  };
}

/**
 * The payload for one target: every field it asks for, already the right
 * length, ready to copy.
 *
 * Empty fields are omitted rather than rendered blank. A form with six boxes
 * and three filled is a form you finish; six boxes with three empty
 * placeholders reads as a broken export.
 */
export function renderPayload(
  kit: SubmissionKit,
  limits: TargetFieldLimits = {},
): KitField[] {
  const fields: KitField[] = [
    field("Name", kit.name, undefined),
    field("Tagline", kit.tagline, limits.tagline ?? 60),
    field("Short description", kit.shortDescription, limits.shortDescription ?? 160),
    field("Long description", kit.longDescription, limits.longDescription ?? 500),
    field("URL", kit.url, undefined),
  ];

  if (kit.logoUrl) fields.push(field("Logo", kit.logoUrl, undefined));
  if (kit.categories.length > 0) {
    fields.push(field("Categories", kit.categories.join(", "), undefined));
  }
  if (kit.pricing) fields.push(field("Pricing", kit.pricing, undefined));
  if (kit.founder) fields.push(field("Founder", kit.founder, undefined));
  if (kit.launchDate) fields.push(field("Launch date", kit.launchDate, undefined));

  return fields.filter((f) => f.value !== "");
}

/**
 * What the kit still needs before it is usable.
 *
 * Returned as sentences rather than field names so the UI can show them
 * directly. A kit missing its tagline is not "invalid" — it is a form the
 * user has not finished, and every directory asks for that one first.
 */
export function kitGaps(kit: Partial<SubmissionKit>): string[] {
  const gaps: string[] = [];
  if (!kit.name?.trim()) gaps.push("a product name");
  if (!kit.tagline?.trim()) gaps.push("a one-line tagline");
  if (!kit.shortDescription?.trim()) gaps.push("a short description");
  if (!kit.url?.trim()) gaps.push("your product URL");
  return gaps;
}

/** A kit good enough to submit with. The long description and logo are
 *  frequently optional on the form itself, so they do not block. */
export function kitIsUsable(kit: Partial<SubmissionKit>): boolean {
  return kitGaps(kit).length === 0;
}
