import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { z } from "zod";
import { getAuth } from "@/lib/auth";
import { PublishConnectionRepository } from "@/server/features/rankloop/publish/repositories/PublishConnectionRepository";
import { AppError } from "@/server/lib/errors";
import type { MaskedPublishConnection } from "@/types/schemas/rankloopPublish";
import { WordPressClient } from "./wordpressClient";
import type { WordPressConfig } from "./wordpressClient";

// The decrypt path re-validates because configJson is data at rest — a shape
// drift after some future adapter migration should fail loudly here, not
// three calls deep inside a fetch.
const wordpressConfigSchema = z.object({
  baseUrl: z.string(),
  username: z.string(),
  applicationPassword: z.string(),
});

/** Same key contract as the self-hosted GSC OAuth grant (gsc/
 *  selfHostedOAuth.ts): BETTER_AUTH_SECRET via Better Auth's secretConfig,
 *  so the operator manages exactly one secret. Unlike the OAuth path there
 *  is no encryptOAuthTokens gate — application passwords are always
 *  encrypted at rest. */
async function cipherKey() {
  const ctx = await getAuth().$context;
  return ctx.secretConfig;
}

async function decryptConfig(configJson: string): Promise<WordPressConfig> {
  const decrypted = await symmetricDecrypt({
    key: await cipherKey(),
    data: configJson,
  });
  const parsed: unknown = JSON.parse(decrypted);
  return wordpressConfigSchema.parse(parsed);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

async function saveConnection(input: {
  projectId: string;
  adapter: "wordpress";
  baseUrl: string;
  username: string;
  applicationPassword?: string;
}): Promise<MaskedPublishConnection> {
  // Trailing slashes multiply ("…com//wp-json/…") — normalize once at save.
  const baseUrl = input.baseUrl.replace(/\/+$/, "");
  let applicationPassword = input.applicationPassword;
  if (applicationPassword === undefined) {
    // Masked read-back means the settings form can't round-trip the
    // password — an edit that leaves it blank keeps the stored one.
    const existing = await getDecryptedConfig(input.projectId);
    if (!existing) {
      throw new AppError(
        "VALIDATION_ERROR",
        "An application password is required to connect WordPress.",
      );
    }
    applicationPassword = existing.applicationPassword;
  }
  const configJson = await symmetricEncrypt({
    key: await cipherKey(),
    data: JSON.stringify({
      baseUrl,
      username: input.username,
      applicationPassword,
    }),
  });
  const row = await PublishConnectionRepository.upsert({
    projectId: input.projectId,
    adapter: input.adapter,
    configJson,
  });
  return {
    adapter: row.adapter,
    status: row.status,
    lastCheckedAt: row.lastCheckedAt,
    config: { baseUrl, username: input.username, hasPassword: true },
  };
}

/** The only connection read that crosses the wire: the password comes back
 *  as a hasPassword flag, never as a value (spec 0013 acceptance 4). */
async function getMaskedConnection(
  projectId: string,
): Promise<MaskedPublishConnection | null> {
  const row = await PublishConnectionRepository.getForProject(projectId);
  if (!row) return null;
  const config = await decryptConfig(row.configJson);
  return {
    adapter: row.adapter,
    status: row.status,
    lastCheckedAt: row.lastCheckedAt,
    config: {
      baseUrl: config.baseUrl,
      username: config.username,
      hasPassword: config.applicationPassword.length > 0,
    },
  };
}

/** Server-side only — the decrypted config feeds the adapter and must never
 *  be returned from a server function. */
async function getDecryptedConfig(
  projectId: string,
): Promise<WordPressConfig | null> {
  const row = await PublishConnectionRepository.getForProject(projectId);
  if (!row) return null;
  return decryptConfig(row.configJson);
}

async function testConnection(
  projectId: string,
): Promise<{ status: "ok" | "failed"; lastCheckedAt: string }> {
  const config = await getDecryptedConfig(projectId);
  if (!config) {
    throw new AppError(
      "PUBLISH_NOT_CONNECTED",
      "Save a WordPress connection before testing it.",
    );
  }
  const lastCheckedAt = new Date().toISOString();
  let status: "ok" | "failed" = "ok";
  try {
    await WordPressClient.testConnection(config);
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

export const PublishConnectionService = {
  saveConnection,
  getMaskedConnection,
  getDecryptedConfig,
  testConnection,
};
