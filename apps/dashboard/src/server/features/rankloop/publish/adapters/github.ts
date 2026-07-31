import { AppError } from "@/server/lib/errors";
import type { GitHubAdapterConfig } from "./config";
import { GitHubApi } from "./githubApi";
import { absoluteUrl, repoPathFor } from "./paths.logic";
import type {
  AdapterNote,
  CreatePostInput,
  CreatedPost,
  DerivedArtifact,
  EnsuredHub,
  ExistingPost,
  OwnedBlockUpdate,
  PublishAdapter,
  PublishCapabilities,
  PublishHub,
  PublishRun,
} from "./types";

// The GitHub target: the adapter for sites that are a repository.
//
// This is the only target where the content is exactly what the engine reads
// — `--- frontmatter --- + body`, committed at the path the page type's
// urlPattern implies — so it is the only one where nothing is converted and
// nothing is lossy. It is also the only target where the derived artifacts
// (sitemap.xml, rss.xml, llms.txt, llms-full.txt) are ours to regenerate, and
// they go in the same pull request as the post that changed them, because a
// reviewer should see one change rather than two.
//
// A pull request is the default and a direct commit is opt-in. That is the
// same instinct as WordPress's draft default: on a repo, a commit to the
// default branch is a deploy nobody reviewed.

export const githubCapabilities: PublishCapabilities = {
  kind: "github",
  label: "your site's repository",
  // A pull request is this target's draft: the post exists, and a human
  // decides when it ships by merging.
  supportsDraft: true,
  createsHubs: true,
  linkInjection: "edits-pages",
  ownsDerivedArtifacts: true,
  publishedUrl: "computed",
  contentFormat: "markdown",
};

/** Frontmatter for a hub page. Hub stems are `index`, which the engine's
 *  markdown manifest skips, so a hub is never graded as a post — but the
 *  site's own template still reads these two fields. */
function hubMarkdown(hub: PublishHub): string {
  return [
    "---",
    `title: ${hub.name}`,
    `description: ${hub.description}`,
    "---",
    "",
    hub.description,
    "",
  ].join("\n");
}

/**
 * The connection probe: read the head of the base branch.
 *
 * Read-only on purpose — a target that rankloop is trusted to commit to should
 * not have to accept a write to prove the credential works. It answers all
 * three questions at once: the token authenticates, the repository is visible
 * to it, and the branch a pull request would target exists.
 */
export async function testGitHubConnection(
  config: GitHubAdapterConfig,
): Promise<void> {
  const sha = await GitHubApi.getBranchSha(config, config.baseBranch);
  if (sha === null) {
    throw new AppError(
      "PUBLISH_UNREACHABLE",
      `The ${config.baseBranch} branch doesn't exist in ${config.owner}/${config.repo}.`,
    );
  }
}

