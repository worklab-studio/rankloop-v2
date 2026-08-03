// The small pure pieces: MCP framing, draft recovery, state transitions,
// config resolution, argv. Each block's cases are the ways the real world
// already deviated from the happy path.

import { describe, expect, it } from "vitest";
import { parseArgs, parseEvery } from "../src/cli.ts";
import { resolveConfig } from "../src/config.ts";
import { buildRetryPrompt, cleanDraft, failedLawsTable } from "../src/draft.ts";
import { parseBody } from "../src/mcp.ts";
import { advance, parseState, resumePoint, type RunnerState } from "../src/state.ts";
import { runWriter } from "../src/spawn.ts";

describe("mcp: parseBody()", () => {
  it("reads a plain JSON body", () => {
    expect(parseBody('{"jsonrpc":"2.0","id":1,"result":{}}')).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });
  });

  it("reads an SSE-framed body, taking the last data frame", () => {
    // The streamable-HTTP transport may answer with text/event-stream even
    // for a single response; earlier frames are progress.
    const sse = [
      "event: message",
      'data: {"progress":1}',
      "",
      "event: message",
      'data: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}',
      "",
    ].join("\n");
    expect(parseBody(sse)).toEqual({ jsonrpc: "2.0", id: 2, result: { ok: true } });
  });

  it("returns null for an empty body", () => {
    expect(parseBody("")).toBeNull();
  });
});

describe("draft: cleanDraft()", () => {
  const FILE = "---\ntitle: T\n---\n\nBody.";

  it("passes a clean file through", () => {
    expect(cleanDraft(FILE)).toBe(FILE + "\n");
  });

  it("unwraps a code fence", () => {
    // Models do this no matter what the contract says. Recovering the file
    // is cheaper than a retry, and a retry over formatting teaches the user
    // the runner is flaky.
    expect(cleanDraft("```markdown\n" + FILE + "\n```")).toBe(FILE + "\n");
  });

  it("cuts chatter before the frontmatter", () => {
    expect(cleanDraft("Here is the article you asked for:\n\n" + FILE)).toBe(FILE + "\n");
  });

  it("leaves a draft with no frontmatter for the laws to name precisely", () => {
    expect(cleanDraft("just a body")).toBe("just a body\n");
  });
});

describe("draft: the repair prompt", () => {
  it("carries only the failed laws, with threshold and observed", () => {
    const table = failedLawsTable([
      { law: "word count >= 850", passed: false, threshold: "850", observed: "310" },
      { law: "em dash", passed: true },
    ]);
    expect(table).toContain("word count >= 850");
    expect(table).toContain("need: 850");
    expect(table).toContain("got: 310");
    expect(table).not.toContain("em dash");
  });

  it("tells the model to keep what passed", () => {
    // Asked to rewrite freely, a model helpfully rewrites the sections that
    // already passed, and the next check fails on something new.
    expect(buildRetryPrompt("draft", [])).toContain("keep everything that already passed");
  });
});

describe("state", () => {
  const NOW = "2026-08-03T10:00:00.000Z";

  it("only moves forward — a crash cannot un-happen a push", () => {
    let state: RunnerState = {};
    state = advance(state, "p", { phase: "pushed", slug: "s", file: "/f" }, NOW);
    state = advance(state, "p", { phase: "written", slug: "s", file: "/f" }, NOW);
    expect(state.p?.phase).toBe("pushed");
  });

  it("maps each phase to its resume step", () => {
    const base = { slug: "s", file: "/f", updatedAt: NOW };
    expect(resumePoint({}, "p").step).toBe("write");
    expect(resumePoint({ p: { ...base, phase: "written" } }, "p").step).toBe("commit");
    expect(resumePoint({ p: { ...base, phase: "pushed" } }, "p").step).toBe("verify");
    expect(resumePoint({ p: { ...base, phase: "reported" } }, "p").step).toBe("done");
    expect(resumePoint({ p: { ...base, phase: "drafted" } }, "p").step).toBe("done");
  });

  it("degrades a malformed state file to empty rather than crashing every run", () => {
    expect(parseState("not json")).toEqual({});
    expect(parseState('{"p": {"phase": "levitating"}}')).toEqual({});
    expect(parseState(null)).toEqual({});
  });
});

