// The stage model decides three things at once: what the spine says, what a
// gated screen shows, and what the cascade starts next. A wrong answer here
// is wrong in three places, so the cases below are the ones where those three
// consumers could disagree.

import { describe, expect, it } from "vitest";
import {
  buildPipeline,
  pipelineHeadline,
  startableStages,
  type PipelineFacts,
} from "./pipeline.logic";

/** A brand new project: domain entered, nothing has run. */
function fresh(): PipelineFacts {
  return {
    siteStudy: { status: null, pages: 0, posts: 0, crawled: 0, total: 0 },
    aiAccess: { checked: false, blockedAgents: 0, findings: 0 },
    gsc: { oauthConfigured: true, connected: false, status: null, dayCount: 0 },
    competitors: { tracked: 0, studied: 0, running: false, anyError: false },
    keywords: { status: null, backlog: 0 },
    plan: { status: null, proposed: 0, approved: 0 },
    titles: { proposed: 0, approved: 0 },
    publish: { configured: false, published: 0 },
  };
}

/** Site crawled, so `market` and `keywords` are unblocked. */
function studied(over: Partial<PipelineFacts> = {}): PipelineFacts {
  return {
    ...fresh(),
    siteStudy: { status: "done", pages: 12, posts: 4, crawled: 12, total: 12 },
    ...over,
  };
}

const statusOf = (f: PipelineFacts, id: string) =>
  buildPipeline(f).stages.find((s) => s.id === id)?.status;

describe("a brand new project", () => {
  it("has exactly two things it can start on its own", () => {
    // site and access need no prerequisite. This is what lets day 0 begin
    // the moment a domain is entered, with no click.
    expect(startableStages(buildPipeline(fresh()).stages)).toEqual([
      "site",
      "access",
    ]);
  });

  it("marks downstream stages `waiting`, not `needs_you`", () => {
    // The distinction the UX turns on: rankloop is getting to these. Putting
    // them in the needs-you queue would hand the user work that is not
    // theirs.
    expect(statusOf(fresh(), "market")).toBe("waiting");
    expect(statusOf(fresh(), "keywords")).toBe("waiting");
    expect(statusOf(fresh(), "plan")).toBe("waiting");
  });

  it("names what each waiting stage is waiting for", () => {
    const plan = buildPipeline(fresh()).stages.find((s) => s.id === "plan");
    expect(plan?.blockedBy).toBe("Keywords");
    expect(plan?.detail).toBe("Waiting for keywords");
  });

  it("puts only real human work in the needs-you queue", () => {
    // Search Console and a publish destination. Not the eight stages that
    // simply have not run.
    expect(buildPipeline(fresh()).needsYou.map((s) => s.id)).toEqual([
      "memory",
      "publish",
    ]);
  });

  it("gives every needs-you item exactly one button", () => {
    for (const stage of buildPipeline(fresh()).needsYou) {
      expect(stage.action, stage.id).not.toBeNull();
      expect(stage.action?.label.length).toBeGreaterThan(0);
    }
  });
});

describe("Search Console is a prompt, not a gate", () => {
  it("does not stop the cascade from reaching the plan", () => {
    // The requirement in one test: a project with no GSC still studies its
    // site, finds competitors, builds a universe and drafts a plan.
    const f = studied({
      competitors: { tracked: 5, studied: 5, running: false, anyError: false },
      keywords: { status: "done", backlog: 1218 },
      gsc: { oauthConfigured: true, connected: false, status: null, dayCount: 0 },
    });
    expect(statusOf(f, "memory")).toBe("needs_you");
    expect(startableStages(buildPipeline(f).stages)).toContain("plan");
  });

  it("separates a deployment with no OAuth client from a user who has not connected", () => {
    // One of these the user can fix from this screen. The other cannot be
    // fixed by pressing "Connect", and offering that button would be a lie.
    const noClient = buildPipeline({
      ...fresh(),
      gsc: { oauthConfigured: false, connected: false, status: null, dayCount: 0 },
    }).stages.find((s) => s.id === "memory");
    expect(noClient?.blockedBy).toBe("Google OAuth client not configured");

    const notConnected = buildPipeline(fresh()).stages.find(
      (s) => s.id === "memory",
    );
    expect(notConnected?.blockedBy).toBe("Search Console not connected");
  });
});

