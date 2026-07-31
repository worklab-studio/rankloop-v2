import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { PublishContext } from "@/server/features/rankloop/publish/services/publishContext";

// The workflow's control flow is what is under test: the order of the eight
// steps, the resume guard, and which failures are fatal. Every collaborator is
// mocked, so nothing here reaches an adapter, a database or the engine.

const mocks = vi.hoisted(() => ({
  publish: {
    preflight: vi.fn(),
    landBlocked: vi.fn(),
    ensureHub: vi.fn(),
    publishPost: vi.fn(),
    upsertManifestPage: vi.fn(),
    submitIndexNow: vi.fn(),
    commitPublished: vi.fn(),
  },
  links: {
    planLinks: vi.fn(),
    injectLinks: vi.fn(),
    wireDerivedArtifacts: vi.fn(),
  },
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
  // oxlint-disable-next-line typescript/no-extraneous-class -- stand-in for the real base class; the workflow only inherits its shape
  WorkflowEntrypoint: class {},
}));
vi.mock("@/db", () => ({ withPgClient: (fn: () => unknown) => fn() }));
vi.mock("@/server/features/rankloop/publish/services/PublishService", () => ({
  PublishService: mocks.publish,
}));
vi.mock(
  "@/server/features/rankloop/publish/services/PublishLinksService",
  () => ({ PublishLinksService: mocks.links }),
);

/** Records the order steps ran in, and runs each body inline: the engine's
 *  checkpointing is not what these tests are about. */
const stepOrder: string[] = [];

