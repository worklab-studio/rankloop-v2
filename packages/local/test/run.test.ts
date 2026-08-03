// The two rules this runner exists to keep — report only what was observed
// live, and never do the same work twice — are decided in `runOnce`. Every
// test here is a way a cron-driven loop breaks them on a real laptop:
// crashes between steps, pushes that deploy slowly, files that were
// somebody else's, a CLI that is not installed.

import { describe, expect, it } from "vitest";
import type { LocalConfig } from "../src/config.ts";
import type { McpToolResult } from "../src/mcp.ts";
import { runOnce, type RunDeps } from "../src/run.ts";
import type { RunnerState } from "../src/state.ts";

const PASSING_DRAFT = "---\ntitle: T\n---\n\nBody.\n";

function config(over: Partial<LocalConfig> = {}): LocalConfig {
  return {
    server: "http://localhost:5173",
    projectId: "p1",
    write: { command: "fake", args: [], timeoutMin: 1 },
    repo: null,
    outDir: "/drafts",
    maxAttempts: 3,
    allowSerpFetch: false,
    maxPerRun: 1,
    ...over,
  };
}

const REPO = {
  path: "/site",
  contentDir: "content/blog",
  urlBase: "https://site.test/blog",
  push: true,
  verifyTimeoutMin: 0, // no waiting in tests: one poll, then the deadline
};

interface Harness {
  deps: RunDeps;
  calls: string[];
  written: Map<string, string>;
  gitLog: string[];
  state: () => RunnerState;
  logs: string[];
}

function ok(structured: Record<string, unknown>): McpToolResult {
  return { structured, text: "", isError: false };
}