describe("prerequisites describe order, not permanence", () => {
  it("does not blank out a finished stage when an upstream one re-runs", () => {
    // A re-crawl in flight must not make the 1,218 keywords underneath it
    // read as "waiting for your site". The user would think we lost them.
    const f = studied({
      siteStudy: { status: "running", pages: 12, posts: 4, crawled: 3, total: 40 },
      keywords: { status: "done", backlog: 1218 },
    });
    expect(statusOf(f, "keywords")).toBe("done");
    expect(
      buildPipeline(f).stages.find((s) => s.id === "keywords")?.detail,
    ).toBe("1,218 keywords found");
  });

  it("keeps a needs-you stage visible even while its prerequisite runs", () => {
    const f = studied({
      keywords: { status: "running", backlog: 40 },
      plan: { status: null, proposed: 6, approved: 0 },
    });
    expect(statusOf(f, "plan")).toBe("needs_you");
  });
});

describe("Gate 1 — proposed is not approved", () => {
  it("asks for a decision when types are proposed but none approved", () => {
    const f = studied({
      keywords: { status: "done", backlog: 900 },
      plan: { status: "done", proposed: 6, approved: 0 },
    });
    const plan = buildPipeline(f).stages.find((s) => s.id === "plan");
    expect(plan?.status).toBe("needs_you");
    expect(plan?.detail).toBe("6 page types proposed, none approved yet");
  });

  it("blocks titles until a type is actually approved", () => {
    // Approved types are what everything downstream binds to. Treating
    // "proposed" as done would let rankloop write against a plan nobody
    // agreed to.
    const f = studied({
      keywords: { status: "done", backlog: 900 },
      plan: { status: "done", proposed: 6, approved: 0 },
    });
    expect(statusOf(f, "titles")).toBe("waiting");
    expect(startableStages(buildPipeline(f).stages)).not.toContain("titles");
  });

  it("releases titles once one is approved", () => {
    const f = studied({
      keywords: { status: "done", backlog: 900 },
      plan: { status: "done", proposed: 5, approved: 1 },
    });
    expect(statusOf(f, "plan")).toBe("done");
    expect(startableStages(buildPipeline(f).stages)).toContain("titles");
  });
});

describe("readings that would otherwise mislead", () => {
  it("reports a competitor study failure without hiding the ones that worked", () => {
    const f = studied({
      competitors: { tracked: 3, studied: 2, running: false, anyError: true },
    });
    const market = buildPipeline(f).stages.find((s) => s.id === "market");
    expect(market?.status).toBe("done");
    expect(market?.detail).toBe("3 competitors, 2 studied · a study failed");
  });

  it("calls it an error only when nothing survived", () => {
    const f = studied({
      competitors: { tracked: 3, studied: 0, running: false, anyError: true },
    });
    expect(statusOf(f, "market")).toBe("error");
  });

  it("shows live crawl progress rather than a bare spinner", () => {
    const f = {
      ...fresh(),
      siteStudy: { status: "running" as const, pages: 0, posts: 0, crawled: 7, total: 40 },
    };
    expect(buildPipeline(f).stages[0]?.detail).toBe("Crawling 7 of 40 pages");
  });

  it("counts a single page in the singular", () => {
    // productlaunchos.com is one page. "1 pages, 0 posts" is the kind of
    // detail that makes a user distrust everything else on the screen.
    const f = {
      ...fresh(),
      siteStudy: { status: "done" as const, pages: 1, posts: 0, crawled: 1, total: 1 },
    };
    expect(buildPipeline(f).stages[0]?.detail).toBe("1 page, 0 posts");
  });

  it("treats copy-paste as a destination that has not been chosen yet", () => {
    // Copy-paste always works, so this is a decision outstanding rather than
    // a capability the user lacks.
    const publish = buildPipeline(fresh()).stages.find((s) => s.id === "publish");
    expect(publish?.detail).toContain("copy-paste");
  });
});

