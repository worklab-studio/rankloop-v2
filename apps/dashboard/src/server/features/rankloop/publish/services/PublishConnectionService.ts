import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { getAuth } from "@/lib/auth";
import {
  type GitHubAdapterConfig,
  parseAdapterConfig,
  type PublishAdapterConfig,
} from "@/server/features/rankloop/publish/adapters/config";
import { testGitHubConnection } from "@/server/features/rankloop/publish/adapters/github";
import { testWebhookConnection } from "@/server/features/rankloop/publish/adapters/webhook";
import { PublishConnectionRepository } from "@/server/features/rankloop/publish/repositories/PublishConnectionRepository";
import { AppError } from "@/server/lib/errors";
import type {
  MaskedPublishConnection,
  SavePublishConnectionConfig,
} from "@/types/schemas/rankloopPublish";
import { WordPressClient } from "./wordpressClient";
import type { WordPressConfig } from "./wordpressClient";

/** Same key contract as the self-hosted GSC OAuth grant (gsc/
 *  selfHostedOAuth.ts): BETTER_AUTH_SECRET via Better Auth's secretConfig,
 *  so the operator manages exactly one secret. Unlike the OAuth path there
 *  is no encryptOAuthTokens gate — publish credentials are always encrypted
 *  at rest. */
async function cipherKey() {
  const ctx = await getAuth().$context;
  return ctx.secretConfig;
}

/** The decrypt path re-validates because configJson is data at rest — a shape
 *  drift after some future adapter migration should fail loudly here, not
 *  three calls deep inside a fetch. `parseAdapterConfig` is the one parser,
 *  shared with the adapter resolver. */
async function decryptConfig(
  adapter: PublishAdapterConfig["adapter"],
  configJson: string,
): Promise<PublishAdapterConfig> {
  const decrypted = await symmetricDecrypt({
    key: await cipherKey(),
    data: configJson,
  });
  const parsed: unknown = JSON.parse(decrypted);
  return parseAdapterConfig(adapter, parsed);
}

