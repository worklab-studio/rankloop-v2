import { describe, expect, it, vi } from "vitest";

// The one hop the S8a follow-up left untested: a stored GitHub blob's
// `commitMode` becoming the `directCommit` flag every surface branches on.
// PublishPlanService's tests stub this function, so without this file the
// chain from "what the user saved" to "what the panel promises" is proved at
// both ends and nowhere in the middle — which is exactly where the original
// bug lived (it read publishedUrl confidence instead of the setting).

const mocks = vi.hoisted(() => ({
  repo: { getForProject: vi.fn() },
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock(
  "@/server/features/rankloop/publish/repositories/PublishConnectionRepository",
  () => ({ PublishConnectionRepository: mocks.repo }),
);
vi.mock("@/lib/auth", () => ({
  getAuth: () => ({ $context: Promise.resolve({ secretConfig: "key" }) }),
}));
// The blob arrives already ciphertext-shaped; this test is about what the
// parsed settings say, not about the cipher.
vi.mock("better-auth/crypto", () => ({
  symmetricDecrypt: ({ data }: { data: string }) => Promise.resolve(data),
}));

function storedGitHub(commitMode: "pull-request" | "direct") {
  mocks.repo.getForProject.mockResolvedValue({
    adapter: "github",
    configJson: JSON.stringify({
      owner: "beans",
      repo: "beans.coffee",
      token: "ghp_x",
      siteUrl: "https://beans.coffee",
      commitMode,
    }),
  });
}

async function resolve() {
  const { resolvePublishAdapter } = await import("./resolve");
  return resolvePublishAdapter("project_1", { slug: "aeropress-vs-v60" });
}

describe("resolvePublishAdapter", () => {
  it("carries a direct-commit connection through as directCommit", async () => {
    storedGitHub("direct");

    expect((await resolve())?.settings.directCommit).toBe(true);
  });

  it("leaves the default pull-request connection false", async () => {
    storedGitHub("pull-request");

    expect((await resolve())?.settings.directCommit).toBe(false);
  });

  it("is false for a target with no such choice to make", async () => {
    mocks.repo.getForProject.mockResolvedValue({
      adapter: "wordpress",
      configJson: JSON.stringify({
        baseUrl: "https://blog.example.com",
        username: "beans",
        applicationPassword: "abcd efgh",
      }),
    });

    expect((await resolve())?.settings.directCommit).toBe(false);
  });
});
