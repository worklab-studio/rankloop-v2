// init and doctor exist because the pipeline has layers that can each be
// individually fine while the whole thing does nothing. Every test here is a
// state a real user gets stuck in, and what the tool must say about it.

import { describe, expect, it } from "vitest";
import {
  detectDomain,
  detectStack,
  normalizeDomain,
  suggestUrlBase,
  summarize,
  type RepoFacts,
} from "../src/detect.ts";
import { diagnose, nextAction, type DoctorFacts } from "../src/doctor.ts";
import { buildInitPlan, initQuestions } from "../src/init.ts";

function facts(present: string[], contents: Record<string, string> = {}): RepoFacts {
  return { present: new Set(present), contents, remote: null };
}

describe("detectStack()", () => {
  it("recognises a Next.js app router site", () => {
    expect(detectStack(facts(["next.config.mjs", "app/layout.tsx"]))).toBe("next-app");
  });

  it("recognises Astro and static", () => {
    expect(detectStack(facts(["astro.config.mjs"]))).toBe("astro");
    expect(detectStack(facts(["index.html"]))).toBe("static");
  });

  it("will not guess a router it cannot see", () => {
    expect(detectStack(facts(["next.config.js", "package.json"]))).toBe("unknown");
  });
});

describe("detectDomain()", () => {
  it("prefers a CNAME, which is a domain somebody typed", () => {
    const d = detectDomain(facts(["public/CNAME"], { "public/CNAME": "mysite.com\n" }));
    expect(d).toEqual({ domain: "mysite.com", from: "your CNAME file" });
  });

  it("reads a Cloudflare route", () => {
    // The exact setup the user described: repo → GitHub → Cloudflare.
    const d = detectDomain(
      facts(["wrangler.toml"], {
        "wrangler.toml": 'name = "mysite"\n[[routes]]\npattern = "mysite.com/*"\n',
      }),
    );
    expect(d?.domain).toBe("mysite.com");
    expect(d?.from).toContain("wrangler.toml");
  });

  it("falls back to package.json homepage", () => {
    const d = detectDomain(
      facts(["package.json"], { "package.json": '{"homepage":"https://mysite.com"}' }),
    );
    expect(d?.domain).toBe("mysite.com");
  });

  it("returns null rather than guessing from nothing", () => {
    expect(detectDomain(facts(["package.json"], { "package.json": "{}" }))).toBeNull();
  });
});

describe("normalizeDomain()", () => {
  it("reduces every spelling to a bare host", () => {
    expect(normalizeDomain("https://Mysite.com/blog")).toBe("mysite.com");
    expect(normalizeDomain("*.mysite.com")).toBe("mysite.com");
    expect(normalizeDomain("mysite.com/*")).toBe("mysite.com");
    expect(normalizeDomain("  mysite.com.  ")).toBe("mysite.com");
  });

  it("builds the URL the runner will verify", () => {
    expect(suggestUrlBase("https://mysite.com/")).toBe("https://mysite.com/blog");
  });
});

describe("init", () => {
  const summary = summarize(
    facts(["next.config.mjs", "app/layout.tsx", "public/CNAME"], {
      "public/CNAME": "mysite.com",
    }),
  );

  it("defaults the project to the one whose domain matches the repo", () => {
    // Five projects and one obviously right answer: pick it, do not make
    // the user read a list.
    const questions = initQuestions(summary, [
      { id: "p-other", name: "Other", domain: "elsewhere.com" },
      { id: "p-mine", name: "My Site", domain: "mysite.com" },
    ]);
    expect(questions.find((q) => q.key === "projectId")?.def).toBe("p-mine");
  });

  it("pre-fills the detected domain and content dir", () => {
    const questions = initQuestions(summary, []);
    expect(questions.find((q) => q.key === "domain")?.def).toBe("mysite.com");
    expect(questions.find((q) => q.key === "contentDir")?.def).toBe("content/blog");
  });

  it("writes a repo-mode config with the URL it will verify", () => {
    const plan = buildInitPlan({
      summary,
      answers: {
        projectId: "p1",
        domain: "mysite.com",
        contentDir: "content/blog",
        writerCommand: "claude",
        push: true,
      },
      server: "http://localhost:5173",
      projects: [],
      configPath: "/cfg.json",
    });
    const repo = plan.config.repo as Record<string, unknown>;
    expect(repo.urlBase).toBe("https://mysite.com/blog");
    expect(repo.contentDir).toBe("content/blog");
    expect(repo.push).toBe(true);
  });

  it("says where each guess came from", () => {
    const plan = buildInitPlan({
      summary,
      answers: {
        projectId: "p1", domain: "mysite.com", contentDir: "content/blog",
        writerCommand: "claude", push: true,
      },
      server: "http://localhost:5173",
      projects: [],
      configPath: "/cfg.json",
    });
    expect(plan.reasoning.join("\n")).toContain("from your CNAME file");
    expect(plan.reasoning.join("\n")).toContain("Next.js (app router)");
  });
});

