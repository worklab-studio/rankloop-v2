// The sentence the Publish panel puts above its button, and the two small
// labels the Published tab needs.
//
// Pure, because the sentence is the promise — it is the last thing a user
// reads before rankloop writes to a site they own, and a promise worth making
// is worth a test that pins its wording.
//
// The verb comes from `plan.action`, which the server derives from the adapter
// and its stored config. A commit and a pull request are the same GitHub
// adapter, so no capability flag could tell them apart and no screen should
// try: the plan says what the run will do, and this file only says it in
// English.

/** What the run will physically do to the target. */
type PublishAction =
  | "creates-draft"
  | "publishes"
  | "opens-pull-request"
  | "commits"
  | "sends-envelope";

type PlanShape = {
  action: PublishAction;
  /** Where the write lands, already in the form a human recognises: a host
   *  for WordPress and webhooks, `owner/repo` for GitHub. */
  target: string;
  /** Null when the article's page type has no hub — nothing to name. */
  hub: { name: string; exists: boolean } | null;
  linkTargetCount: number;
};

function openingClause(action: PublishAction, target: string): string {
  switch (action) {
    // The draft default is the whole reason WordPress is the safe first
    // target, so the word "draft" is in the sentence rather than in a
    // settings tooltip.
    case "creates-draft":
      return `Creates a draft post on ${target}`;
    case "publishes":
      return `Publishes a post on ${target}`;
    case "opens-pull-request":
      return `Opens a pull request on ${target}`;
    case "commits":
      return `Commits the post to ${target}`;
    case "sends-envelope":
      return `Sends the post to ${target}`;
  }
}

/**
 * Join clauses the way the copy does: two get "and", three get an Oxford
 * comma. Written out rather than reached for from a formatter because the
 * result is prose in the product's voice, not a list.
 */
function joinClauses(clauses: string[]): string {
  if (clauses.length === 1) return clauses[0];
  if (clauses.length === 2) return `${clauses[0]} and ${clauses[1]}`;
  const head = clauses.slice(0, -1).join(", ");
  return `${head}, and ${clauses[clauses.length - 1]}`;
}

/**
 * "Creates a draft post on yoursite.com, adds it to the Comparisons hub, and
 * links to it from 2 existing posts."
 *
 * Hub-before-instance (rule 1) is stated when the hub does not exist yet,
 * because "creates the hub first" is the difference between a page with a way
 * in and an orphan, and the user is entitled to know rankloop is about to make
 * a second page.
 */
export function publishPlanSentence(plan: PlanShape): string {
  const clauses = [openingClause(plan.action, plan.target)];
  if (plan.hub) {
    clauses.push(
      plan.hub.exists
        ? `adds it to the ${plan.hub.name} hub`
        : `creates the ${plan.hub.name} hub first and adds it there`,
    );
  }
  if (plan.linkTargetCount > 0) {
    clauses.push(
      `links to it from ${plan.linkTargetCount} existing post${
        plan.linkTargetCount === 1 ? "" : "s"
      }`,
    );
  }
  return `${joinClauses(clauses)}.`;
}

/**
 * The second line, when there is something honest to add.
 *
 * Both cases mean the same thing on the site — the new page has one way in —
 * and saying it beats letting the sentence quietly drop its third clause.
 */
export function publishLinkCaveat({
  linkInjection,
  linkTargetCount,
}: {
  linkInjection: boolean;
  linkTargetCount: number;
}): string | null {
  if (!linkInjection) {
    return "Link injection is off, so the hub is the only page that will point at it.";
  }
  if (linkTargetCount === 0) {
    return "No related pages in the manifest yet, so the hub is the only page that will point at it.";
  }
  return null;
}

/** The Published tab's links column. Zero renders the em dash the rest of the
 *  tables use for "nothing here", never "0 posts". */
export function linksInjectedLabel(count: number): string {
  if (count === 0) return "—";
  return `${count} post${count === 1 ? "" : "s"}`;
}

/** A live URL shown as the path it is on the site; the full URL stays in the
 *  title attribute. Anything unparseable falls back to itself rather than
 *  disappearing. */
export function publishedPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
