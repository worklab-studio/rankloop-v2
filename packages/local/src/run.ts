/** The loop: proposals → brief → write → laws → ship → report.
 *
 * Everything reaches this file through `RunDeps` so the whole orchestration
 * is testable without a network, a git repo, or a model. The real wiring
 * lives in the bin entry.
 *
 * Two rules run through every branch here:
 *
 * 1. Report only what was observed. `rankloop_publish_report` opens a
 *    receipt against a URL; calling it before that URL answers 200 records
 *    a publish that has not happened.
 * 2. Never do the same work twice. rankloop lists a proposal as unwritten
 *    until the report lands — correct on the server, a trap on a laptop
 *    where cron makes interrupted runs normal. The state file is what turns
 *    a crash into a resume instead of a duplicate generation. */

import { join } from "node:path";
import type { LocalConfig } from "./config.ts";
import {
  buildRetryPrompt,
  buildWritePrompt,
  cleanDraft,
  type FailedLaw,
} from "./draft.ts";
import type { McpClient } from "./mcp.ts";
import { advance, resumePoint, type RunnerState } from "./state.ts";
import type { WriterRun } from "./spawn.ts";

export interface RunDeps {
  client: McpClient;
  config: LocalConfig;
  log: (message: string) => void;
  writer: (
    input: { command: string; args: string[]; timeoutMin: number },
    prompt: string,
  ) => Promise<WriterRun>;
  files: {
    exists(path: string): boolean;
    read(path: string): string | null;
    write(path: string, content: string): void;
  };
  /** Run git in a directory. Never a shell — argv only. */
  exec: (
    cwd: string,
    args: string[],
  ) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  /** HEAD a URL; null on network failure. */
  fetchStatus: (url: string) => Promise<number | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => string;
  loadState: () => RunnerState;
  saveState: (state: RunnerState) => void;
}

export interface RunSummary {
  handled: number;
  reported: number;
  drafted: number;
  /** Non-empty when the run stopped for a reason the user must fix. */
  fatal: string | null;
}

interface Proposal {
  id: string;
  keyword: string;
}

