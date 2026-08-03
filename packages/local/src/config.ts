/** Configuration: `~/.config/rankloop/local.json`, flags overriding.
 *
 * The same directory the rest of rankloop keeps credentials in (hard rule 3
 * in the source repo), so a user who has set anything up before looks in
 * exactly one place. Everything has a default except `projectId` — the one
 * value nobody can guess. */

import { homedir } from "node:os";
import { join } from "node:path";

export interface WriteConfig {
  command: string;
  args: string[];
  /** Kill a generation that runs longer than this. A wedged CLI on a cron
   *  otherwise accumulates one stuck process per interval, forever. */
  timeoutMin: number;
}

export interface RepoConfig {
  path: string;
  /** Where post markdown lives, relative to the repo root. Matches the
   *  GitHub adapter's default so a repo scaffolded by rankloop needs no
   *  extra configuration. */
  contentDir: string;
  /** `https://mysite.com/blog` — the slug is appended to build the URL the
   *  runner verifies and reports. */
  urlBase: string;
  push: boolean;
  /** How long to poll the URL after pushing before giving up until the next
   *  run. Deploys are usually minutes; a laptop lid-close should not mean a
   *  report is silently skipped forever. */
  verifyTimeoutMin: number;
}

export interface LocalConfig {
  server: string;
  projectId: string;
  write: WriteConfig;
  repo: RepoConfig | null;
  outDir: string;
  /** Total generations per proposal: the first draft plus repairs. Mirrors
   *  the dashboard writer's ceiling so agent mode is not more expensive to
   *  reason about than API mode. */
  maxAttempts: number;
  /** The one thing a brief can spend money on. Off by default — cached
   *  grounding is free and usually present. */
  allowSerpFetch: boolean;
  maxPerRun: number;
}

export const CONFIG_PATH = join(homedir(), ".config", "rankloop", "local.json");
export const STATE_PATH = join(homedir(), ".config", "rankloop", "local-state.json");

export function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

const DEFAULTS = {
  server: "http://localhost:5173",
  write: { command: "claude", args: ["-p"], timeoutMin: 10 },
  outDir: "~/rankloop-drafts",
  maxAttempts: 3,
  allowSerpFetch: false,
  maxPerRun: 1,
} as const;

/** Merge file config and flags into a runnable config, or explain what is
 *  missing. Returns errors as data — the CLI decides how to print them. */
export function resolveConfig(
  fileConfig: Record<string, unknown> | null,
  flags: Partial<{
    server: string;
    project: string;
    out: string;
    max: number;
    buySerp: boolean;
  }>,
): { config: LocalConfig; errors: string[] } {
  const file = fileConfig ?? {};
  const errors: string[] = [];

  const projectId =
    flags.project ?? (typeof file.projectId === "string" ? file.projectId : "");
  if (projectId === "") {
    errors.push(
      `No project. Set "projectId" in ${CONFIG_PATH} or pass --project <id> — it is in the dashboard URL: /p/<id>.`,
    );
  }

  const writeRaw = (file.write ?? {}) as Partial<WriteConfig>;
  const repoRaw = file.repo as Partial<RepoConfig> | undefined;

  let repo: RepoConfig | null = null;
  if (repoRaw && typeof repoRaw.path === "string" && repoRaw.path !== "") {
    if (typeof repoRaw.urlBase !== "string" || repoRaw.urlBase === "") {
      // Without it the runner cannot know what URL to verify, and guessing a
      // URL to verify against defeats the point of verifying.
      errors.push(
        'repo.urlBase is required in repo mode — the public URL posts live under, e.g. "https://mysite.com/blog".',
      );
    } else {
      repo = {
        path: expandTilde(repoRaw.path),
        contentDir: repoRaw.contentDir ?? "content/blog",
        urlBase: repoRaw.urlBase.replace(/\/+$/, ""),
        push: repoRaw.push ?? true,
        verifyTimeoutMin: repoRaw.verifyTimeoutMin ?? 10,
      };
    }
  }

  return {
    errors,
    config: {
      server:
        flags.server ??
        (typeof file.server === "string" ? file.server : DEFAULTS.server),
      projectId,
      write: {
        command: writeRaw.command ?? DEFAULTS.write.command,
        args: Array.isArray(writeRaw.args) ? writeRaw.args : [...DEFAULTS.write.args],
        timeoutMin: writeRaw.timeoutMin ?? DEFAULTS.write.timeoutMin,
      },
      repo,
      outDir: expandTilde(
        flags.out ?? (typeof file.outDir === "string" ? file.outDir : DEFAULTS.outDir),
      ),
      maxAttempts:
        typeof file.maxAttempts === "number" ? file.maxAttempts : DEFAULTS.maxAttempts,
      allowSerpFetch:
        flags.buySerp ??
        (typeof file.allowSerpFetch === "boolean"
          ? file.allowSerpFetch
          : DEFAULTS.allowSerpFetch),
      maxPerRun: flags.max ?? DEFAULTS.maxPerRun,
    },
  };
}
