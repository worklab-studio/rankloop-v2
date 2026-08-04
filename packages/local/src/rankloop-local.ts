#!/usr/bin/env node
/** The bin entry: real dependencies in, `runOnce` out. Everything above this
 * file is pure or injected; everything real — fs, git, fetch, the state file
 * — is wired here and nowhere else. */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { CRON_HELP, HELP, parseArgs, VERSION } from "./cli.ts";
import { CONFIG_PATH, expandTilde, resolveConfig, STATE_PATH } from "./config.ts";
import { DETECT_FILES, summarize, type RepoFacts } from "./detect.ts";
import { diagnose, nextAction, renderChecks, type DoctorFacts } from "./doctor.ts";
import { buildInitPlan, initQuestions, renderInitSummary, type InitAnswers } from "./init.ts";
import { connectMcp, type McpClient } from "./mcp.ts";
import { runOnce, type RunDeps } from "./run.ts";
import { parseState, serializeState, type RunnerState } from "./state.ts";
import { runWriter } from "./spawn.ts";

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function execGit(cwd: string, args: string[]) {
  return new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      resolve({ ok: error === null, stdout, stderr });
    });
  });
}

async function headStatus(url: string): Promise<number | null> {
  try {
    // GET, not HEAD: enough hosts answer HEAD with 403/405 that a HEAD-based
    // verifier would call live pages missing. The body is discarded.
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
    return res.status;
  } catch {
    return null;
  }
}

