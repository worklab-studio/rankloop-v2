import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitHubAdapter } from "./github";
import {
  articleMarkdown,
  branchResponse,
  commitResponse,
  createInput,
  fileResponse,
  githubArticle,
  githubConfig,
  githubHub,
  githubRun,
  jsonResponse,
  notFound,
  readCalls,
  writesOf,
  writtenText,
} from "./githubFixtures";
import type { GitHubCall } from "./githubFixtures";

const fetchMock = vi.fn<typeof fetch>();

function calls(): GitHubCall[] {
  return readCalls(fetchMock.mock.calls);
}

function writes(): GitHubCall[] {
  return writesOf(calls());
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHub adapter capabilities", () => {
  it("is the only target that owns the derived artifacts", () => {
    const adapter = createGitHubAdapter(githubConfig, githubRun);
    expect(adapter.capabilities).toMatchObject({
      kind: "github",
      ownsDerivedArtifacts: true,
      contentFormat: "markdown",
      publishedUrl: "computed",
    });
    expect(typeof adapter.commitArtifacts).toBe("function");
  });
});

describe("GitHub adapter branch handling", () => {
  it("branches from the base branch on the first write, named for the article", async () => {
    fetchMock.mockResolvedValueOnce(notFound()); // the rankloop branch
    fetchMock.mockResolvedValueOnce(branchResponse("base-1"));
    fetchMock.mockResolvedValueOnce(jsonResponse({ ref: "created" }));
    fetchMock.mockResolvedValueOnce(notFound()); // no hub file yet
    fetchMock.mockResolvedValueOnce(notFound()); // writeFile reads again
    fetchMock.mockResolvedValueOnce(commitResponse());

    await createGitHubAdapter(githubConfig, githubRun).ensureHub(githubHub);

    const created = calls()[2];
    expect(created?.url).toBe(
      "https://api.github.com/repos/beans/beans.coffee/git/refs",
    );
    expect(created?.json).toEqual({
      ref: "refs/heads/rankloop/publish-aeropress-vs-v60",
      sha: "base-1",
    });
  });

  it("reuses a branch a resumed run already made", async () => {
    fetchMock.mockResolvedValueOnce(branchResponse());
    fetchMock.mockResolvedValueOnce(notFound());
    fetchMock.mockResolvedValueOnce(notFound());
    fetchMock.mockResolvedValueOnce(commitResponse());

    await createGitHubAdapter(githubConfig, githubRun).ensureHub(githubHub);

    expect(calls().some((call) => call.url.endsWith("/git/refs"))).toBe(false);
  });

  it("refuses to invent a base branch that does not exist", async () => {
    fetchMock.mockResolvedValueOnce(notFound());
    fetchMock.mockResolvedValueOnce(notFound());

    await expect(
      createGitHubAdapter(githubConfig, githubRun).ensureHub(githubHub),
    ).rejects.toMatchObject({ code: "PUBLISH_UNREACHABLE" });
  });
});

describe("GitHub adapter ensureHub", () => {
  it("commits the hub as the directory's index, which the engine skips", async () => {
    fetchMock.mockResolvedValueOnce(branchResponse());
    fetchMock.mockResolvedValueOnce(notFound());
    fetchMock.mockResolvedValueOnce(notFound());
    fetchMock.mockResolvedValueOnce(commitResponse());

    const result = await createGitHubAdapter(githubConfig, githubRun).ensureHub(
      githubHub,
    );

    const write = writes()[0];
    expect(write?.url).toBe(
      "https://api.github.com/repos/beans/beans.coffee/contents/content/compare/index.md",
    );
    expect(write?.json.branch).toBe("rankloop/publish-aeropress-vs-v60");
    expect(write?.json).not.toHaveProperty("sha");
    expect(write && writtenText(write)).toContain("title: Comparisons");
    expect(result).toMatchObject({
      ref: "content/compare/index.md",
      url: "https://beans.coffee/compare/",
      created: true,
    });
  });

  it("leaves an existing hub file untouched", async () => {
    fetchMock.mockResolvedValueOnce(branchResponse());
    fetchMock.mockResolvedValueOnce(
      fileResponse("---\ntitle: Comparisons\n---"),
    );

    const result = await createGitHubAdapter(githubConfig, githubRun).ensureHub(
      githubHub,
    );

    expect(writes()).toHaveLength(0);
    expect(result).toMatchObject({ created: false, notes: [] });
  });
});

