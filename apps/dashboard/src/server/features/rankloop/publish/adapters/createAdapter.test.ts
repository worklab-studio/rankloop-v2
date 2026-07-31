import { describe, expect, it } from "vitest";
import { parseAdapterConfig } from "./config";
import { createPublishAdapter } from "./createAdapter";

const run = { slug: "aeropress-vs-v60" };

describe("parseAdapterConfig", () => {
  it("reads an S3b WordPress blob, which predates the shared settings", () => {
    const config = parseAdapterConfig("wordpress", {
      baseUrl: "https://blog.example.com",
      username: "beans",
      applicationPassword: "abcd efgh",
    });

    expect(config).toEqual({
      adapter: "wordpress",
      baseUrl: "https://blog.example.com",
      username: "beans",
      applicationPassword: "abcd efgh",
      // The safe default: a human sees the post before the world does.
      defaultPostStatus: "draft",
      linkInjection: true,
    });
  });

  it("keeps a stored publish-outright setting", () => {
    expect(
      parseAdapterConfig("wordpress", {
        baseUrl: "https://blog.example.com",
        username: "beans",
        applicationPassword: "abcd efgh",
        defaultPostStatus: "publish",
        linkInjection: false,
      }),
    ).toMatchObject({ defaultPostStatus: "publish", linkInjection: false });
  });

  it("defaults a GitHub connection to a pull request against main", () => {
    expect(
      parseAdapterConfig("github", {
        owner: "beans",
        repo: "beans.coffee",
        token: "ghp_x",
        siteUrl: "https://beans.coffee",
      }),
    ).toMatchObject({
      baseBranch: "main",
      contentDir: "content",
      publicDir: "public",
      commitMode: "pull-request",
    });
  });

  it("refuses a blob missing the fields its adapter needs, without echoing it", () => {
    const error = (() => {
      try {
        parseAdapterConfig("webhook", { url: "https://hooks.example.com" });
      } catch (caught: unknown) {
        return caught;
      }
      throw new Error("expected a rejection");
    })();

    expect(error).toMatchObject({ code: "PUBLISH_NOT_CONNECTED" });
    expect(String(error)).not.toContain("hooks.example.com");
  });
});

describe("createPublishAdapter", () => {
  it("builds the WordPress adapter", () => {
    const adapter = createPublishAdapter(
      {
        adapter: "wordpress",
        baseUrl: "https://blog.example.com",
        username: "beans",
        applicationPassword: "abcd efgh",
        defaultPostStatus: "draft",
        linkInjection: true,
      },
      run,
    );
    expect(adapter.capabilities.kind).toBe("wordpress");
    expect(typeof adapter.commitArtifacts).toBe("undefined");
  });

  it("builds the webhook adapter", () => {
    const adapter = createPublishAdapter(
      {
        adapter: "webhook",
        url: "https://hooks.example.com/rankloop",
        secret: "s3cr3t",
        siteUrl: "https://example.com",
        defaultPostStatus: "draft",
        linkInjection: true,
      },
      run,
    );
    expect(adapter.capabilities.kind).toBe("webhook");
    expect(typeof adapter.commitArtifacts).toBe("undefined");
  });

  it("builds the GitHub adapter, the only one that owns derived artifacts", () => {
    const adapter = createPublishAdapter(
      {
        adapter: "github",
        owner: "beans",
        repo: "beans.coffee",
        token: "ghp_x",
        baseBranch: "main",
        contentDir: "content",
        publicDir: "public",
        commitMode: "pull-request",
        siteUrl: "https://beans.coffee",
        defaultPostStatus: "draft",
        linkInjection: true,
      },
      run,
    );
    expect(adapter.capabilities.kind).toBe("github");
    expect(adapter.capabilities.ownsDerivedArtifacts).toBe(true);
    expect(typeof adapter.commitArtifacts).toBe("function");
  });

  it("gives every target the same five members, so callers never branch on the name", () => {
    const configs = [
      {
        adapter: "wordpress" as const,
        baseUrl: "https://blog.example.com",
        username: "beans",
        applicationPassword: "abcd efgh",
        defaultPostStatus: "draft" as const,
        linkInjection: true,
      },
      {
        adapter: "webhook" as const,
        url: "https://hooks.example.com/rankloop",
        secret: "s3cr3t",
        siteUrl: "https://example.com",
        defaultPostStatus: "draft" as const,
        linkInjection: true,
      },
      {
        adapter: "github" as const,
        owner: "beans",
        repo: "beans.coffee",
        token: "ghp_x",
        baseBranch: "main",
        contentDir: "content",
        publicDir: "public",
        commitMode: "pull-request" as const,
        siteUrl: "https://beans.coffee",
        defaultPostStatus: "draft" as const,
        linkInjection: true,
      },
    ];

    for (const config of configs) {
      const adapter = createPublishAdapter(config, run);
      expect(typeof adapter.ensureHub).toBe("function");
      expect(typeof adapter.createPost).toBe("function");
      expect(typeof adapter.getPost).toBe("function");
      expect(typeof adapter.updatePost).toBe("function");
      expect(adapter.capabilities.label.length).toBeGreaterThan(0);
    }
  });
});
