import { z } from "zod";
import { AppError } from "@/server/lib/errors";
import type { GitHubAdapterConfig } from "./config";

// The GitHub REST surface this adapter needs, and nothing more: refs, file
// contents, and pull requests. Deliberately the Contents API rather than the
// blob/tree plumbing — one commit per file is a readable PR, and the same
// endpoint reads a file as writes it, which is what rule 2 needs (read the
// page, merge rankloop's block, write it back).
//
// No token ever appears in a thrown message. Failures carry a path and a
// status code, the same contract as the WordPress client.

const API = "https://api.github.com";

type Method = "GET" | "POST" | "PUT";

async function ghFetch(
  config: GitHubAdapterConfig,
  path: string,
  init?: { method?: Method; body?: unknown; allowNotFound?: boolean },
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        // GitHub rejects requests without one; naming the product makes our
        // traffic legible in a repo's audit log.
        "User-Agent": "rankloop",
        ...(init?.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new AppError("PUBLISH_UNREACHABLE", `Could not reach GitHub${path}.`);
  }
  if (response.status === 404 && init?.allowNotFound) return null;
  if (response.status === 401 || response.status === 403) {
    throw new AppError(
      "PUBLISH_AUTH_FAILED",
      `GitHub returned ${response.status} for ${path}.`,
    );
  }
  if (!response.ok) {
    throw new AppError(
      "PUBLISH_UNREACHABLE",
      `GitHub returned ${response.status} for ${path}.`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new AppError(
      "PUBLISH_UNREACHABLE",
      `Non-JSON response from ${path}.`,
    );
  }
}

function repoPath(config: GitHubAdapterConfig, suffix: string): string {
  return `/repos/${config.owner}/${config.repo}${suffix}`;
}

function parseOrThrow<T>(schema: z.ZodType<T>, payload: unknown, path: string) {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new AppError(
      "PUBLISH_UNREACHABLE",
      `Unexpected response shape from ${path}.`,
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

const refSchema = z.object({ object: z.object({ sha: z.string() }) });

/** Null when the branch does not exist yet. */
async function getBranchSha(
  config: GitHubAdapterConfig,
  branch: string,
): Promise<string | null> {
  const path = repoPath(config, `/git/ref/heads/${branch}`);
  const payload = await ghFetch(config, path, { allowNotFound: true });
  if (payload === null) return null;
  return parseOrThrow(refSchema, payload, path).object.sha;
}

async function createBranch(
  config: GitHubAdapterConfig,
  branch: string,
  fromSha: string,
): Promise<void> {
  await ghFetch(config, repoPath(config, "/git/refs"), {
    method: "POST",
    body: { ref: `refs/heads/${branch}`, sha: fromSha },
  });
}

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

const fileSchema = z.object({
  sha: z.string(),
  content: z.string(),
  encoding: z.string(),
});

const commitSchema = z.object({
  commit: z.object({ sha: z.string() }),
});

export function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeBase64(encoded: string): string {
  const binary = atob(encoded.replace(/\s/g, ""));
  return new TextDecoder().decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}

type RepoFile = { path: string; sha: string; text: string };

/** Null when the path holds no file on that branch. */
async function getFile(
  config: GitHubAdapterConfig,
  filePath: string,
  branch: string,
): Promise<RepoFile | null> {
  const path = repoPath(
    config,
    `/contents/${filePath}?ref=${encodeURIComponent(branch)}`,
  );
  const payload = await ghFetch(config, path, { allowNotFound: true });
  if (payload === null) return null;
  const file = fileSchema.safeParse(payload);
  // A directory answers with an array, not an object — same "no file here".
  if (!file.success || file.data.encoding !== "base64") return null;
  return {
    path: filePath,
    sha: file.data.sha,
    text: decodeBase64(file.data.content),
  };
}

/** Create or replace one file. `sha` is required by GitHub for a replace and
 *  must be absent for a create; passing the wrong one is how a concurrent
 *  edit gets clobbered, so callers read first. */
async function putFile(
  config: GitHubAdapterConfig,
  input: {
    path: string;
    branch: string;
    message: string;
    text: string;
    sha?: string;
  },
): Promise<string> {
  const path = repoPath(config, `/contents/${input.path}`);
  const payload = await ghFetch(config, path, {
    method: "PUT",
    body: {
      message: input.message,
      content: encodeBase64(input.text),
      branch: input.branch,
      ...(input.sha === undefined ? {} : { sha: input.sha }),
    },
  });
  return parseOrThrow(commitSchema, payload, path).commit.sha;
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

const pullSchema = z.object({
  number: z.number().int(),
  html_url: z.string(),
});

type PullRequest = { number: number; url: string };

/** The open PR for a head branch, if this run already opened one. Reusing it
 *  is what keeps a resumed workflow from opening a second PR for the same
 *  article. */
async function findOpenPull(
  config: GitHubAdapterConfig,
  branch: string,
): Promise<PullRequest | null> {
  const path = repoPath(
    config,
    `/pulls?state=open&head=${encodeURIComponent(`${config.owner}:${branch}`)}`,
  );
  const payload = await ghFetch(config, path);
  const pulls = parseOrThrow(z.array(pullSchema), payload, path);
  const pull = pulls[0];
  return pull ? { number: pull.number, url: pull.html_url } : null;
}

/** The head branch of a pull request, so a run that resumes in a fresh
 *  process can find the branch its own PR number points at. */
async function getPullBranch(
  config: GitHubAdapterConfig,
  number: number,
): Promise<string | null> {
  const path = repoPath(config, `/pulls/${number}`);
  const payload = await ghFetch(config, path, { allowNotFound: true });
  if (payload === null) return null;
  const schema = z.object({ head: z.object({ ref: z.string() }) });
  return parseOrThrow(schema, payload, path).head.ref;
}

async function createPull(
  config: GitHubAdapterConfig,
  input: { title: string; body: string; branch: string },
): Promise<PullRequest> {
  const path = repoPath(config, "/pulls");
  const payload = await ghFetch(config, path, {
    method: "POST",
    body: {
      title: input.title,
      body: input.body,
      head: input.branch,
      base: config.baseBranch,
    },
  });
  const pull = parseOrThrow(pullSchema, payload, path);
  return { number: pull.number, url: pull.html_url };
}

export const GitHubApi = {
  getBranchSha,
  createBranch,
  getFile,
  putFile,
  findOpenPull,
  getPullBranch,
  createPull,
};