describe("the cascade converges", () => {
  it("advances one stage at a time to a settled end", () => {
    // Drives the real loop: start what is startable, mark it done, repeat.
    // If the rule could ever fail to converge this is where it hangs.
    let facts = fresh();
    const started: string[] = [];

    for (let i = 0; i < 20; i++) {
      const next = startableStages(buildPipeline(facts).stages);
      if (next.length === 0) break;
      for (const id of next) {
        started.push(id);
        facts = completeStage(facts, id);
      }
    }

    expect(started).toEqual([
      "site",
      "access",
      "market",
      "keywords",
      "plan",
      "titles",
    ]);
    // `memory` and `publish` are needs_you and were correctly never started.
    expect(started).not.toContain("memory");
    expect(started).not.toContain("publish");
  });

  it("reports settled once nothing is startable and nothing is running", () => {
    const f = studied({
      aiAccess: { checked: true, blockedAgents: 0, findings: 1 },
      competitors: { tracked: 4, studied: 4, running: false, anyError: false },
      keywords: { status: "done", backlog: 800 },
      plan: { status: "done", proposed: 4, approved: 2 },
      titles: { proposed: 0, approved: 20 },
    });
    expect(buildPipeline(f).settled).toBe(true);
  });
});

describe("pipelineHeadline()", () => {
  it("leads with what is running", () => {
    const f = { ...fresh(), siteStudy: { status: "running" as const, pages: 0, posts: 0, crawled: 7, total: 40 } };
    expect(pipelineHeadline(buildPipeline(f))).toContain("Crawling 7 of 40");
  });

  it("names each blocker when several need a human", () => {
    expect(pipelineHeadline(buildPipeline(fresh()))).toBe(
      "2 things need you: Search Console not connected, no destination chosen",
    );
  });

  it("uses the stage's own sentence when only one thing needs a human", () => {
    const f = studied({
      aiAccess: { checked: true, blockedAgents: 0, findings: 0 },
      gsc: { oauthConfigured: true, connected: true, status: "done", dayCount: 90 },
      competitors: { tracked: 4, studied: 4, running: false, anyError: false },
      keywords: { status: "done", backlog: 800 },
      plan: { status: "done", proposed: 4, approved: 2 },
      titles: { proposed: 0, approved: 20 },
    });
    expect(pipelineHeadline(buildPipeline(f))).toContain("copy-paste");
  });

  it("keeps proper nouns capitalised in the blocker list", () => {
    // "search console not connected" would look like a typo in the one
    // sentence a user reads first.
    expect(pipelineHeadline(buildPipeline(fresh()))).toContain("Search Console");
  });

  it("says so plainly when everything is fine", () => {
    const f = studied({
      aiAccess: { checked: true, blockedAgents: 0, findings: 0 },
      gsc: { oauthConfigured: true, connected: true, status: "done", dayCount: 90 },
      competitors: { tracked: 4, studied: 4, running: false, anyError: false },
      keywords: { status: "done", backlog: 800 },
      plan: { status: "done", proposed: 4, approved: 2 },
      titles: { proposed: 0, approved: 20 },
      publish: { configured: true, published: 6 },
    });
    expect(pipelineHeadline(buildPipeline(f))).toBe(
      "Everything is running on its own",
    );
  });
});

/** Mark a stage finished, the way the orchestrator's next poll would see it. */
function completeStage(f: PipelineFacts, id: string): PipelineFacts {
  switch (id) {
    case "site":
      return { ...f, siteStudy: { status: "done", pages: 12, posts: 4, crawled: 12, total: 12 } };
    case "access":
      return { ...f, aiAccess: { checked: true, blockedAgents: 0, findings: 1 } };
    case "market":
      return { ...f, competitors: { tracked: 5, studied: 5, running: false, anyError: false } };
    case "keywords":
      return { ...f, keywords: { status: "done", backlog: 1218 } };
    case "plan":
      return { ...f, plan: { status: "done", proposed: 6, approved: 3 } };
    case "titles":
      return { ...f, titles: { proposed: 0, approved: 20 } };
    default:
      return f;
  }
}
