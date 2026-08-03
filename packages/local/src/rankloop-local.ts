#!/usr/bin/env node
/** The bin entry: real dependencies in, `runOnce` out. Everything above this
 * file is pure or injected; everything real — fs, git, fetch, the state file
 * — is wired here and nowhere else. */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CRON_HELP, HELP, parseArgs, VERSION } from "./cli.ts";
import { CONFIG_PATH, resolveConfig, STATE_PATH } from "./config.ts";
import { connectMcp } from "./mcp.ts";
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
