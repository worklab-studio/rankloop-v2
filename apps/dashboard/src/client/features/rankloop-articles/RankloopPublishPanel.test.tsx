import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The one branch of this panel that has no pure module under it: a project
// with no publish connection gets a pitch instead of a button, and every other
// part of that decision (the sentence, the caveat, the receipt) is already
// covered by publishPlan.logic.test.ts. Rendering the component to a string is
// enough to prove the branch paints — react-dom/server needs no DOM, so this
// stays inside vitest's node environment like every other test here.
//
// It is also the reason vitest.config.ts collects .test.tsx: it used to
// collect .test.ts only, so a file like this one would have run zero
// assertions and reported nothing.

const mocks = vi.hoisted(() => ({
  query: {
    isPending: false,
    isError: false,
    error: null as unknown,
    data: null as unknown,
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => mocks.query,
  useMutation: () => ({ mutate: () => {}, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    className,
    children,
  }: {
    to: string;
    className?: string;
    children: React.ReactNode;
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));
vi.mock("sonner", () => ({ toast: { success: () => {}, error: () => {} } }));
vi.mock("@/client/lib/posthog", () => ({ captureClientEvent: () => {} }));
vi.mock("@/serverFunctions/rankloopPublishArticle", () => ({
  getRankloopPublishPlan: () => Promise.resolve(null),
  publishRankloopArticle: () => Promise.resolve(null),
}));

async function render(plan: unknown): Promise<string> {
  mocks.query.data = plan;
  const { RankloopPublishPanel } = await import("./RankloopPublishPanel");
  return renderToStaticMarkup(
    <RankloopPublishPanel
      projectId="project_1"
      articleId="article_1"
      status="approved"
    />,
  );
}

const unconnectedPlan = {
  action: "creates-draft",
  target: "",
  hub: null,
  linkTargets: [],
  linkInjection: false,
  capabilities: null,
  blockedReason: null,
  published: null,
};

describe("RankloopPublishPanel", () => {
  it("paints the setup pitch when the project has no publish connection", async () => {
    const html = await render(unconnectedPlan);

    expect(html).toContain(
      "Connect your site and rankloop lands this draft on it",
    );
    expect(html).toContain("Set up publishing");
  });

  it("offers no Publish button while there is nowhere to publish to", async () => {
    const html = await render(unconnectedPlan);

    expect(html).not.toContain("<button");
  });

  it("carries this URL's own indexation verdict on the receipt", async () => {
    const html = await render({
      ...unconnectedPlan,
      published: {
        url: "https://acme.com/compare/tampers/",
        urlConfidence: "verified",
        hubPath: null,
        links: [],
        indexation: {
          verdict: "FAIL",
          coverageState: "Crawled - currently not indexed",
          checkedAt: new Date(Date.now() - 86_400_000).toISOString(),
        },
      },
    });

    expect(html).toContain("crawled, not indexed · checked yesterday");
    expect(html).toContain("text-error");
  });

  it("promises the run instead of the pitch once a target is connected", async () => {
    const html = await render({
      ...unconnectedPlan,
      target: "acme/site",
      action: "commits",
      capabilities: { kind: "github", label: "acme/site" },
    });

    expect(html).toContain("Commits the post to acme/site.");
    expect(html).toContain("Publish</button>");
  });

  it("says pull request for the same GitHub target when the connection is not set to commit directly", async () => {
    // The S8a follow-up, in the one place a user actually reads it: both
    // GitHub branches are the same adapter and the same capabilities, so the
    // only thing that can tell them apart is the stored commit mode the plan
    // carries. A direct-commit connection described as opening a PR sends
    // someone looking for a review that will never exist.
    const html = await render({
      ...unconnectedPlan,
      target: "acme/site",
      action: "opens-pull-request",
      capabilities: { kind: "github", label: "acme/site" },
    });

    expect(html).toContain("Opens a pull request on acme/site.");
    expect(html).not.toContain("Commits the post to");
  });
});