describe("config", () => {
  it("requires a project id and says where to find one", () => {
    const { errors } = resolveConfig(null, {});
    expect(errors[0]).toContain("--project");
    expect(errors[0]).toContain("/p/<id>");
  });

  it("requires urlBase in repo mode — verification cannot guess its target", () => {
    const { errors } = resolveConfig(
      { projectId: "x", repo: { path: "~/site" } },
      {},
    );
    expect(errors.join(" ")).toContain("repo.urlBase");
  });

  it("defaults the writer to claude -p", () => {
    const { config } = resolveConfig({ projectId: "x" }, {});
    expect(config.write).toEqual({ command: "claude", args: ["-p"], timeoutMin: 10 });
  });

  it("lets flags override the file", () => {
    const { config } = resolveConfig(
      { projectId: "file-project", server: "http://file:1" },
      { project: "flag-project", server: "http://flag:2" },
    );
    expect(config.projectId).toBe("flag-project");
    expect(config.server).toBe("http://flag:2");
  });

  it("strips the trailing slash from urlBase so URLs never double it", () => {
    const { config } = resolveConfig(
      { projectId: "x", repo: { path: "/s", urlBase: "https://a.com/blog/" } },
      {},
    );
    expect(config.repo?.urlBase).toBe("https://a.com/blog");
  });
});

describe("cli", () => {
  it("floors --every at 15 minutes", () => {
    // A generation can take several minutes; overlapping runs racing one
    // state file is the failure this floor makes unreachable.
    expect(parseEvery("5m")).toBe(15);
    expect(parseEvery("30m")).toBe(30);
    expect(parseEvery("1h")).toBe(60);
    expect(parseEvery("junk")).toBeNull();
  });

  it("parses a full run invocation", () => {
    const parsed = parseArgs([
      "run", "--watch", "--every", "45m", "--max", "2", "--project", "p1", "--buy-serp",
    ]);
    expect(parsed).toMatchObject({
      command: "run",
      watch: true,
      everyMin: 45,
      flags: { max: 2, project: "p1", buySerp: true },
      errors: [],
    });
  });

  it("rejects what it does not know rather than ignoring it", () => {
    expect(parseArgs(["run", "--frobnicate"]).errors[0]).toContain("--frobnicate");
    expect(parseArgs(["deploy"]).errors[0]).toContain('"deploy"');
  });
});

describe("spawn: runWriter()", () => {
  it("pipes the prompt over stdin and captures stdout", async () => {
    const run = await runWriter(
      {
        command: process.execPath,
        args: ["-e", "process.stdin.pipe(process.stdout)"],
        timeoutMin: 1,
      },
      "hello from stdin",
    );
    expect(run.ok).toBe(true);
    expect(run.stdout).toBe("hello from stdin");
  });

  it("reports a missing command as words, not as an empty draft", async () => {
    const run = await runWriter(
      { command: "definitely-not-a-real-command-xyz", args: [], timeoutMin: 1 },
      "prompt",
    );
    expect(run.ok).toBe(false);
    expect(run.code).toBeNull();
    expect(run.detail).toContain("ENOENT");
  });

  it("treats clean exit with empty output as failure", async () => {
    const run = await runWriter(
      { command: process.execPath, args: ["-e", ""], timeoutMin: 1 },
      "prompt",
    );
    expect(run.ok).toBe(false);
    expect(run.detail).toContain("printed nothing");
  });

  it("surfaces a non-zero exit", async () => {
    const run = await runWriter(
      { command: process.execPath, args: ["-e", "process.exit(3)"], timeoutMin: 1 },
      "prompt",
    );
    expect(run.ok).toBe(false);
    expect(run.detail).toContain("code 3");
  });
});