function makeFakeStep(): WorkflowStep {
  const fake = {
    do: (
      name: string,
      configOrFn: (() => Promise<unknown>) | Record<string, unknown>,
      maybeFn?: () => Promise<unknown>,
    ) => {
      stepOrder.push(name);
      return typeof configOrFn === "function" ? configOrFn() : maybeFn?.();
    },
    sleep: vi.fn(),
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double: only do/sleep are exercised
  return fake as unknown as WorkflowStep;
}

function makeEvent(): WorkflowEvent<{
  articleId: string;
  projectId: string;
}> {
  return {
    payload: { articleId: "article_1", projectId: "project_1" },
    timestamp: new Date(),
    instanceId: "article_1",
    workflowName: "publish-workflow",
  };
}

const CONTEXT: PublishContext = {
  projectId: "project_1",
  articleId: "article_1",
  proposalId: "proposal_1",
  keywordBacklogId: "kw_1",
  pageTypeId: "type_1",
  pageTypeName: "Comparisons",
  urlPattern: "/compare/{slug}/",
  keyword: "espresso tamper sizes",
  slug: "espresso-tamper-sizes",
  title: "Espresso tamper sizes",
  description: "Which base fits which basket.",
  date: "2026-08-01",
  path: "/compare/espresso-tamper-sizes/",
  siteUrl: "https://acme.com",
  adapterRef: null,
};

async function runWorkflow() {
  const { PublishWorkflow } = await import("./PublishWorkflow");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double: ctx/env are never touched (every collaborator is mocked)
  const workflow = new PublishWorkflow({} as ExecutionContext, {} as Env);
  await workflow.run(makeEvent(), makeFakeStep());
}

beforeEach(() => {
  vi.resetModules();
  stepOrder.length = 0;
  for (const group of Object.values(mocks)) {
    for (const mock of Object.values(group)) mock.mockReset();
  }
  mocks.publish.preflight.mockResolvedValue({ ok: true, context: CONTEXT });
  mocks.publish.ensureHub.mockResolvedValue({
    contentPageId: "page_hub",
    path: "/compare/",
    url: "https://acme.com/compare/",
    ref: "12",
    created: true,
    note: null,
  });
  mocks.links.planLinks.mockResolvedValue([
    { contentPageId: "page_a", path: "/compare/a/", title: "A" },
  ]);
  mocks.publish.publishPost.mockResolvedValue({
    adapter: "wordpress",
    adapterRef: "99",
    url: "https://acme.com/compare/espresso-tamper-sizes/",
    urlVerified: true,
    resumed: false,
    notes: [],
  });
  mocks.publish.upsertManifestPage.mockResolvedValue({
    contentPageId: "page_new",
    publishedAt: "2026-08-01T10:00:00.000Z",
  });
  mocks.links.injectLinks.mockResolvedValue({
    links: [
      { contentPageId: "page_a", path: "/compare/a/", outcome: "injected" },
    ],
  });
  mocks.links.wireDerivedArtifacts.mockResolvedValue({ written: [] });
  mocks.publish.submitIndexNow.mockResolvedValue({ submitted: true });
  mocks.publish.commitPublished.mockResolvedValue(undefined);
});

describe("PublishWorkflow — the order", () => {
  it("runs the spec's eight steps in order", async () => {
    await runWorkflow();

    expect(stepOrder).toEqual([
      "preflight",
      "hub",
      "link-targets",
      "publish",
      "manifest",
      "links",
      "wire",
      "indexnow",
      "receipt",
    ]);
  });

  it("creates the hub before the instance", async () => {
    const calls: string[] = [];
    mocks.publish.ensureHub.mockImplementation(() => {
      calls.push("hub");
      return Promise.resolve({
        contentPageId: "page_hub",
        path: "/compare/",
        url: "https://acme.com/compare/",
        ref: "12",
        created: true,
        note: null,
      });
    });
    mocks.publish.publishPost.mockImplementation(() => {
      calls.push("post");
      return Promise.resolve({
        adapter: "wordpress",
        adapterRef: "99",
        url: "https://acme.com/compare/espresso-tamper-sizes/",
        urlVerified: true,
        resumed: false,
        notes: [],
      });
    });

    await runWorkflow();

    expect(calls).toEqual(["hub", "post"]);
  });

  it("hands the hub it just ensured to the post it creates", async () => {
    await runWorkflow();

    expect(mocks.publish.publishPost).toHaveBeenCalledWith(
      expect.objectContaining({
        hub: {
          contentPageId: "page_hub",
          path: "/compare/",
          url: "https://acme.com/compare/",
          ref: "12",
          created: true,
          note: null,
        },
      }),
    );
  });

  it("chooses the neighbours before the post, so a delegated target can be told", async () => {
    await runWorkflow();

    expect(stepOrder.indexOf("link-targets")).toBeLessThan(
      stepOrder.indexOf("publish"),
    );
    expect(mocks.publish.publishPost).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [{ contentPageId: "page_a", path: "/compare/a/", title: "A" }],
      }),
    );
  });

  it("injects into exactly the neighbours it planned", async () => {
    await runWorkflow();

    expect(mocks.links.injectLinks).toHaveBeenCalledWith({
      context: CONTEXT,
      targets: [{ contentPageId: "page_a", path: "/compare/a/", title: "A" }],
      anchor: "Espresso tamper sizes",
    });
  });

  it("opens the receipt with the manifest row and the publish stamp", async () => {
    await runWorkflow();

    expect(mocks.publish.commitPublished).toHaveBeenCalledWith(
      expect.objectContaining({
        contentPageId: "page_new",
        publishedAt: "2026-08-01T10:00:00.000Z",
        adapterRef: "99",
        links: [
          { contentPageId: "page_a", path: "/compare/a/", outcome: "injected" },
        ],
      }),
    );
  });
});