describe("doctor", () => {
  function base(over: Partial<DoctorFacts> = {}): DoctorFacts {
    return {
      inGitRepo: true,
      configPath: "/cfg.json",
      configExists: true,
      projectId: "7a0000a9-0000-4000-8000-0000000000a1",
      writerCommand: "claude",
      writerOnPath: true,
      repoConfigured: true,
      repoPathExists: true,
      server: "http://localhost:5173",
      reachable: true,
      projectFound: true,
      writerMode: "agent",
      pipeline: {
        owed: 1,
        slots: 1,
        reason: null,
        exclusions: [],
        approvedProposals: 2,
        unwrittenProposals: 1,
      },
      ...over,
    };
  }

  it("says everything is ready when it is", () => {
    const checks = diagnose(base());
    expect(checks.every((c) => c.state !== "blocked")).toBe(true);
    expect(nextAction(checks)).toContain("rankloop-local run");
  });

  it("stops at the dashboard rather than guessing about the server", () => {
    // Nothing below is knowable without it, and inventing a pipeline state
    // for an unreachable server is exactly the lie this tool prevents.
    const checks = diagnose(base({ reachable: false }));
    expect(checks.at(-1)?.name).toBe("Dashboard");
    expect(nextAction(checks)).toContain("npm run dev");
  });

  it("names the first blocker, not the last", () => {
    // The old failure mode: "No approved proposals are waiting" is true and
    // useless when the real problem is three layers up.
    const checks = diagnose(
      base({
        writerMode: "api",
        pipeline: {
          owed: null, slots: 0, reason: "no page type approved",
          exclusions: [], approvedProposals: 0, unwrittenProposals: 0,
        },
      }),
    );
    expect(nextAction(checks)).toContain("Writer mode");
  });

  it("passes the server's own reason through, with where to fix it", () => {
    // Verbatim from NetNewProposalsService — a fixture that paraphrases the
    // server is a fixture that passes while the real string falls through
    // to the generic advice.
    const checks = diagnose(
      base({
        pipeline: {
          owed: null, slots: 0,
          reason: "no planned keywords are bound to an approved page type",
          exclusions: [], approvedProposals: 0, unwrittenProposals: 0,
        },
      }),
    );
    const quota = checks.find((c) => c.name === "Quota");
    expect(quota?.state).toBe("blocked");
    expect(quota?.detail).toBe("no planned keywords are bound to an approved page type");
    expect(quota?.fix).toContain("Gate 1");
  });

  it("recognises the programmatic no-dataset reason", () => {
    // "no data row, no page" reaching the terminal as a sentence somebody
    // can act on.
    const checks = diagnose(
      base({
        pipeline: {
          owed: null, slots: 0,
          reason: "every approved page type is still waiting on a data source",
          exclusions: [], approvedProposals: 0, unwrittenProposals: 0,
        },
      }),
    );
    expect(checks.find((c) => c.name === "Quota")?.fix).toContain("no data row, no page");
  });

  it("does not confuse a quota that is OFF with a quota that is MET", () => {
    // The first version matched any reason containing "quota" and told a
    // user whose daily loop was disabled that it was already finished for
    // the day. Opposite meanings, same word.
    const checks = diagnose(
      base({
        pipeline: {
          owed: null, slots: 0, reason: "quota off — propose manually",
          exclusions: [], approvedProposals: 0, unwrittenProposals: 0,
        },
      }),
    );
    const quota = checks.find((c) => c.name === "Quota");
    expect(quota?.state).toBe("warn");
    expect(quota?.fix).toContain("Connect → Automation");
    expect(quota?.fix).not.toContain("already met");
  });

  it("passes an unrecognised reason to the dashboard rather than guessing", () => {
    const checks = diagnose(
      base({
        pipeline: {
          owed: null, slots: 0, reason: "something new the server started saying",
          exclusions: [], approvedProposals: 0, unwrittenProposals: 0,
        },
      }),
    );
    expect(checks.find((c) => c.name === "Quota")?.fix).toContain("Open the dashboard");
  });

  it("does not call an indexation throttle a problem to fix", () => {
    // rankloop throttling itself is the system working. Telling the user to
    // go fix it would send them looking for a button that should not exist.
    const checks = diagnose(
      base({
        pipeline: {
          owed: 1, slots: 0,
          reason: "indexation below 65%, quota capped at 1",
          exclusions: [], approvedProposals: 0, unwrittenProposals: 0,
        },
      }),
    );
    const quota = checks.find((c) => c.name === "Quota");
    expect(quota?.state).toBe("warn");
    expect(quota?.fix).toContain("Nothing to fix");
  });

  it("treats draft mode as a choice, not a fault", () => {
    const checks = diagnose(base({ repoConfigured: false, repoPathExists: false }));
    expect(checks.find((c) => c.name === "Publishing")?.state).toBe("warn");
    expect(checks.every((c) => c.state !== "blocked")).toBe(true);
  });

  it("catches a missing writer CLI before anything is attempted", () => {
    const checks = diagnose(base({ writerOnPath: false }));
    expect(checks.find((c) => c.name === "Writer CLI")?.state).toBe("blocked");
  });

  it("surfaces held-back page types with the server's reason", () => {
    const checks = diagnose(
      base({
        pipeline: {
          owed: 1, slots: 1, reason: null,
          exclusions: [{ name: "Comparisons", reason: "SERP too strong" }],
          approvedProposals: 1, unwrittenProposals: 1,
        },
      }),
    );
    const held = checks.find((c) => c.name === "Held back");
    expect(held?.state).toBe("warn");
    expect(held?.detail).toContain("SERP too strong");
  });

  it("distinguishes 'none approved' from 'all already drafted'", () => {
    const noneApproved = diagnose(
      base({
        pipeline: { owed: 1, slots: 1, reason: null, exclusions: [], approvedProposals: 0, unwrittenProposals: 0 },
      }),
    ).find((c) => c.name === "Approved titles");
    expect(noneApproved?.state).toBe("blocked");
    expect(noneApproved?.fix).toContain("Gate 2");

    const allDrafted = diagnose(
      base({
        pipeline: { owed: 1, slots: 1, reason: null, exclusions: [], approvedProposals: 3, unwrittenProposals: 0 },
      }),
    ).find((c) => c.name === "Approved titles");
    expect(allDrafted?.state).toBe("warn");
  });
});