describe("GitHub adapter createPost", () => {
  it("commits the gated markdown byte for byte at the path the pattern implies", async () => {
    fetchMock.mockResolvedValueOnce(branchResponse());
    fetchMock.mockResolvedValueOnce(notFound());
    fetchMock.mockResolvedValueOnce(commitResponse());
    fetchMock.mockResolvedValueOnce(jsonResponse([])); // no open PR
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        number: 7,
        html_url: "https://github.com/beans/x/pull/7",
      }),
    );

    const result = await createGitHubAdapter(
      githubConfig,
      githubRun,
    ).createPost(createInput());

    const write = writes()[0];
    expect(write?.url).toBe(
      "https://api.github.com/repos/beans/beans.coffee/contents/content/compare/aeropress-vs-v60.md",
    );
    expect(write && writtenText(write)).toBe(articleMarkdown);
    expect(result).toMatchObject({
      ref: "7",
      url: "https://beans.coffee/compare/aeropress-vs-v60/",
      // Committed is not deployed, and a pull request is not merged.
      urlConfidence: "unverified",
    });
  });

  it("opens the pull request against the base branch with the article in it", async () => {
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

    await createGitHubAdapter(githubConfig, githubRun).createPost(
      createInput({
        hub: {
          name: "Comparisons",
          path: "/compare/",
          ref: "content/compare/index.md",
        },
        links: [
          {
            fromPath: "/blog/tampers/",
            toPath: githubArticle.path,
            anchor: "AeroPress vs V60",
          },
        ],
      }),
    );

    const pull = calls().at(-1);
    expect(pull?.url).toBe(
      "https://api.github.com/repos/beans/beans.coffee/pulls",
    );
    expect(pull?.json).toMatchObject({
      title: "rankloop: AeroPress vs V60",
      head: "rankloop/publish-aeropress-vs-v60",
      base: "main",
    });
    const prBody = pull?.json.body;
    const body = typeof prBody === "string" ? prBody : "";
    expect(body).toContain("- Path: /compare/aeropress-vs-v60/");
    expect(body).toContain("- Hub: /compare/");
    expect(body).toContain("rankloop:related");
  });

  it("adds to the open pull request instead of opening a second one", async () => {
    fetchMock.mockResolvedValueOnce(branchResponse());
    fetchMock.mockResolvedValueOnce(fileResponse("older draft"));
    fetchMock.mockResolvedValueOnce(commitResponse());
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        { number: 7, html_url: "https://github.com/beans/x/pull/7" },
      ]),
    );

    const result = await createGitHubAdapter(
      githubConfig,
      githubRun,
    ).createPost(createInput());

    expect(calls().some((call) => call.url.endsWith("/pulls"))).toBe(false);
    expect(result.ref).toBe("7");
    expect(result.notes).toContain("Added to the open pull request #7.");
    // Replacing a file needs its sha; creating one must not send it.
    expect(writes()[0]?.json.sha).toBe("sha-existing");
  });

  it("commits nothing when the file already holds this exact article", async () => {
    fetchMock.mockResolvedValueOnce(branchResponse());
    fetchMock.mockResolvedValueOnce(fileResponse(articleMarkdown));
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        { number: 7, html_url: "https://github.com/beans/x/pull/7" },
      ]),
    );

    const result = await createGitHubAdapter(
      githubConfig,
      githubRun,
    ).createPost(createInput());

    expect(writes()).toHaveLength(0);
    expect(result.notes.join(" ")).toContain("already held this article");
  });

  it("commits straight to the base branch when direct mode is opted into", async () => {
    fetchMock.mockResolvedValueOnce(notFound());
    fetchMock.mockResolvedValueOnce(commitResponse());
    fetchMock.mockResolvedValueOnce(branchResponse("head-2"));

    const result = await createGitHubAdapter(
      { ...githubConfig, commitMode: "direct" },
      githubRun,
    ).createPost(createInput());

    expect(calls().some((call) => call.url.includes("/git/refs"))).toBe(false);
    expect(calls().some((call) => call.url.endsWith("/pulls"))).toBe(false);
    expect(writes()[0]?.json.branch).toBe("main");
    expect(result).toMatchObject({
      ref: "head-2",
      urlConfidence: "unverified",
    });
    expect(result.notes.join(" ")).toContain("Committed straight to main");
  });

  it("maps a bad token to PUBLISH_AUTH_FAILED without echoing it", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "Bad credentials" }, 401),
    );

    const error = await createGitHubAdapter(githubConfig, githubRun)
      .createPost(createInput())
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "PUBLISH_AUTH_FAILED" });
    expect(String(error)).not.toContain(githubConfig.token);
  });
});
