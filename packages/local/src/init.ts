/** `rankloop-local init` — configure from inside the user's website repo.
 *
 * The scenario this exists for: the site's source is on the laptop, git
 * pushes to GitHub, GitHub deploys to the domain. In that setup rankloop
 * needs no API adapter at all — the repo IS the deploy pipeline, and the
 * runner just has to write a file, commit, push, and wait for the URL.
 *
 * Every value is detected first and confirmed second, because a question
 * with a right answer already filled in is a question that cannot be
 * answered wrong. Pure: the caller does the I/O and the asking. */

import { DEFAULT_CONTENT_DIR, suggestUrlBase, type RepoSummary } from "./detect.ts";

export interface InitAnswers {
  projectId: string;
  domain: string;
  contentDir: string;
  writerCommand: string;
  push: boolean;
}

export interface InitPlan {
  config: Record<string, unknown>;
  /** Lines explaining what was detected and where each guess came from. */
  reasoning: string[];
  /** What the user must do next, in order. */
  nextSteps: string[];
}

export interface InitContext {
  summary: RepoSummary;
  answers: InitAnswers;
  server: string;
  /** Projects the dashboard already knows about, for the picker. */
  projects: { id: string; name: string; domain: string }[];
  configPath: string;
}

export function buildInitPlan(ctx: InitContext): InitPlan {
  const { summary, answers } = ctx;
  const reasoning: string[] = [];

  reasoning.push(`Stack: ${summary.stackLabel}`);
  if (summary.domain) {
    reasoning.push(`Domain: ${answers.domain} (from ${summary.domain.from})`);
  } else {
    reasoning.push(`Domain: ${answers.domain}`);
  }
  reasoning.push(`Posts will be written to: ${answers.contentDir}/`);

  const config: Record<string, unknown> = {
    server: ctx.server,
    projectId: answers.projectId,
    write: { command: answers.writerCommand, args: ["-p"], timeoutMin: 10 },
    repo: {
      path: ".",
      contentDir: answers.contentDir,
      urlBase: suggestUrlBase(answers.domain),
      push: answers.push,
      verifyTimeoutMin: 10,
    },
    outDir: "~/rankloop-drafts",
    maxAttempts: 3,
    allowSerpFetch: false,
  };

  const nextSteps: string[] = [];
  // `repo.path: "."` is deliberate and is the reason init insists on being
  // run from the repo root: a relative path keeps the config portable and
  // makes it obvious the runner acts on the directory you are standing in.
  nextSteps.push("Keep the dashboard running: cd apps/dashboard && npm run dev");
  nextSteps.push("In the dashboard, set Connect → Writing to \"agent\"");
  nextSteps.push("Check what is still blocking: rankloop-local doctor");
  nextSteps.push("Then: rankloop-local run --watch --every 30m");

  return { config, reasoning, nextSteps };
}

/** The prompts init asks, in order, each with its detected default. A
 *  question whose default is right needs one keypress. */
export function initQuestions(
  summary: RepoSummary,
  projects: { id: string; name: string; domain: string }[],
): { key: keyof InitAnswers; prompt: string; def: string }[] {
  const guessedDomain = summary.domain?.domain ?? "";
  // A project whose domain already matches the repo is almost certainly the
  // one meant, so it becomes the default rather than one of five choices.
  const match = projects.find(
    (p) => guessedDomain !== "" && p.domain.toLowerCase().includes(guessedDomain),
  );

  return [
    {
      key: "projectId",
      prompt:
        projects.length === 0
          ? "Project id (from the dashboard URL /p/<id>)"
          : `Project [${projects.map((p) => `${p.name}`).join(", ")}]`,
      def: match?.id ?? projects[0]?.id ?? "",
    },
    { key: "domain", prompt: "Your live domain", def: guessedDomain },
    { key: "contentDir", prompt: "Where posts should be written", def: DEFAULT_CONTENT_DIR },
    { key: "writerCommand", prompt: "Which CLI should write", def: "claude" },
    { key: "push", prompt: "Push to git automatically? (y/n)", def: "y" },
  ];
}

export function renderInitSummary(plan: InitPlan, configPath: string): string {
  return [
    "",
    "Detected:",
    ...plan.reasoning.map((line) => `  ${line}`),
    "",
    `Wrote ${configPath}`,
    "",
    "Next:",
    ...plan.nextSteps.map((step, i) => `  ${i + 1}. ${step}`),
    "",
  ].join("\n");
}