function harness(input: {
  config: LocalConfig;
  tools?: Partial<Record<string, (args: Record<string, unknown>) => McpToolResult>>;
  writerRuns?: string[];
  existingFiles?: string[];
  liveUrls?: string[];
  initialState?: RunnerState;
  checkPassesOn?: number;
}): Harness {
  const calls: string[] = [];
  const written = new Map<string, string>();
  const gitLog: string[] = [];
  const logs: string[] = [];
  let state: RunnerState = input.initialState ?? {};
  let writerCall = 0;
  let checkCall = 0;

  const defaultTools: Record<string, (args: Record<string, unknown>) => McpToolResult> = {
    rankloop_status: () => ok({ writerMode: "agent" }),
    rankloop_proposals: () =>
      ok({ proposals: [{ proposalId: "prop-1", keyword: "best widget", article: null }] }),
    rankloop_brief: () => ok({ markdown: "# Brief\nWrite about widgets." }),
    rankloop_check: () => {
      checkCall++;
      const passes = checkCall >= (input.checkPassesOn ?? 1);
      return ok({
        passed: passes,
        slug: "best-widget",
        violations: passes ? 0 : 2,
        report: {
          laws: passes
            ? []
            : [
                { law: "word count >= 850", passed: false, threshold: "850", observed: "310" },
                { law: "faq entries >= 3", passed: false, threshold: "3", observed: "0" },
              ],
        },
      });
    },
    rankloop_publish_report: () => ok({ articleId: "a1", alreadyReported: false }),
  };

  const deps: RunDeps = {
    config: input.config,
    log: (message) => logs.push(message),
    client: {
      call: async (tool, args) => {
        calls.push(tool);
        const handler = input.tools?.[tool] ?? defaultTools[tool];
        if (!handler) throw new Error(`unexpected tool ${tool}`);
        return handler(args);
      },
    },
    writer: async () => {
      const stdout = input.writerRuns?.[writerCall] ?? PASSING_DRAFT;
      writerCall++;
      calls.push("spawn");
      return { ok: true, stdout, stderr: "", code: 0, timedOut: false, detail: null };
    },
    files: {
      exists: (path) => written.has(path) || (input.existingFiles ?? []).includes(path),
      read: (path) => written.get(path) ?? null,
      write: (path, content) => {
        written.set(path, content);
      },
    },
    exec: async (_cwd, args) => {
      gitLog.push(args.join(" "));
      if (args[0] === "rev-parse") return { ok: true, stdout: "abc123\n", stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    },
    fetchStatus: async (url) => ((input.liveUrls ?? []).includes(url) ? 200 : 404),
    sleep: async () => {},
    now: () => "2026-08-03T10:00:00.000Z",
    loadState: () => state,
    saveState: (next) => {
      state = next;
    },
  };

  return { deps, calls, written, gitLog, state: () => state, logs };
}

describe("the dial is respected", () => {
  it("does nothing when writerMode is not agent, and says where to flip it", async () => {
    const h = harness({
      config: config(),
      tools: { rankloop_status: () => ok({ writerMode: "api" }) },
    });
    const summary = await runOnce(h.deps);
    expect(summary.handled).toBe(0);
    expect(h.calls).toEqual(["rankloop_status"]);
    expect(h.logs.join("\n")).toContain("Connect → Writing");
  });
});

describe("draft mode", () => {
  it("writes one gated file and records it", async () => {
    const h = harness({ config: config() });
    const summary = await runOnce(h.deps);
    expect(summary.drafted).toBe(1);
    expect(h.written.get("/drafts/best-widget.md")).toContain("Body.");
    expect(h.state()["prop-1"]?.phase).toBe("drafted");
  });

  it("does not regenerate on the next run — the state remembers", async () => {
    // rankloop still lists the proposal as unwritten (no report in draft
    // mode), so without state every cron tick would buy another generation.
    const h = harness({ config: config() });
    await runOnce(h.deps);
    const spawnsAfterFirst = h.calls.filter((c) => c === "spawn").length;
    await runOnce(h.deps);
    expect(h.calls.filter((c) => c === "spawn").length).toBe(spawnsAfterFirst);
  });

  it("refuses to overwrite a file it did not write", async () => {
    const h = harness({ config: config(), existingFiles: ["/drafts/best-widget.md"] });
    const summary = await runOnce(h.deps);
    expect(summary.drafted).toBe(0);
    expect(h.written.size).toBe(0);
    expect(h.logs.join("\n")).toContain("Refusing to overwrite");
  });
});

describe("the repair loop", () => {
  it("feeds violations back and passes on the second attempt", async () => {
    const h = harness({
      config: config(),
      checkPassesOn: 2,
      writerRuns: ["---\ntitle: thin\n---\nshort", PASSING_DRAFT],
    });
    const summary = await runOnce(h.deps);
    expect(summary.drafted).toBe(1);
    expect(h.calls.filter((c) => c === "spawn")).toHaveLength(2);
    expect(h.calls.filter((c) => c === "rankloop_check")).toHaveLength(2);
  });

  it("gives up after maxAttempts and ships nothing", async () => {
    // Same semantics as the dashboard writer: the proposal stays approved,
    // nothing half-done lands anywhere.
    const h = harness({ config: config(), checkPassesOn: 99 });
    const summary = await runOnce(h.deps);
    expect(summary.drafted).toBe(0);
    expect(h.calls.filter((c) => c === "spawn")).toHaveLength(3);
    expect(h.written.size).toBe(0);
    expect(h.logs.join("\n")).toContain("stays approved");
  });

  it("treats a missing CLI as fatal, not as three identical failures", async () => {
    // ENOENT fails the same way forever; burning attempts — and the other
    // proposals — on it converts a config problem into a mystery.
    const h = harness({ config: config() });
    let attempts = 0;
    h.deps.writer = async () => {
      attempts++;
      return {
        ok: false, stdout: "", stderr: "", code: null, timedOut: false,
        detail: "spawn claude ENOENT",
      };
    };
    const summary = await runOnce(h.deps);
    expect(summary.fatal).not.toBeNull();
    expect(attempts).toBe(1);
    expect(h.logs.join("\n")).toContain("ENOENT");
  });
});

describe("repo mode — the honesty rules", () => {
  it("writes, commits, pushes, sees it live, then reports", async () => {
    const h = harness({
      config: config({ repo: { ...REPO } }),
      liveUrls: ["https://site.test/blog/best-widget/"],
    });
    const summary = await runOnce(h.deps);
    expect(summary.reported).toBe(1);
    expect(h.gitLog).toEqual([
      "add /site/content/blog/best-widget.md",
      "commit -m rankloop: best-widget",
      "rev-parse HEAD",
      "push",
    ]);
    expect(h.calls.at(-1)).toBe("rankloop_publish_report");
    expect(h.state()["prop-1"]?.phase).toBe("reported");
  });

  it("never reports a URL it has not seen answer 200", async () => {
    // The receipt-opening call is the one that must not lie. Deploy slow?
    // Stop at pushed and let the next run confirm.
    const h = harness({ config: config({ repo: { ...REPO } }), liveUrls: [] });
    const summary = await runOnce(h.deps);
    expect(summary.reported).toBe(0);
    expect(h.calls).not.toContain("rankloop_publish_report");
    expect(h.state()["prop-1"]?.phase).toBe("pushed");
    expect(h.logs.join("\n")).toContain("not live yet");
  });

  it("resumes a pushed proposal at verification — no new generation", async () => {
    const h = harness({
      config: config({ repo: { ...REPO } }),
      liveUrls: ["https://site.test/blog/best-widget/"],
      initialState: {
        "prop-1": {
          phase: "pushed",
          slug: "best-widget",
          file: "/site/content/blog/best-widget.md",
          url: "https://site.test/blog/best-widget/",
          commit: "abc123",
          updatedAt: "2026-08-03T09:00:00.000Z",
        },
      },
    });
    h.written.set("/site/content/blog/best-widget.md", PASSING_DRAFT);
    const summary = await runOnce(h.deps);
    expect(summary.reported).toBe(1);
    expect(h.calls).not.toContain("spawn");
    expect(h.calls).not.toContain("rankloop_brief");
    expect(h.gitLog).toEqual([]);
  });

  it("stays at written when the push fails, and the commit no-ops next run", async () => {
    const h = harness({ config: config({ repo: { ...REPO } }) });
    h.deps.exec = async (_cwd, args) => {
      h.gitLog.push(args.join(" "));
      if (args[0] === "push") return { ok: false, stdout: "", stderr: "remote hung up" };
      if (args[0] === "rev-parse") return { ok: true, stdout: "abc123\n", stderr: "" };
      if (args[0] === "commit" && h.gitLog.filter((g) => g.startsWith("commit")).length > 1) {
        return { ok: false, stdout: "nothing to commit, working tree clean", stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    };

    await runOnce(h.deps);
    expect(h.state()["prop-1"]?.phase).toBe("written");

    // Next run: resume at commit, "nothing to commit" is a resume not a
    // failure, push retries.
    h.deps.exec = async (_cwd, args) => {
      h.gitLog.push(args.join(" "));
      if (args[0] === "commit") {
        return { ok: false, stdout: "nothing to commit, working tree clean", stderr: "" };
      }
      if (args[0] === "rev-parse") return { ok: true, stdout: "abc123\n", stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    };
    const h2settings = h.deps as { fetchStatus: RunDeps["fetchStatus"] };
    h2settings.fetchStatus = async () => 200;
    const summary = await runOnce(h.deps);
    expect(summary.reported).toBe(1);
    expect(h.calls.filter((c) => c === "spawn")).toHaveLength(1); // only the first run generated
  });

  it("finishes unfinished work before starting new generations", async () => {
    // Resumes are nearly free; generations are the expensive step. Two
    // proposals, one mid-flight: the mid-flight one goes first.
    const h = harness({
      config: config({ repo: { ...REPO }, maxPerRun: 1 }),
      liveUrls: ["https://site.test/blog/old-post/"],
      tools: {
        rankloop_proposals: () =>
          ok({
            proposals: [
              { proposalId: "prop-new", keyword: "new thing", article: null },
              { proposalId: "prop-old", keyword: "old thing", article: null },
            ],
          }),
      },
      initialState: {
        "prop-old": {
          phase: "pushed",
          slug: "old-post",
          file: "/site/content/blog/old-post.md",
          url: "https://site.test/blog/old-post/",
          updatedAt: "2026-08-03T09:00:00.000Z",
        },
      },
    });
    h.written.set("/site/content/blog/old-post.md", PASSING_DRAFT);
    const summary = await runOnce(h.deps);
    expect(summary.reported).toBe(1);
    expect(h.calls).not.toContain("spawn");
  });
});

describe("proposal selection", () => {
  it("skips rows whose article is already in flight", async () => {
    // A non-null article means the dashboard's own writer owns it; taking it
    // too would race that writer for the same proposal.
    const h = harness({
      config: config(),
      tools: {
        rankloop_proposals: () =>
          ok({
            proposals: [
              { proposalId: "prop-taken", keyword: "taken", article: { id: "a1" } },
              { proposalId: "prop-free", keyword: "free", article: null },
            ],
          }),
      },
    });
    await runOnce(h.deps);
    expect(h.written.has("/drafts/best-widget.md")).toBe(true);
    expect(h.calls.filter((c) => c === "rankloop_brief")).toHaveLength(1);
  });

  it("one proposal's failure does not end the run", async () => {
    const h = harness({
      config: config({ maxPerRun: 2 }),
      tools: {
        rankloop_proposals: () =>
          ok({
            proposals: [
              { proposalId: "prop-bad", keyword: "bad", article: null },
              { proposalId: "prop-good", keyword: "good", article: null },
            ],
          }),
        rankloop_brief: (args) =>
          args.proposalId === "prop-bad"
            ? { structured: null, text: "brief exploded", isError: true }
            : ok({ markdown: "# Brief" }),
      },
    });
    const summary = await runOnce(h.deps);
    expect(summary.handled).toBe(2);
    expect(summary.drafted).toBe(1);
    expect(h.logs.join("\n")).toContain("brief exploded");
  });
});
