import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";

type StoredRow = {
  id: string;
  projectId: string;
  adapter: "wordpress" | "webhook" | "github";
  configJson: string;
  status: "unconfigured" | "ok" | "failed";
  lastCheckedAt: string | null;
};

type UpsertInput = {
  projectId: string;
  adapter: "wordpress" | "webhook" | "github";
  configJson: string;
};

// Typed so the assertions below can read `.mock.calls` without unsafe casts.
const mocks = vi.hoisted(() => ({
  repo: {
    getForProject: vi.fn<(projectId: string) => Promise<StoredRow | null>>(),
    upsert: vi.fn<(data: UpsertInput) => Promise<StoredRow>>(),
    setStatus: vi.fn(),
  },
  wp: {
    testConnection: vi.fn(),
    findPostBySlug: vi.fn(),
    updatePost: vi.fn(),
  },
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
// A real 32-char secret so the round-trip below exercises the real
// symmetricEncrypt/Decrypt pair — the whole point is proving stored
// configJson is ciphertext, not asserting that a mock was called.
vi.mock("@/lib/auth", () => ({
  getAuth: () => ({
    $context: Promise.resolve({
      secretConfig: "0123456789abcdef0123456789abcdef",
    }),
  }),
}));
vi.mock(
  "@/server/features/rankloop/publish/repositories/PublishConnectionRepository",
  () => ({ PublishConnectionRepository: mocks.repo }),
);
vi.mock("./wordpressClient", () => ({ WordPressClient: mocks.wp }));

const password = "abcd efgh ijkl mnop qrst uvwx";

const input = {
  projectId: "project_1",
  config: {
    adapter: "wordpress" as const,
    defaultPostStatus: "draft" as const,
    linkInjection: true,
    baseUrl: "https://blog.example.com/",
    username: "beans",
    applicationPassword: password,
  },
};

function lastUpsert(): UpsertInput {
  const call = mocks.repo.upsert.mock.calls.at(-1)?.[0];
  if (!call) throw new Error("expected an upsert call");
  return call;
}

function storedRowFromLastUpsert(): StoredRow {
  return {
    id: "conn_1",
    ...lastUpsert(),
    status: "unconfigured",
    lastCheckedAt: null,
  };
}

async function importService() {
  const { PublishConnectionService } =
    await import("./PublishConnectionService");
  return PublishConnectionService;
}

beforeEach(() => {
  for (const group of Object.values(mocks)) {
    for (const mock of Object.values(group)) mock.mockReset();
  }
  mocks.repo.upsert.mockImplementation((data) =>
    Promise.resolve({
      id: "conn_1",
      ...data,
      status: "unconfigured",
      lastCheckedAt: null,
    }),
  );
});

describe("PublishConnectionService.saveConnection", () => {
  it("stores ciphertext — the stored configJson never contains the credentials", async () => {
    const service = await importService();

    const masked = await service.saveConnection(input);

    const stored = lastUpsert();
    expect(stored.projectId).toBe("project_1");
    expect(stored.adapter).toBe("wordpress");
    expect(stored.configJson).not.toContain(password);
    expect(stored.configJson).not.toContain("applicationPassword");
    expect(stored.configJson).not.toContain(input.config.username);
    // Trailing slash normalized at save, and the read-back is masked.
    expect(masked).toEqual({
      adapter: "wordpress",
      status: "unconfigured",
      lastCheckedAt: null,
      config: {
        adapter: "wordpress",
        baseUrl: "https://blog.example.com",
        username: "beans",
        defaultPostStatus: "draft",
        linkInjection: true,
        hasSecret: true,
      },
    });
  });

  it("round-trips: the stored ciphertext decrypts back to the saved config", async () => {
    const service = await importService();
    await service.saveConnection(input);
    mocks.repo.getForProject.mockResolvedValue(storedRowFromLastUpsert());

    const config = await service.getDecryptedConfig("project_1");

    expect(config).toEqual({
      baseUrl: "https://blog.example.com",
      username: "beans",
      applicationPassword: password,
    });
  });

  it("keeps the stored password when a re-save omits it", async () => {
    const service = await importService();
    await service.saveConnection(input);
    mocks.repo.getForProject.mockResolvedValue(storedRowFromLastUpsert());

    await service.saveConnection({
      projectId: "project_1",
      config: {
        ...input.config,
        username: "renamed",
        applicationPassword: undefined,
      },
    });
    mocks.repo.getForProject.mockResolvedValue(storedRowFromLastUpsert());

    const config = await service.getDecryptedConfig("project_1");
    expect(config).toEqual({
      baseUrl: "https://blog.example.com",
      username: "renamed",
      applicationPassword: password,
    });
  });

  it("rejects a first save without a password", async () => {
    const service = await importService();
    mocks.repo.getForProject.mockResolvedValue(null);

    await expect(
      service.saveConnection({
        projectId: "project_1",
        config: { ...input.config, applicationPassword: undefined },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(mocks.repo.upsert).not.toHaveBeenCalled();
  });

  // The three targets keep three different credentials, and the save path only
  // knows which one it is holding through `secretOf`. A github save that lost
  // its token to the wordpress branch would store a connection that cannot
  // authenticate, so the round-trip is asserted per adapter.
  it("round-trips a GitHub connection, token and all", async () => {
    const service = await importService();
    mocks.repo.getForProject.mockResolvedValue(null);

    const masked = await service.saveConnection({
      projectId: "project_1",
      config: {
        adapter: "github",
        defaultPostStatus: "draft",
        linkInjection: true,
        owner: "acme",
        repo: "site",
        token: "github_pat_secret",
        baseBranch: "main",
        contentDir: "content",
        publicDir: "public",
        commitMode: "pull-request",
        siteUrl: "https://acme.com/",
      },
    });

    expect(lastUpsert().adapter).toBe("github");
    expect(lastUpsert().configJson).not.toContain("github_pat_secret");
    expect(masked.config).toEqual({
      adapter: "github",
      owner: "acme",
      repo: "site",
      baseBranch: "main",
      contentDir: "content",
      publicDir: "public",
      commitMode: "pull-request",
      siteUrl: "https://acme.com",
      defaultPostStatus: "draft",
      linkInjection: true,
      hasSecret: true,
    });
    expect(JSON.stringify(masked)).not.toContain("github_pat_secret");
    // A github connection is not a WordPress one: the S3b retitle path asks
    // for a WordPress config and must be told there isn't one, rather than
    // handed a config that would 401.
    mocks.repo.getForProject.mockResolvedValue({
      ...storedRowFromLastUpsert(),
      adapter: "github",
    });
    await expect(service.getDecryptedConfig("project_1")).resolves.toBeNull();
  });

  it("won't inherit a secret across a target switch", async () => {
    const service = await importService();
    await service.saveConnection(input);
    mocks.repo.getForProject.mockResolvedValue(storedRowFromLastUpsert());

    await expect(
      service.saveConnection({
        projectId: "project_1",
        config: {
          adapter: "webhook",
          defaultPostStatus: "draft",
          linkInjection: true,
          url: "https://example.com/hooks/rankloop",
          secret: undefined,
          siteUrl: "https://example.com",
        },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("PublishConnectionService.getMaskedConnection", () => {
  it("returns null when no connection exists", async () => {
    const service = await importService();
    mocks.repo.getForProject.mockResolvedValue(null);

    await expect(service.getMaskedConnection("project_1")).resolves.toBeNull();
  });

  it("masks the password to a hasPassword flag", async () => {
    const service = await importService();
    await service.saveConnection(input);
    mocks.repo.getForProject.mockResolvedValue({
      ...storedRowFromLastUpsert(),
      status: "ok",
      lastCheckedAt: "2026-07-31T12:00:00.000Z",
    });

    const masked = await service.getMaskedConnection("project_1");

    expect(masked).toEqual({
      adapter: "wordpress",
      status: "ok",
      lastCheckedAt: "2026-07-31T12:00:00.000Z",
      config: {
        adapter: "wordpress",
        baseUrl: "https://blog.example.com",
        username: "beans",
        defaultPostStatus: "draft",
        linkInjection: true,
        hasSecret: true,
      },
    });
    expect(JSON.stringify(masked)).not.toContain(password);
  });
});

describe("PublishConnectionService.testConnection", () => {
  async function savedService() {
    const service = await importService();
    await service.saveConnection(input);
    mocks.repo.getForProject.mockResolvedValue(storedRowFromLastUpsert());
    return service;
  }

  it("records 'ok' when both probes pass", async () => {
    const service = await savedService();
    mocks.wp.testConnection.mockResolvedValue(undefined);

    const result = await service.testConnection("project_1");

    expect(result.status).toBe("ok");
    expect(mocks.repo.setStatus).toHaveBeenCalledWith({
      projectId: "project_1",
      status: "ok",
      lastCheckedAt: result.lastCheckedAt,
    });
  });

  it("records a failed probe as the 'failed' verdict instead of throwing", async () => {
    const service = await savedService();
    mocks.wp.testConnection.mockRejectedValue(
      new AppError("PUBLISH_AUTH_FAILED", "WordPress returned 401."),
    );

    const result = await service.testConnection("project_1");

    expect(result.status).toBe("failed");
    expect(mocks.repo.setStatus).toHaveBeenCalledWith({
      projectId: "project_1",
      status: "failed",
      lastCheckedAt: result.lastCheckedAt,
    });
  });

  it("lets a non-adapter error keep propagating — that is a bug, not a verdict", async () => {
    const service = await savedService();
    mocks.wp.testConnection.mockRejectedValue(new TypeError("boom"));

    await expect(service.testConnection("project_1")).rejects.toThrow(
      TypeError,
    );
    expect(mocks.repo.setStatus).not.toHaveBeenCalled();
  });

  it("throws PUBLISH_NOT_CONNECTED when nothing is saved", async () => {
    const service = await importService();
    mocks.repo.getForProject.mockResolvedValue(null);

    await expect(service.testConnection("project_1")).rejects.toMatchObject({
      code: "PUBLISH_NOT_CONNECTED",
    });
  });
});