async function readStoredConfig(
  projectId: string,
): Promise<PublishAdapterConfig | null> {
  const row = await PublishConnectionRepository.getForProject(projectId);
  if (!row) return null;
  return decryptConfig(row.adapter, row.configJson);
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/** The one credential each adapter holds. Named in one place so the save path
 *  can carry a stored secret forward without knowing which adapter it is
 *  holding, and so a fourth adapter cannot be added without deciding this. */
function secretOf(config: PublishAdapterConfig): string {
  switch (config.adapter) {
    case "wordpress":
      return config.applicationPassword;
    case "webhook":
      return config.secret;
    case "github":
      return config.token;
  }
}

/**
 * The submitted config with its secret filled in from storage when the form
 * left it blank.
 *
 * A blank secret means "keep the stored one" — the masked read-back cannot
 * round-trip a credential, so an edit that only fixes a typo in the URL must
 * not wipe a working one. A stored secret only carries forward within the same
 * adapter: switching targets is a new credential, not an inherited one.
 */
async function withStoredSecret(
  projectId: string,
  input: SavePublishConnectionConfig,
): Promise<PublishAdapterConfig> {
  switch (input.adapter) {
    case "wordpress":
      return {
        ...input,
        applicationPassword: await resolveSecret(
          projectId,
          input.adapter,
          input.applicationPassword,
        ),
      };
    case "webhook":
      return {
        ...input,
        secret: await resolveSecret(projectId, input.adapter, input.secret),
      };
    case "github":
      return {
        ...input,
        token: await resolveSecret(projectId, input.adapter, input.token),
      };
  }
}

/** The typed secret, or the stored one it deliberately left blank. Throws when
 *  there is neither — a first save has nothing to inherit. */
async function resolveSecret(
  projectId: string,
  adapter: SavePublishConnectionConfig["adapter"],
  typed: string | undefined,
): Promise<string> {
  if (typed !== undefined && typed !== "") return typed;
  const stored = await readStoredConfig(projectId);
  const carried = stored && stored.adapter === adapter ? secretOf(stored) : "";
  if (carried === "") {
    throw new AppError(
      "VALIDATION_ERROR",
      "A credential is required to connect this target.",
    );
  }
  return carried;
}

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

/** The readable half of a config, plus the flags. Everything a secret could
 *  become on this side of the wire is a boolean. */
function maskConfig(
  config: PublishAdapterConfig,
): MaskedPublishConnection["config"] {
  const shared = {
    defaultPostStatus: config.defaultPostStatus,
    linkInjection: config.linkInjection,
    hasSecret: secretOf(config).length > 0,
  };
  switch (config.adapter) {
    case "wordpress":
      return {
        adapter: "wordpress",
        baseUrl: config.baseUrl,
        username: config.username,
        ...shared,
      };
    case "webhook":
      return {
        adapter: "webhook",
        url: config.url,
        siteUrl: config.siteUrl,
        ...shared,
      };
    case "github":
      return {
        adapter: "github",
        owner: config.owner,
        repo: config.repo,
        baseBranch: config.baseBranch,
        contentDir: config.contentDir,
        publicDir: config.publicDir,
        commitMode: config.commitMode,
        siteUrl: config.siteUrl,
        ...shared,
      };
  }
}

/** Trailing slashes multiply ("…com//wp-json/…") — normalize once at save. */
function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeUrls(config: PublishAdapterConfig): PublishAdapterConfig {
  switch (config.adapter) {
    case "wordpress":
      return { ...config, baseUrl: trimSlash(config.baseUrl) };
    case "webhook":
      return { ...config, siteUrl: trimSlash(config.siteUrl) };
    case "github":
      return { ...config, siteUrl: trimSlash(config.siteUrl) };
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

async function saveConnection(input: {
  projectId: string;
  config: SavePublishConnectionConfig;
}): Promise<MaskedPublishConnection> {
  const config = normalizeUrls(
    await withStoredSecret(input.projectId, input.config),
  );
  // The adapter name lives in its own column, so it is stripped from the blob
  // — that is what makes a row saved by S3b (which had no such key) parse.
  const { adapter, ...blob } = config;
  const configJson = await symmetricEncrypt({
    key: await cipherKey(),
    data: JSON.stringify(blob),
  });
  const row = await PublishConnectionRepository.upsert({
    projectId: input.projectId,
    adapter,
    configJson,
  });
  return {
    adapter: row.adapter,
    status: row.status,
    lastCheckedAt: row.lastCheckedAt,
    config: maskConfig(config),
  };
}

/** The only connection read that crosses the wire: the credential comes back
 *  as a hasSecret flag, never as a value (spec 0013 acceptance 4). */
async function getMaskedConnection(
  projectId: string,
): Promise<MaskedPublishConnection | null> {
  const row = await PublishConnectionRepository.getForProject(projectId);
  if (!row) return null;
  const config = await decryptConfig(row.adapter, row.configJson);
  return {
    adapter: row.adapter,
    status: row.status,
    lastCheckedAt: row.lastCheckedAt,
    config: maskConfig(config),
  };
}

/**
 * Server-side only — the decrypted WordPress config, for the S3b execution
 * paths (retitle, push guidance) that talk to WordPress directly.
 *
 * Null when the project publishes somewhere else: a retitle proposal has no
 * meaning against a repository or a webhook, and answering with a config the
 * WordPress client cannot use would turn that into a 401 instead of a
 * sentence. Returns exactly the three fields that client needs — the publish
 * settings ride along in the blob and are none of its business.
 */
async function getDecryptedConfig(
  projectId: string,
): Promise<WordPressConfig | null> {
  const config = await readStoredConfig(projectId);
  if (!config || config.adapter !== "wordpress") return null;
  return {
    baseUrl: config.baseUrl,
    username: config.username,
    applicationPassword: config.applicationPassword,
  };
}

/**
 * Read-only where a read-only probe exists, and a declared test event where
 * one does not.
 *
 * WordPress and GitHub are asked something harmless (the REST root, the base
 * branch's head). A webhook has nothing to read, so it gets one signed
 * `connection.test` envelope carrying no article — a receiver can ignore it
 * and still answer 200, which is exactly what the probe is checking.
 */
async function testConnection(
  projectId: string,
): Promise<{ status: "ok" | "failed"; lastCheckedAt: string }> {
  const config = await readStoredConfig(projectId);
  if (!config) {
    throw new AppError(
      "PUBLISH_NOT_CONNECTED",
      "Save a publishing connection before testing it.",
    );
  }
  const lastCheckedAt = new Date().toISOString();
  let status: "ok" | "failed" = "ok";
  try {
    await probe(config);
  } catch (error) {
    // A failed probe is a verdict, not an exception — the settings panel
    // renders it as the 'failed' chip next to lastCheckedAt. Anything that
    // isn't an adapter AppError is a real bug and keeps propagating.
    if (!(error instanceof AppError)) throw error;
    status = "failed";
  }
  await PublishConnectionRepository.setStatus({
    projectId,
    status,
    lastCheckedAt,
  });
  return { status, lastCheckedAt };
}

async function probe(config: PublishAdapterConfig): Promise<void> {
  switch (config.adapter) {
    case "wordpress":
      return WordPressClient.testConnection(config);
    case "webhook":
      return testWebhookConnection(config);
    case "github":
      return testGitHubConnection(config);
  }
}

/**
 * The decrypted GitHub config, or null when this project publishes some
 * other way.
 *
 * Mirrors `getDecryptedConfig` for WordPress rather than exposing
 * `readStoredConfig`: a caller that can reach every adapter's secrets is a
 * caller that can leak the wrong one, and repo mode only ever needs this.
 */
async function getDecryptedGitHubConfig(
  projectId: string,
): Promise<GitHubAdapterConfig | null> {
  const config = await readStoredConfig(projectId);
  if (!config || config.adapter !== "github") return null;
  return config;
}

export const PublishConnectionService = {
  saveConnection,
  getMaskedConnection,
  getDecryptedConfig,
  getDecryptedGitHubConfig,
  testConnection,
};
