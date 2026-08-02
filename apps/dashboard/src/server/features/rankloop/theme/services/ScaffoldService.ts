import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { GitHubApi } from "@/server/features/rankloop/publish/adapters/githubApi";
import { PublishConnectionService } from "@/server/features/rankloop/publish/services/PublishConnectionService";
import { VerdictRepository } from "@/server/features/rankloop/verdict/repositories/VerdictRepository";
import { buildScaffold } from "@/server/features/rankloop/theme/scaffold.logic";
import {
  detectStack,
  planWrites,
  pullRequestBody,
  PROBE_PATHS,
  stackLabel,
  type StackDetection,
} from "@/server/features/rankloop/theme/stack.logic";
import {
  extractTheme,
  lowConfidenceTokens,
  type SiteTheme,
} from "@/server/features/rankloop/theme/theme.logic";
import type { GitHubAdapterConfig } from "@/server/features/rankloop/publish/adapters/config";
import { AppError } from "@/server/lib/errors";

// Repo mode (spec 0030): probe the repo, build the scaffold, open the PR.
//
// The pure halves are tested exhaustively next door. What lives here is the
// I/O and the one invariant that cannot be expressed in a pure function:
// nothing is ever committed to the default branch.

export type FetchImpl = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

const CRAWL_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/**
 * Fetch a few pages and derive the theme.
 *
 * Three pages rather than one: a homepage is often the least representative
 * page on a site, and a token that appears across pages is a system while
 * one that appears on the homepage alone is a hero section.
 */