function onPath(command: string): boolean {
  try {
    // `command -v` rather than `which`: it is a shell builtin, present
    // everywhere, and reports shell functions and aliases too.
    execFileSync("/bin/sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function gitRemote(cwd: string): string | null {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function readRepoFacts(root: string): RepoFacts {
  const present = new Set<string>();
  const contents: Record<string, string> = {};
  for (const file of DETECT_FILES) {
    const full = join(root, file);
    if (!existsSync(full)) continue;
    present.add(file);
    try {
      contents[file] = readFileSync(full, "utf8");
    } catch {
      // Present but unreadable is still present — detection uses existence
      // for most files and contents only for the domain guess.
    }
  }
  return { present, contents, remote: gitRemote(root) };
}

/** Every project the dashboard knows, for init's picker. */
async function listProjects(
  client: McpClient,
): Promise<{ id: string; name: string; domain: string }[]> {
  try {
    const result = await client.call("list_projects", {});
    const rows = (result.structured?.projects ?? []) as {
      id?: string;
      name?: string;
      domain?: string;
    }[];
    return rows
      .filter((r) => typeof r.id === "string")
      .map((r) => ({ id: r.id as string, name: r.name ?? "", domain: r.domain ?? "" }));
  } catch {
    return [];
  }
}

async function runInit(): Promise<number> {
  const root = process.cwd();
  if (!existsSync(join(root, ".git"))) {
    console.log(
      `This does not look like a git repository.\n` +
        `Run \`rankloop-local init\` from the root of your website's repo — the one\n` +
        `you push to GitHub.`,
    );
    return 2;
  }

  const summary = summarize(readRepoFacts(root));
  const server = process.env.RANKLOOP_SERVER ?? "http://localhost:5173";

  let projects: { id: string; name: string; domain: string }[] = [];
  try {
    projects = await listProjects(await connectMcp(server));
  } catch {
    console.log(
      `Note: could not reach the dashboard at ${server}. You can still finish\n` +
        `setup — you will just need the project id by hand.\n`,
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answers: Partial<InitAnswers> = {};
  console.log(`\nSetting up rankloop for ${root}`);
  console.log(`Detected: ${summary.stackLabel}\n`);

  for (const q of initQuestions(summary, projects)) {
    const shown = q.def ? ` [${q.def}]` : "";
    const raw = (await rl.question(`  ${q.prompt}${shown}: `)).trim();
    const value = raw === "" ? q.def : raw;
    if (q.key === "push") answers.push = !/^n/i.test(value);
    else (answers as Record<string, string>)[q.key] = value;
  }
  rl.close();

  if (!answers.projectId) {
    console.log("\nNo project id — nothing to configure against. Aborted.");
    return 2;
  }

  const plan = buildInitPlan({
    summary,
    answers: answers as InitAnswers,
    server,
    projects,
    configPath: CONFIG_PATH,
  });
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  // `repo.path` is written as the absolute root rather than "." so the
  // config works from any working directory — a cron does not run from the
  // repo.
  const config = { ...plan.config, repo: { ...(plan.config.repo as object), path: root } };
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  console.log(renderInitSummary(plan, CONFIG_PATH));
  return 0;
}

async function runDoctor(): Promise<number> {
  const fileConfig = readJson(CONFIG_PATH);
  const { config } = resolveConfig(fileConfig, {});
  const facts: DoctorFacts = {
    inGitRepo: existsSync(join(process.cwd(), ".git")),
    configPath: CONFIG_PATH,
    configExists: fileConfig !== null,
    projectId: config.projectId || null,
    writerCommand: config.write.command,
    writerOnPath: onPath(config.write.command),
    repoConfigured: config.repo !== null,
    repoPathExists: config.repo ? existsSync(expandTilde(config.repo.path)) : false,
    server: config.server,
    reachable: false,
    projectFound: false,
    writerMode: null,
    pipeline: null,
  };

  try {
    const client = await connectMcp(config.server);
    facts.reachable = true;
    if (config.projectId) {
      const status = await client.call("rankloop_status", { projectId: config.projectId });
      const s = status.structured as {
        writerMode?: string;
        quota?: { owed?: number | null; slots?: number; reason?: string | null };
        exclusions?: { pageTypeName?: string; reason?: string }[];
      } | null;
      if (s) {
        facts.projectFound = true;
        facts.writerMode = s.writerMode ?? null;
      }
      const proposals = await client.call("rankloop_proposals", {
        projectId: config.projectId,
      });
      const rows = (proposals.structured?.proposals ?? []) as { article?: unknown }[];
      facts.pipeline = {
        owed: s?.quota?.owed ?? null,
        slots: s?.quota?.slots ?? 0,
        reason: s?.quota?.reason ?? null,
        exclusions: (s?.exclusions ?? []).map((e) => ({
          name: e.pageTypeName ?? "a page type",
          reason: e.reason ?? "held back",
        })),
        approvedProposals: rows.length,
        unwrittenProposals: rows.filter((r) => r.article == null).length,
      };
    }
  } catch {
    facts.reachable = false;
  }

  const checks = diagnose(facts);
  console.log(renderChecks(checks, nextAction(checks)));
  return checks.some((c) => c.state === "blocked") ? 1 : 0;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  const log = (message: string) => console.log(message);

  if (parsed.command === "help") {
    log(HELP);
    return 0;
  }
  if (parsed.command === "version") {
    log(VERSION);
    return 0;
  }
  if (parsed.command === "cron") {
    log(CRON_HELP);
    return 0;
  }
  if (parsed.command === "init") return runInit();
  if (parsed.command === "doctor") return runDoctor();
  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) log(error);
    return 2;
  }

  const { config, errors } = resolveConfig(readJson(CONFIG_PATH), parsed.flags);
  if (errors.length > 0) {
    for (const error of errors) log(error);
    return 2;
  }

  let client;
  try {
    client = await connectMcp(config.server);
  } catch (error) {
    log(
      `Could not reach rankloop at ${config.server} — is the dashboard running?\n` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
    return 1;
  }

  // The state file is read fresh and written whole on every transition.
  // Runs are minutes apart and single-process (the --every floor exists for
  // exactly this), so a lock would be guarding against a schedule this
  // package refuses to produce.
  const deps: RunDeps = {
    client,
    config,
    log,
    writer: runWriter,
    files: {
      exists: (path) => existsSync(path),
      read: (path) => {
        try {
          return readFileSync(path, "utf8");
        } catch {
          return null;
        }
      },
      write: (path, content) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content, "utf8");
      },
    },
    exec: execGit,
    fetchStatus: headStatus,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date().toISOString(),
    loadState: (): RunnerState => {
      try {
        return parseState(readFileSync(STATE_PATH, "utf8"));
      } catch {
        return {};
      }
    },
    saveState: (state) => {
      mkdirSync(dirname(STATE_PATH), { recursive: true });
      writeFileSync(STATE_PATH, serializeState(state), "utf8");
    },
  };

  for (;;) {
    const summary = await runOnce(deps);
    if (summary.fatal) {
      log(summary.fatal);
      return 1;
    }
    if (!parsed.watch) {
      return 0;
    }
    log(`Next run in ${parsed.everyMin} minutes.`);
    await deps.sleep(parsed.everyMin * 60_000);
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
