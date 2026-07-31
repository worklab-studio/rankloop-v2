/**
 * The writer dials a project runs on before anyone changes them. These are
 * the same numbers the `writer_settings` column defaults carry, restated here
 * because a project with no row is the normal state and both the settings
 * form and the quota have to agree about what it means.
 *
 * `quotaStartDate: null` is the important one: a fresh project's quota is OFF
 * until its owner picks a start date. Defaulting it to "today" would have
 * every project that ever opened the Articles screen silently owing posts.
 */
export const WRITER_SETTINGS_DEFAULTS = {
  postsPerDay: 2,
  catchupCap: 6,
  quotaStartDate: null,
  voiceCardMd: null,
  trustDial: "titles",
  // Every project that existed before the agent path did is writing through
  // this app's writer, so that is what a missing row means.
  writerMode: "api",
} as const;

/** Ceilings for the settings form and the server validator. Two a day is the
 *  default cadence; ten is already more than a small team edits, and the
 *  catch-up cap must never sit below one day's worth or a single missed day
 *  becomes permanent debt. */
export const MAX_POSTS_PER_DAY = 10;
export const MAX_CATCHUP_CAP = 30;