async function extractSiteTheme(
  projectId: string,
  fetchImpl: FetchImpl = globalThis.fetch.bind(globalThis),
): Promise<{ theme: SiteTheme; pagesRead: number; needsReview: string[] }> {
  const site = await VerdictRepository.getProjectSite(projectId);
  if (!site) throw new AppError("NOT_FOUND", "Project has no domain");

  const origin = /^https?:\/\//i.test(site.domain)
    ? site.domain
    : `https://${site.domain}`;
  const corpus = await VerdictRepository.getCorpusForLlmsTxt(projectId, 3);
  const urls = corpus.length > 0 ? corpus.map((p) => p.url) : [origin];

  const pages: string[] = [];
  for (const url of urls.slice(0, 3)) {
    try {
      const res = await fetchImpl(url, {
        headers: { "user-agent": CRAWL_UA },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status < 400) pages.push(await res.text());
    } catch {
      // One unreachable page is not a failed extraction. The theme is
      // derived from whatever we could read, and `pagesRead` says how much
      // that was so the confidence can be argued with.
    }
  }

  const theme = extractTheme(pages);
  return { theme, pagesRead: pages.length, needsReview: lowConfidenceTokens(theme) };
}

// ---------------------------------------------------------------------------
// Repo
// ---------------------------------------------------------------------------

async function githubConfig(projectId: string): Promise<GitHubAdapterConfig> {
  const config = await PublishConnectionService.getDecryptedGitHubConfig(projectId);
  if (!config) {
    throw new AppError(
      "PUBLISH_NOT_CONNECTED",
      "Connect a GitHub repository in Publishing settings before scaffolding a blog.",
    );
  }
  return config;
}

/** Which of the probe paths exist. One `getFile` per path, and the list is
 *  deliberately short — see PROBE_PATHS. */
async function probeRepo(config: GitHubAdapterConfig): Promise<{
  probe: Record<string, boolean>;
  packageJson: string | null;
}> {
  const entries = await Promise.all(
    PROBE_PATHS.map(async (path) => {
      try {
        const file = await GitHubApi.getFile(config, path, config.baseBranch);
        return [path, file] as const;
      } catch {
        return [path, null] as const;
      }
    }),
  );

  const probe: Record<string, boolean> = {};
  let packageJson: string | null = null;
  for (const [path, file] of entries) {
    probe[path] = file !== null;
    if (path === "package.json" && file) packageJson = file.text;
  }
  return { probe, packageJson };
}

export interface ScaffoldPreview {
  stack: StackDetection;
  stackLabel: string;
  theme: SiteTheme;
  needsReview: string[];
  files: { path: string; purpose: string; exists: boolean }[];
  requiredDependency: string | null;
  /** Null when we could not identify the stack — the UI shows why rather
   *  than a disabled button with no explanation. */
  blocked: string | null;
}

/** Everything the PR would do, without doing any of it. */
async function preview(projectId: string): Promise<ScaffoldPreview> {
  const config = await githubConfig(projectId);
  const site = await VerdictRepository.getProjectSite(projectId);
  const [{ probe, packageJson }, { theme, needsReview }] = await Promise.all([
    probeRepo(config),
    extractSiteTheme(projectId),
  ]);

  const stack = detectStack(probe);
  const { files, requiredDependency } = buildScaffold({
    stack: stack.stack,
    blogPath: site?.blogPath ?? "blog",
    theme,
    packageJson,
  });

  const existing = new Set(Object.entries(probe).filter(([, v]) => v).map(([k]) => k));
  const { write, skipped } = planWrites(files, existing);

  return {
    stack,
    stackLabel: stackLabel(stack.stack),
    theme,
    needsReview,
    files: [
      ...write.map((f) => ({ path: f.path, purpose: f.purpose, exists: false })),
      ...skipped.map((f) => ({ path: f.path, purpose: f.purpose, exists: true })),
    ],
    requiredDependency,
    blocked:
      stack.stack === "unknown"
        ? "rankloop could not tell what this repository is built with, so it will not guess. Open an issue with your framework and we will add it."
        : files.length === 0
          ? "Nothing to add."
          : null,
  };
}

// ---------------------------------------------------------------------------
// The PR
// ---------------------------------------------------------------------------

const SCAFFOLD_BRANCH = "rankloop/blog-scaffold";

/**
 * Open the scaffold pull request.
 *
 * Never commits to the base branch. The branch name is fixed rather than
 * timestamped so re-running reuses the same PR instead of opening a second
 * one, which is what a user expects from a button they may press twice.
 */
async function openScaffoldPull(projectId: string): Promise<{
  url: string;
  written: string[];
  skipped: string[];
}> {
  const config = await githubConfig(projectId);
  const site = await VerdictRepository.getProjectSite(projectId);
  const [{ probe, packageJson }, { theme, needsReview }] = await Promise.all([
    probeRepo(config),
    extractSiteTheme(projectId),
  ]);

  const stack = detectStack(probe);
  const { files, requiredDependency } = buildScaffold({
    stack: stack.stack,
    blogPath: site?.blogPath ?? "blog",
    theme,
    packageJson,
  });
  if (files.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "rankloop could not identify this repository's framework, so it will not scaffold a blog into it.",
    );
  }

  const existing = new Set(Object.entries(probe).filter(([, v]) => v).map(([k]) => k));
  const { write, skipped } = planWrites(files, existing);
  if (write.length === 0) {
    throw new AppError(
      "CONFLICT",
      "Every file the scaffold would add already exists. Nothing to do.",
    );
  }

  const baseSha = await GitHubApi.getBranchSha(config, config.baseBranch);
  if (!baseSha) {
    throw new AppError(
      "VALIDATION_ERROR",
      `The ${config.baseBranch} branch doesn't exist in ${config.owner}/${config.repo}.`,
    );
  }
  const branchSha = await GitHubApi.getBranchSha(config, SCAFFOLD_BRANCH);
  if (!branchSha) {
    await GitHubApi.createBranch(config, SCAFFOLD_BRANCH, baseSha);
  }

  for (const file of write) {
    await GitHubApi.putFile(config, {
      path: file.path,
      text: file.content,
      message: `rankloop: add ${file.path}`,
      branch: SCAFFOLD_BRANCH,
    });
  }

  const body = [
    pullRequestBody({
      stack: stack.stack,
      written: write,
      skipped,
      themeSummary: themeSummaryOf(theme),
      needsReview,
    }),
    ...(requiredDependency
      ? [
          "",
          "### One dependency",
          `The post page renders markdown with \`${requiredDependency}\`, which this repo does not have yet:`,
          "",
          "```bash",
          `npm install ${requiredDependency}`,
          "```",
        ]
      : []),
  ].join("\n");

  // Reuse the open PR if there is one. The branch name is fixed, so a user
  // who presses the button twice gets the same pull request updated rather
  // than a second one to close.
  const existingPull = await GitHubApi.findOpenPull(config, SCAFFOLD_BRANCH);
  const pull =
    existingPull ??
    (await GitHubApi.createPull(config, {
      title: "rankloop: add a blog",
      branch: SCAFFOLD_BRANCH,
      body,
    }));

  return {
    url: pull.url,
    written: write.map((f) => f.path),
    skipped: skipped.map((f) => f.path),
  };
}

function themeSummaryOf(theme: SiteTheme) {
  return [
    { name: "Background", value: theme.colors.background.value, confidence: theme.colors.background.confidence },
    { name: "Text", value: theme.colors.foreground.value, confidence: theme.colors.foreground.confidence },
    { name: "Accent", value: theme.colors.accent.value, confidence: theme.colors.accent.confidence },
    { name: "Border", value: theme.colors.border.value, confidence: theme.colors.border.confidence },
    { name: "Heading font", value: theme.fonts.heading.value, confidence: theme.fonts.heading.confidence },
    { name: "Body font", value: theme.fonts.body.value, confidence: theme.fonts.body.confidence },
    { name: "Corner radius", value: theme.radius.value, confidence: theme.radius.confidence },
    { name: "Content width", value: theme.containerWidth.value, confidence: theme.containerWidth.confidence },
  ];
}

/** Theme extraction alone, for the Design screen — works with no repo at
 *  all, which is what a Framer or Webflow site gets. */
async function getTheme(projectId: string) {
  const [project] = await db
    .select({ domain: projects.domain })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const result = await extractSiteTheme(projectId);
  return { ...result, domain: project?.domain ?? null, summary: themeSummaryOf(result.theme) };
}

export const ScaffoldService = {
  getTheme,
  preview,
  openScaffoldPull,
};
