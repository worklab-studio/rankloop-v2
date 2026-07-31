// One repo, one article, and the GitHub responses that stand in for it.
// Shared by the two GitHub contract test files so both prove the adapter
// against the same fixture site rather than two slightly different ones.

import type { GitHubAdapterConfig } from "./config";
import { decodeBase64, encodeBase64 } from "./githubApi";
import { jsonBodyOf, recordedCalls } from "./fetchRecorder";
import type { FetchCall } from "./fetchRecorder";
import type { CreatePostInput, PublishHub } from "./types";

export const githubConfig: GitHubAdapterConfig = {
  owner: "beans",
  repo: "beans.coffee",
  token: "ghp_notarealtoken",
  baseBranch: "main",
  contentDir: "content",
  publicDir: "public",
  commitMode: "pull-request",
  siteUrl: "https://beans.coffee",
  defaultPostStatus: "draft",
  linkInjection: true,
};

export const articleMarkdown = [
  "---",
  "title: AeroPress vs V60",
  "description: Which brewer suits which morning.",
  "date: 2026-08-01",
  "category: Comparisons",
  "keyword: aeropress vs v60",
  "---",
  "",
  "Both brewers make a clean cup.",
].join("\n");

export const githubArticle = {
  slug: "aeropress-vs-v60",
  title: "AeroPress vs V60",
  description: "Which brewer suits which morning.",
  date: "2026-08-01",
  category: "Comparisons",
  keyword: "aeropress vs v60",
  path: "/compare/aeropress-vs-v60/",
  markdown: articleMarkdown,
};

export const githubHub: PublishHub = {
  name: "Comparisons",
  path: "/compare/",
  slug: "compare",
  description: "Every head-to-head comparison on this site.",
};

export const githubRun = { slug: githubArticle.slug };

export function createInput(
  overrides: Partial<CreatePostInput> = {},
): CreatePostInput {
  return { article: githubArticle, hub: null, links: [], ...overrides };
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const notFound = () => jsonResponse({ message: "Not Found" }, 404);

export const branchResponse = (sha = "head-1") =>
  jsonResponse({ object: { sha } });

export const commitResponse = () =>
  jsonResponse({ commit: { sha: "sha-new" } });

export function fileResponse(text: string, sha = "sha-existing"): Response {
  return jsonResponse({ sha, encoding: "base64", content: encodeBase64(text) });
}

// ---------------------------------------------------------------------------
// Reading the mock back
// ---------------------------------------------------------------------------

export type GitHubCall = FetchCall & { json: Record<string, unknown> };

export function readCalls(mockCalls: Parameters<typeof fetch>[]): GitHubCall[] {
  return recordedCalls(mockCalls).map((call) => ({
    ...call,
    json: call.body === null ? {} : jsonBodyOf(call),
  }));
}

/** Every file write the adapter made, in order. */
export function writesOf(calls: GitHubCall[]): GitHubCall[] {
  return calls.filter((call) => call.method === "PUT");
}

export function writtenText(call: GitHubCall): string {
  const content = call.json.content;
  if (typeof content !== "string") {
    throw new Error(`no base64 content in the write to ${call.url}`);
  }
  return decodeBase64(content);
}