export function createGitHubAdapter(
  config: GitHubAdapterConfig,
  run: PublishRun,
): PublishAdapter {
  const direct = config.commitMode === "direct";
  // One branch per article, named from the slug so a resumed run reuses it
  // rather than opening a second pull request for the same post.
  const branch = direct ? config.baseBranch : `rankloop/publish-${run.slug}`;
  let branchReady = direct;

  async function ensureBranch(): Promise<void> {
    if (branchReady) return;
    const existing = await GitHubApi.getBranchSha(config, branch);
    if (existing === null) {
      const base = await GitHubApi.getBranchSha(config, config.baseBranch);
      if (base === null) {
        throw new AppError(
          "PUBLISH_UNREACHABLE",
          `The ${config.baseBranch} branch doesn't exist in ${config.owner}/${config.repo}.`,
        );
      }
      await GitHubApi.createBranch(config, branch, base);
    }
    branchReady = true;
  }

  /** Write one file, reading first so an existing file is replaced with its
   *  own sha rather than blindly created. Returns false when the bytes are
   *  already what we would write — a re-run should be an empty diff, not a
   *  commit that says nothing. */
  async function writeFile(
    path: string,
    text: string,
    message: string,
  ): Promise<boolean> {
    const existing = await GitHubApi.getFile(config, path, branch);
    if (existing?.text === text) return false;
    await GitHubApi.putFile(config, {
      path,
      branch,
      message,
      text,
      ...(existing === null ? {} : { sha: existing.sha }),
    });
    return true;
  }

  async function ensureHub(hub: PublishHub): Promise<EnsuredHub> {
    await ensureBranch();
    const path = repoPathFor(config.contentDir, hub.path, "hub");
    const existing = await GitHubApi.getFile(config, path, branch);
    if (existing) {
      return {
        ref: path,
        path: hub.path,
        url: absoluteUrl(config.siteUrl, hub.path),
        created: false,
        notes: [],
      };
    }
    await writeFile(
      path,
      hubMarkdown(hub),
      `rankloop: add the ${hub.name} hub`,
    );
    return {
      ref: path,
      path: hub.path,
      url: absoluteUrl(config.siteUrl, hub.path),
      created: true,
      notes: [`Created ${path} for the ${hub.name} hub.`],
    };
  }

  async function createPost(input: CreatePostInput): Promise<CreatedPost> {
    const { article } = input;
    await ensureBranch();
    const path = repoPathFor(config.contentDir, article.path, "post");
    const notes: AdapterNote[] = [];

    // The markdown goes in untouched: it is the exact text the laws graded,
    // and the engine parses the same bytes on the other side.
    const wrote = await writeFile(
      path,
      article.markdown,
      `rankloop: ${article.title}`,
    );
    if (!wrote) {
      notes.push(
        `${path} already held this article, so nothing was committed.`,
      );
    }

    const url = absoluteUrl(config.siteUrl, article.path);
    if (direct) {
      const head = await GitHubApi.getBranchSha(config, branch);
      notes.push(
        `Committed straight to ${config.baseBranch}. It goes live on your next deploy.`,
      );
      return {
        ref: head ?? branch,
        url,
        // Committed is not deployed. Marking it verified would claim the page
        // exists before anything has built it.
        urlConfidence: "unverified",
        notes,
      };
    }

    const existingPull = await GitHubApi.findOpenPull(config, branch);
    const pull =
      existingPull ??
      (await GitHubApi.createPull(config, {
        title: `rankloop: ${article.title}`,
        body: pullBody(input),
        branch,
      }));
    notes.push(
      existingPull
        ? `Added to the open pull request #${pull.number}.`
        : `Opened pull request #${pull.number}. The post goes live when you merge it.`,
    );
    return {
      ref: String(pull.number),
      url,
      urlConfidence: "unverified",
      notes,
    };
  }

  async function getPost(path: string): Promise<ExistingPost | null> {
    await ensureBranch();
    const repoPath = repoPathFor(config.contentDir, path, "post");
    const file = await GitHubApi.getFile(config, repoPath, branch);
    if (!file) return null;
    return { ref: repoPath, path, body: file.text };
  }

  /** The body arrives already merged (rule 2): the caller read this file
   *  through `getPost` and put rankloop's delimited block into it. This only
   *  commits what it was handed. */
  async function updatePost(update: OwnedBlockUpdate): Promise<void> {
    await ensureBranch();
    await writeFile(
      update.ref,
      update.body,
      `rankloop: link to ${update.path}`,
    );
  }

  async function commitArtifacts(input: {
    ref: string;
    artifacts: DerivedArtifact[];
  }): Promise<void> {
    // In pull-request mode a resumed run knows only the PR number, so the
    // branch comes back from the pull request itself.
    if (!branchReady && !direct) {
      const pullNumber = Number(input.ref);
      const head = Number.isNaN(pullNumber)
        ? null
        : await GitHubApi.getPullBranch(config, pullNumber);
      if (head !== null && head !== branch) {
        throw new AppError(
          "CONFLICT",
          `Pull request #${input.ref} is on ${head}, not ${branch}.`,
        );
      }
    }
    await ensureBranch();
    for (const artifact of input.artifacts) {
      // Guarded the same way repoPathFor guards contentDir: the field's own
      // help text tells a repo whose root IS the site root to leave publicDir
      // empty, and joining that blindly would commit to "/sitemap.xml" — a
      // leading slash the Contents API does not accept.
      const dir = config.publicDir.replace(/^\/+|\/+$/g, "");
      const file = artifact.path.replace(/^\/+/, "");
      const path = dir ? `${dir}/${file}` : file;
      await writeFile(
        path,
        artifact.content,
        `rankloop: regenerate ${artifact.path}`,
      );
    }
  }

  return {
    capabilities: githubCapabilities,
    ensureHub,
    createPost,
    getPost,
    updatePost,
    commitArtifacts,
  };
}

/** What the pull request says it is. A reviewer should be able to approve or
 *  close this without opening rankloop. */
function pullBody(input: CreatePostInput): string {
  const lines = [
    `**${input.article.title}**`,
    "",
    input.article.description,
    "",
    `- Keyword: ${input.article.keyword}`,
    `- Path: ${input.article.path}`,
  ];
  if (input.hub) lines.push(`- Hub: ${input.hub.path}`);
  if (input.links.length > 0) {
    lines.push(
      `- Links added from ${input.links.length} existing page${input.links.length === 1 ? "" : "s"}, inside the \`rankloop:related\` block only`,
    );
  }
  lines.push(
    "",
    "Generated by rankloop. Every change here is a new file or a block rankloop owns; delete the block and nothing breaks.",
  );
  return lines.join("\n");
}
