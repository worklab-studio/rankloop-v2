/**
 * The shape every scheduled block implements so the two dispatchers can share
 * one code path.
 *
 * The split matters: `dueProjects` is the block's admission rule and
 * `runForProject` is its work. A dispatcher that owns a whole instance (the
 * cron sweep) asks the rule for the next N projects; a dispatcher that owns
 * one project (the Durable Object alarm) asks the *same* rule about that one
 * project by passing `projectId`. Neither dispatcher gets to decide what
 * "due" means, which is what keeps a routine from behaving one way on
 * Cloudflare and another in Docker.
 */
export type RoutineBlockName =
  | "gsc-sync"
  | "site-study"
  | "receipts"
  | "indexation"
  | "competitors"
  | "universe"
  | "net-new"
  | "digest";

export type RoutineBlock = {
  name: RoutineBlockName;
  /**
   * Which projects this block owes work to at `now`, newest-fair-first and
   * capped by the block's own per-tick budget. `projectId` narrows the
   * identical predicate to one project.
   */
  dueProjects(now: Date, projectId?: string): Promise<string[]>;
  /**
   * Do this block's work for one project. Throwing is fine — the dispatcher
   * isolates blocks from each other — so only loops *inside* a block (a
   * project with several tracked competitors, say) need their own try/catch.
   */
  runForProject(projectId: string, now: Date): Promise<void>;
};

/** What one block did on one dispatch. `not-due` is a first-class answer:
 *  most blocks are not due most of the time, and a summary that only listed
 *  work would look identical to a dispatcher that never ran. */
export type RoutineBlockOutcome = {
  block: RoutineBlockName;
  status: "ran" | "not-due" | "failed";
  /** Bounded error echo, present only on `failed`. */
  error?: string;
};

export type RoutineRunSummary = {
  projectId: string;
  /** The clock the run was given, not the clock it finished on — this is what
   *  makes two dispatch paths comparable. */
  at: string;
  blocks: RoutineBlockOutcome[];
};
