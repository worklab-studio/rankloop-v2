import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitHubAdapter } from "./github";
import {
  branchResponse,
  commitResponse,
  createInput,
  fileResponse,
  githubConfig,
  githubRun,
  jsonResponse,
  notFound,
  readCalls,
  writesOf,
  writtenText,
} from "./githubFixtures";
import type { GitHubCall } from "./githubFixtures";

// The GitHub target's two page-level writes: reading a neighbour so its owned
// block can be merged (rule 2), and regenerating the derived artifacts into
// the same pull request as the post that changed them.

const fetchMock = vi.fn<typeof fetch>();

function calls(): GitHubCall[] {
  return readCalls(fetchMock.mock.calls);
}

function writes(): GitHubCall[] {
  return writesOf(calls());
}

/** A run that resumes in a fresh process knows only its pull request number,
 *  so the branch has to come back from the pull request itself. */
const pullBranchResponse = () =>
  jsonResponse({ head: { ref: "rankloop/publish-aeropress-vs-v60" } });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHub adapter getPost and updatePost", () => {
  it("reads a neighbour's markdown so the owned block can be merged", async () => {
    fetchMock.mockResolvedValueOnce(branchResponse());
    fetchMock.mockResolvedValueOnce(
      fileResponse("---\ntitle: Tampers\n---\n\nBody."),
    );

    const post = await createGitHubAdapter(githubConfig, githubRun).getPost(
      "/blog/tampers/",
    );

    expect(post).toEqual({
      ref: "content/blog/tampers.md",
      path: "/blog/tampers/",
      body: "---\ntitle: Tampers\n---\n\nBody.",
    });
  });

  it("writes back exactly the merged body it was handed", async () => {
    fetchMock.mockResolvedValueOnce(branchResponse());
    fetchMock.mockResolvedValueOnce(fileResponse("old body"));
    fetchMock.mockResolvedValueOnce(commitResponse());

    const merged = [
      "old body",
      "",
      "<!-- rankloop:related start -->",
      "- [AeroPress vs V60](/compare/aeropress-vs-v60/)",
      "<!-- rankloop:related end -->",
    ].join("\n");
    await createGitHubAdapter(githubConfig, githubRun).updatePost({
      ref: "content/blog/tampers.md",
      path: "/blog/tampers/",
      body: merged,
    });

    const write = writes()[0];
    expect(write?.url).toContain("/contents/content/blog/tampers.md");
    expect(write && writtenText(write)).toBe(merged);
    expect(write?.json.sha).toBe("sha-existing");
  });
});

describe("GitHub adapter commitArtifacts", () => {
  it("puts the derived artifacts under the public root on the same branch", async () => {
    fetchMock.mockResolvedValueOnce(pullBranchResponse());
    fetchMock.mockResolvedValueOnce(branchResponse());
    fetchMock.mockResolvedValueOnce(notFound());
    fetchMock.mockResolvedValueOnce(commitResponse());
    fetchMock.mockResolvedValueOnce(fileResponse("stale rss"));
    fetchMock.mockResolvedValueOnce(commitResponse());

    await createGitHubAdapter(githubConfig, githubRun).commitArtifacts?.({
      ref: "7",
      artifacts: [
        { path: "/sitemap.xml", content: "<urlset/>" },
        { path: "/rss.xml", content: "<rss/>" },
      ],
    });

    expect(writes().map((call) => call.url)).toEqual([
      "https://api.github.com/repos/beans/beans.coffee/contents/public/sitemap.xml",
      "https://api.github.com/repos/beans/beans.coffee/contents/public/rss.xml",
    ]);
    expect(
      writes().every(
        (call) => call.json.branch === "rankloop/publish-aeropress-vs-v60",
      ),
    ).toBe(true);
  });

  it("commits to the repo root when publicDir is empty, as its help text invites", async () => {
    fetchMock.mockResolvedValueOnce(pullBranchResponse());
    fetchMock.mockResolvedValueOnce(branchResponse());
    fetchMock.mockResolvedValueOnce(notFound());
    fetchMock.mockResolvedValueOnce(commitResponse());

    await createGitHubAdapter(
      { ...githubConfig, publicDir: "" },
      githubRun,
    ).commitArtifacts?.({
      ref: "7",
      artifacts: [{ path: "/sitemap.xml", content: "<urlset/>" }],
    });

    // Not "/contents//sitemap.xml" and not "/contents/sitemap.xml" by luck —
    // the joined path has to lose the leading slash the artifact carries.
    expect(writes().map((call) => call.url)).toEqual([
      "https://api.github.com/repos/beans/beans.coffee/contents/sitemap.xml",
    ]);
  });

  it("skips an artifact that is already byte-identical, so a re-run is an empty diff", async () => {
    fetchMock.mockResolvedValueOnce(pullBranchResponse());
    fetchMock.mockResolvedValueOnce(branchResponse());
    fetchMock.mockResolvedValueOnce(fileResponse("<urlset/>"));

    await createGitHubAdapter(githubConfig, githubRun).commitArtifacts?.({
      ref: "7",
      artifacts: [{ path: "/sitemap.xml", content: "<urlset/>" }],
    });

    expect(writes()).toHaveLength(0);
  });

  it("refuses to write into a pull request that is on someone else's branch", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ head: { ref: "feature/redesign" } }),
    );

    await expect(
      createGitHubAdapter(githubConfig, githubRun).commitArtifacts?.({
        ref: "7",
        artifacts: [{ path: "/sitemap.xml", content: "<urlset/>" }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(writes()).toHaveLength(0);
  });

  it("keeps using the branch it already opened, without re-reading the pull request", async () => {
    fetchMock.mockResolvedValueOnce(branchResponse());
    fetchMock.mockResolvedValueOnce(notFound());
    fetchMock.mockResolvedValueOnce(commitResponse());
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        number: 7,
        html_url: "https://github.com/beans/x/pull/7",
      }),
    );
    fetchMock.mockResolvedValueOnce(notFound());
    fetchMock.mockResolvedValueOnce(commitResponse());

    const adapter = createGitHubAdapter(githubConfig, githubRun);
    const created = await adapter.createPost(createInput());
    await adapter.commitArtifacts?.({
      ref: created.ref,
      artifacts: [{ path: "/llms.txt", content: "# beans" }],
    });

    expect(calls().some((call) => call.url.endsWith("/pulls/7"))).toBe(false);
    expect(writes().at(-1)?.url).toContain("/contents/public/llms.txt");
  });
});