describe("PublishWorkflow — preflight refusals", () => {
  it("writes nothing to the site when preflight refuses", async () => {
    mocks.publish.preflight.mockResolvedValue({
      ok: false,
      blocked: { reason: "laws_unmet", detail: "2 are unmet." },
    });

    await runWorkflow();

    expect(mocks.publish.ensureHub).not.toHaveBeenCalled();
    expect(mocks.publish.publishPost).not.toHaveBeenCalled();
    expect(mocks.links.injectLinks).not.toHaveBeenCalled();
    expect(mocks.publish.commitPublished).not.toHaveBeenCalled();
  });

  it("lands the article back in review with the reason", async () => {
    const blocked = {
      reason: "not_connected" as const,
      detail: "Connect a publish target before publishing.",
    };
    mocks.publish.preflight.mockResolvedValue({ ok: false, blocked });

    await runWorkflow();

    expect(mocks.publish.landBlocked).toHaveBeenCalledWith({
      articleId: "article_1",
      projectId: "project_1",
      blocked,
    });
    expect(stepOrder).toEqual(["preflight", "land-blocked"]);
  });
});

describe("PublishWorkflow — resuming", () => {
  it("does not create a second post when the article already has an adapterRef", async () => {
    // What the service returns for an article whose ref is already stored: the
    // step still runs, and still reports the post — it just did not make one.
    mocks.publish.publishPost.mockResolvedValue({
      adapter: "wordpress",
      adapterRef: "99",
      url: "https://acme.com/compare/espresso-tamper-sizes/",
      urlVerified: true,
      resumed: true,
      notes: [],
    });

    await runWorkflow();

    expect(mocks.publish.publishPost).toHaveBeenCalledTimes(1);
    expect(mocks.publish.commitPublished).toHaveBeenCalledWith(
      expect.objectContaining({ adapterRef: "99" }),
    );
  });

  it("finishes a resumed run all the way to the receipt", async () => {
    mocks.publish.preflight.mockResolvedValue({
      ok: true,
      context: { ...CONTEXT, adapterRef: "99" },
    });

    await runWorkflow();

    expect(stepOrder).toContain("receipt");
    expect(mocks.publish.commitPublished).toHaveBeenCalledTimes(1);
  });
});

describe("PublishWorkflow — what is fatal after the post is live", () => {
  it("still opens the receipt when link injection fails outright", async () => {
    mocks.links.injectLinks.mockRejectedValue(new Error("wp 500"));

    await runWorkflow();

    expect(mocks.publish.commitPublished).toHaveBeenCalledWith(
      expect.objectContaining({ links: [] }),
    );
  });

  it("still opens the receipt when the derived artifacts fail", async () => {
    mocks.links.wireDerivedArtifacts.mockRejectedValue(new Error("no branch"));

    await runWorkflow();

    expect(mocks.publish.commitPublished).toHaveBeenCalledTimes(1);
  });

  it("still opens the receipt when IndexNow refuses", async () => {
    mocks.publish.submitIndexNow.mockRejectedValue(new Error("403"));

    await runWorkflow();

    expect(mocks.publish.commitPublished).toHaveBeenCalledTimes(1);
  });

  it("gives the create step no retries — a retried create is a duplicate post", async () => {
    const configs: Record<string, unknown> = {};
    const fake = {
      do: (
        name: string,
        configOrFn: (() => Promise<unknown>) | Record<string, unknown>,
        maybeFn?: () => Promise<unknown>,
      ) => {
        if (typeof configOrFn !== "function") configs[name] = configOrFn;
        return typeof configOrFn === "function" ? configOrFn() : maybeFn?.();
      },
      sleep: vi.fn(),
    };
    const { PublishWorkflow } = await import("./PublishWorkflow");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double: ctx/env are never touched
    const workflow = new PublishWorkflow({} as ExecutionContext, {} as Env);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double: only do/sleep are exercised
    await workflow.run(makeEvent(), fake as unknown as WorkflowStep);

    // Read structurally rather than asserted into a shape: what this test is
    // about is the number the workflow registered, and a config that stopped
    // carrying `retries` at all should fail here rather than read as zero.
    const publishConfig = configs.publish;
    const retries =
      typeof publishConfig === "object" &&
      publishConfig !== null &&
      "retries" in publishConfig
        ? publishConfig.retries
        : null;
    expect(retries).toMatchObject({ limit: 0 });
  });
});
