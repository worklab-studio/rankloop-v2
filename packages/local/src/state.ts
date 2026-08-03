/** The runner's memory of what it already did.
 *
 * Cron means interrupted runs are normal — a lid closes mid-generation, a
 * push lands but the deploy is slow, the report never goes out. rankloop
 * keeps listing a proposal as unwritten until `publish_report` lands, which
 * is correct from the server's side and a trap from the laptop's: without
 * local state, every interruption costs a duplicate generation and a
 * duplicate file. This file is what lets a run resume exactly where the last
 * one stopped.
 *
 * Phases only move forward:
 *
 *   drafted   draft-mode file written; terminal for draft mode
 *   written   repo file written, not yet committed/pushed
 *   pushed    on the remote, URL not yet seen live
 *   reported  publish_report landed; terminal
 */

export type Phase = "drafted" | "written" | "pushed" | "reported";

export interface ProposalState {
  phase: Phase;
  slug: string;
  file: string;
  url?: string;
  commit?: string;
  updatedAt: string;
}

export type RunnerState = Record<string, ProposalState>;

const ORDER: Phase[] = ["drafted", "written", "pushed", "reported"];

/** Forward-only. A crashed run must never un-happen a push by writing an
 *  earlier phase over a later one. */
export function advance(
  state: RunnerState,
  proposalId: string,
  next: Omit<ProposalState, "updatedAt">,
  now: string,
): RunnerState {
  const current = state[proposalId];
  if (current && ORDER.indexOf(next.phase) < ORDER.indexOf(current.phase)) {
    return state;
  }
  return {
    ...state,
    [proposalId]: { ...current, ...next, updatedAt: now },
  };
}

/** What a run should do for a proposal, given what already happened. */
export type ResumePoint =
  | { step: "write" }
  | { step: "commit"; resume: ProposalState }
  | { step: "verify"; resume: ProposalState }
  | { step: "done"; resume: ProposalState };

export function resumePoint(state: RunnerState, proposalId: string): ResumePoint {
  const entry = state[proposalId];
  if (!entry) return { step: "write" };
  switch (entry.phase) {
    case "drafted":
    case "reported":
      // Terminal. `drafted` deliberately does not retry into repo mode on a
      // config change — the human moved that file somewhere; regenerating it
      // costs a generation and risks two versions of one article.
      return { step: "done", resume: entry };
    case "written":
      return { step: "commit", resume: entry };
    case "pushed":
      return { step: "verify", resume: entry };
  }
}

export function parseState(raw: string | null): RunnerState {
  if (!raw || raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    // Field-checked, not cast: this file survives versions of the runner,
    // and a malformed entry must degrade to "start over" for that proposal,
    // not crash every future run.
    const out: RunnerState = {};
    for (const [id, value] of Object.entries(parsed)) {
      const v = value as Partial<ProposalState>;
      if (
        typeof v?.phase === "string" &&
        (ORDER as string[]).includes(v.phase) &&
        typeof v.slug === "string" &&
        typeof v.file === "string"
      ) {
        out[id] = {
          phase: v.phase as Phase,
          slug: v.slug,
          file: v.file,
          url: typeof v.url === "string" ? v.url : undefined,
          commit: typeof v.commit === "string" ? v.commit : undefined,
          updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : "",
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeState(state: RunnerState): string {
  return JSON.stringify(state, null, 2) + "\n";
}
