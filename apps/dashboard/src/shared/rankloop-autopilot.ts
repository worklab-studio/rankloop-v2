/**
 * The per-phase ceilings on one unattended run (spec 0025).
 *
 * They live in `shared/` because two places have to agree about them: the
 * autopilot block, which stops at them, and the Automation surface, which
 * prints them as a promise to the person who moved the dial. A number typed
 * twice is a number that eventually differs, and the half of the pair that
 * would be wrong is the sentence on screen — the code keeps running either
 * way.
 *
 * The approve phase has no constant here on purpose: its ceiling is the day's
 * remaining quota, which the project sets itself, and a second cap on top of
 * it would be this file quietly overruling that setting.
 */

/**
 * Drafts one run may start.
 *
 * The dispatcher wakes every 15 minutes, so this is not a rate limit — the
 * quota already decides how much gets written in a day. It is a blast radius:
 * a writer that has started producing work the laws reject costs two drafts
 * per wake, not a morning's worth, and the kill switch trips three failed
 * gates later. Each attempt is metered (~$0.12, up to 3 attempts per article),
 * which is the other reason a machine deciding alone gets a small number.
 */
export const AUTOPILOT_WRITE_CAP = 2;

/**
 * Pages one run may publish.
 *
 * Matched to the write cap rather than raised above it: publishing faster than
 * the loop writes would only drain a backlog that the indexation throttle is
 * usually the reason for, and shipping twenty pages in one wake is how a site
 * earns the crawl budget it just lost.
 */
export const AUTOPILOT_PUBLISH_CAP = 2;