export async function runOnce(deps: RunDeps): Promise<RunSummary> {
  const { client, config, log } = deps;
  const summary: RunSummary = { handled: 0, reported: 0, drafted: 0, fatal: null };

  const status = await client.call("rankloop_status", { projectId: config.projectId });
  const writerMode = (status.structured as { writerMode?: string } | null)?.writerMode;
  if (writerMode !== "agent") {
    // Respect the dial rather than fight the API writer for the same
    // proposals. This is configuration, not an error — say where it lives.
    log(
      `This project's writer mode is "${writerMode ?? "unknown"}", not "agent". ` +
        `Flip it in Connect → Writing, then run again.`,
    );
    return summary;
  }

  const proposals = readProposals(
    await client.call("rankloop_proposals", { projectId: config.projectId }),
  );

  const state = deps.loadState();
  // Unfinished work first: a proposal mid-flight (file written, push not yet
  // live) is finished before any new generation is started. New generations
  // are the expensive step; resumes are nearly free.
  const ordered = [...proposals].sort((a, b) => rank(state, a.id) - rank(state, b.id));

  if (ordered.length === 0) {
    log("No approved proposals are waiting. Approve titles in the dashboard first.");
    return summary;
  }

  // The budget counts WORK, not iterations. Slicing the list before knowing
  // which entries are already finished means one done proposal at the front
  // consumes the whole run — with maxPerRun 1 and any finished item in the
  // list, the new work is never reached and every cron tick is a no-op.
  let worked = 0;
  for (const proposal of ordered) {
    if (worked >= config.maxPerRun) break;
    summary.handled++;
    try {
      const outcome = await handleProposal(deps, proposal);
      if (outcome !== "skipped") worked++;
      if (outcome === "reported") summary.reported++;
      if (outcome === "drafted") summary.drafted++;
      if (outcome === "fatal") {
        summary.fatal = "the writer command failed to start — see above";
        break;
      }
    } catch (error) {
      // A failure is work attempted — it spent a generation or a network
      // call, and retrying the whole list inside one run would multiply a
      // transient outage by the number of proposals.
      worked++;
      // One proposal's failure is not the run's. Log and move on; the
      // proposal stays approved and the next run tries again.
      log(
        `"${proposal.keyword}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return summary;
}

function rank(state: RunnerState, id: string): number {
  const phase = state[id]?.phase;
  if (phase === "pushed") return 0;
  if (phase === "written") return 1;
  return 2;
}

function readProposals(result: {
  structured: Record<string, unknown> | null;
  text: string;
  isError: boolean;
}): Proposal[] {
  if (result.isError) throw new Error(result.text);
  // The tool names the field `proposalId`. The first live run against the
  // real server was the thing that caught this — the unit fixtures had
  // faithfully repeated the wrong guess (`id`), which is why fixtures must
  // mirror the tool's real output, not the client author's memory of it.
  const rows = (result.structured?.proposals ?? []) as {
    proposalId?: string;
    id?: string;
    keyword?: string;
    article?: unknown;
  }[];
  return rows
    .map((row) => ({ ...row, key: row.proposalId ?? row.id }))
    // `article` non-null means the dashboard's own writer already has a
    // draft in flight for it; taking it too would race that writer.
    .filter((row) => typeof row.key === "string" && row.article == null)
    .map((row) => ({ id: row.key as string, keyword: row.keyword ?? (row.key as string) }));
}

type Outcome = "reported" | "drafted" | "skipped" | "left" | "fatal";

async function handleProposal(deps: RunDeps, proposal: Proposal): Promise<Outcome> {
  const { config, log } = deps;
  const state = deps.loadState();
  const point = resumePoint(state, proposal.id);

  if (point.step === "done") {
    log(`"${proposal.keyword}": already ${point.resume.phase} (${point.resume.file}).`);
    return "skipped";
  }

  if (point.step === "commit" || point.step === "verify") {
    log(`"${proposal.keyword}": resuming at ${point.step} (${point.resume.file}).`);
    return shipFromRepo(deps, proposal, point.resume.slug, point.resume.file, null);
  }

  // ---- fresh write ----
  const brief = await deps.client.call("rankloop_brief", {
    projectId: config.projectId,
    proposalId: proposal.id,
    allowSerpFetch: config.allowSerpFetch,
  });
  if (brief.isError) throw new Error(brief.text);
  const briefMarkdown = (brief.structured as { markdown?: string } | null)?.markdown;
  if (!briefMarkdown) throw new Error("the brief came back empty");

  let prompt = buildWritePrompt(briefMarkdown);
  let draft = "";
  let slug = "";
  let passed = false;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    log(
      `"${proposal.keyword}": writing with \`${config.write.command}\` (attempt ${attempt}/${config.maxAttempts})…`,
    );
    const run = await deps.writer(config.write, prompt);

    if (!run.ok) {
      log(`"${proposal.keyword}": ${run.detail ?? "the writer failed"}`);
      // A missing command fails identically forever; burning the remaining
      // attempts — and the remaining proposals — on it helps nobody.
      if (run.code === null && !run.timedOut) return "fatal";
      return "left";
    }

    draft = cleanDraft(run.stdout);
    const check = await deps.client.call("rankloop_check", {
      projectId: config.projectId,
      proposalId: proposal.id,
      draft,
    });
    if (check.isError) throw new Error(check.text);
    const checked = check.structured as {
      passed?: boolean;
      slug?: string;
      violations?: number;
      report?: { laws?: FailedLaw[] };
    } | null;

    slug = checked?.slug ?? slug;
    if (checked?.passed === true) {
      passed = true;
      log(`"${proposal.keyword}": passed the laws on attempt ${attempt}.`);
      break;
    }

    log(
      `"${proposal.keyword}": ${checked?.violations ?? "?"} law(s) unmet on attempt ${attempt}.`,
    );
    prompt = buildRetryPrompt(draft, checked?.report?.laws ?? []);
  }

  if (!passed) {
    // Same semantics as the dashboard writer: the proposal stays approved,
    // nothing half-done is shipped, and the failure is a sentence rather
    // than a mystery.
    log(
      `"${proposal.keyword}": ${config.maxAttempts} attempts did not clear the laws. The proposal stays approved; nothing was shipped.`,
    );
    return "left";
  }

  if (slug === "") throw new Error("the check passed but returned no slug");

  // ---- ship ----
  if (config.repo === null) {
    const file = join(config.outDir, `${slug}.md`);
    if (deps.files.exists(file) && !deps.loadState()[proposal.id]) {
      log(
        `"${proposal.keyword}": ${file} already exists and rankloop-local did not write it. Refusing to overwrite.`,
      );
      return "left";
    }
    deps.files.write(file, draft);
    deps.saveState(
      advance(deps.loadState(), proposal.id, { phase: "drafted", slug, file }, deps.now()),
    );
    log(`"${proposal.keyword}": gated draft ready — ${file}`);
    return "drafted";
  }

  const file = join(config.repo.path, config.repo.contentDir, `${slug}.md`);
  if (deps.files.exists(file) && !deps.loadState()[proposal.id]) {
    log(
      `"${proposal.keyword}": ${file} already exists and rankloop-local did not write it. Refusing to overwrite.`,
    );
    return "left";
  }
  deps.files.write(file, draft);
  // State moves BEFORE git so a crash between the two resumes at commit
  // instead of regenerating the article.
  deps.saveState(
    advance(deps.loadState(), proposal.id, { phase: "written", slug, file }, deps.now()),
  );
  return shipFromRepo(deps, proposal, slug, file, draft);
}

/** written → pushed → live → reported. Entered fresh or as a resume; every
 *  step is safe to hit twice. */
async function shipFromRepo(
  deps: RunDeps,
  proposal: Proposal,
  slug: string,
  file: string,
  draftInMemory: string | null,
): Promise<Outcome> {
  const { config, log } = deps;
  const repo = config.repo;
  if (repo === null) throw new Error("shipFromRepo called without a repo");

  const phase = deps.loadState()[proposal.id]?.phase;

  if (phase === "written") {
    const add = await deps.exec(repo.path, ["add", file]);
    if (!add.ok) throw new Error(`git add failed: ${add.stderr}`);

    const commit = await deps.exec(repo.path, ["commit", "-m", `rankloop: ${slug}`]);
    // "nothing to commit" means the previous run committed and crashed
    // before recording it — that is a resume, not a failure.
    if (!commit.ok && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
      throw new Error(`git commit failed: ${commit.stderr}`);
    }

    const head = await deps.exec(repo.path, ["rev-parse", "HEAD"]);
    const sha = head.ok ? head.stdout.trim() : undefined;

    if (repo.push) {
      const push = await deps.exec(repo.path, ["push"]);
      if (!push.ok) {
        // Committed locally, not on the remote. Stay at `written`: the next
        // run re-enters here, the commit no-ops, the push retries.
        log(`"${proposal.keyword}": git push failed — will retry next run. ${push.stderr.trim()}`);
        return "left";
      }
    }

    const url = `${repo.urlBase}/${slug}/`;
    deps.saveState(
      advance(
        deps.loadState(),
        proposal.id,
        { phase: "pushed", slug, file, url, commit: sha },
        deps.now(),
      ),
    );
  }

  // ---- verify live, then report ----
  const entry = deps.loadState()[proposal.id];
  const url = entry?.url ?? `${repo.urlBase}/${slug}/`;
  const deadline = Date.now() + repo.verifyTimeoutMin * 60_000;

  log(`"${proposal.keyword}": waiting for ${url} to go live…`);
  let live = false;
  for (;;) {
    const status = await deps.fetchStatus(url);
    if (status === 200) {
      live = true;
      break;
    }
    if (Date.now() >= deadline) break;
    await deps.sleep(15_000);
  }

  if (!live) {
    // The one honesty rule that costs patience: a receipt against a URL
    // nobody has seen answer 200 records a publish that has not happened.
    log(
      `"${proposal.keyword}": pushed, but ${url} is not live yet. The next run will confirm and report it.`,
    );
    return "left";
  }

  // On a resume the generation is gone; the file IS the draft that shipped,
  // and grading what actually shipped is the point of sending it.
  const draft = draftInMemory ?? deps.files.read(file);

  const report = await deps.client.call("rankloop_publish_report", {
    projectId: config.projectId,
    proposalId: proposal.id,
    url,
    ...(entry?.commit ? { commit: entry.commit } : {}),
    ...(draft ? { draft } : {}),
  });
  if (report.isError) throw new Error(report.text);

  deps.saveState(
    advance(deps.loadState(), proposal.id, { phase: "reported", slug, file, url }, deps.now()),
  );
  log(`"${proposal.keyword}": live at ${url} — reported, receipt open.`);
  return "reported";
}
