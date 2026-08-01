import { env } from "cloudflare:workers";
import {
  getContactNameParts,
  updateLoopsContact,
} from "@/server/email/loops-client";

const LOOPS_TRANSACTIONAL_URL = "https://app.loops.so/api/v1/transactional";

function getOptionalEnv(name: string) {
  const value: unknown = Reflect.get(env, name);
  const trimmed = typeof value === "string" ? value.trim() : "";

  return trimmed || null;
}

function getRequiredEnv(name: string) {
  const value = getOptionalEnv(name);

  if (!value) {
    throw new Error(`${name} is required in hosted mode`);
  }

  return value;
}

function getHostedAuthEmailConfig() {
  return {
    apiKey: getRequiredEnv("LOOPS_API_KEY"),
    verificationTemplateId: getRequiredEnv(
      "LOOPS_TRANSACTIONAL_VERIFY_EMAIL_ID",
    ),
    passwordResetTemplateId: getRequiredEnv(
      "LOOPS_TRANSACTIONAL_RESET_PASSWORD_ID",
    ),
  };
}

async function sendLoopsTransactionalEmail({
  apiKey,
  email,
  transactionalId,
  dataVariables,
}: {
  apiKey: string;
  email: string;
  transactionalId: string;
  dataVariables: Record<string, string>;
}) {
  const response = await fetch(LOOPS_TRANSACTIONAL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      transactionalId,
      email,
      addToAudience: false,
      dataVariables,
    }),
  });

  if (response.ok) {
    return;
  }

  const errorPayload = await response.json().catch(() => null);
  console.error("Loops transactional email error:", {
    status: response.status,
    email,
    transactionalId,
    errorPayload,
  });

  throw new Error(
    `Failed to send Loops transactional email (${response.status})`,
  );
}

export async function upsertHostedSignupContact({
  userId,
  email,
  name,
}: {
  userId: string;
  email: string;
  name?: string | null;
}) {
  const apiKey = getOptionalEnv("LOOPS_API_KEY");

  if (!apiKey) {
    console.warn(
      "Skipping Loops signup contact sync: LOOPS_API_KEY is not set",
    );
    return;
  }

  await updateLoopsContact({
    apiKey,
    payload: {
      email,
      userId,
      source: "openseo-signup",
      userGroup: "app-user",
      ...getContactNameParts(name),
    },
    logContext: { action: "signup-contact-sync" },
  });
}

export async function sendHostedVerificationEmail({
  email,
  confirmationUrl,
}: {
  email: string;
  confirmationUrl: string;
}) {
  const config = getHostedAuthEmailConfig();
  await sendLoopsTransactionalEmail({
    apiKey: config.apiKey,
    email,
    transactionalId: config.verificationTemplateId,
    dataVariables: {
      appName: "OpenSEO",
      confirmationUrl,
    },
  });
}

/**
 * Whether this deployment can mail a rankloop digest at all.
 *
 * A question rather than a throw, unlike the auth emails above: verification
 * mail is load-bearing in hosted mode and a missing key there is a broken
 * deployment, whereas the digest is an optional channel that most self-hosted
 * installs will never configure. The caller needs "not configured" and "the
 * send failed" to be different answers, because only one of them is worth
 * telling the operator about every morning.
 */
export function isDigestEmailConfigured(): boolean {
  return getDigestEmailConfig() !== null;
}

function getDigestEmailConfig() {
  const apiKey = getOptionalEnv("LOOPS_API_KEY");
  const transactionalId = getOptionalEnv("LOOPS_TRANSACTIONAL_DIGEST_ID");
  if (!apiKey || !transactionalId) return null;
  return { apiKey, transactionalId };
}

/** Send one morning digest. Throws on a rejected send — the routine records
 *  that as the day's delivery failure and carries on. */
export async function sendRankloopDigestEmail({
  email,
  dataVariables,
}: {
  email: string;
  dataVariables: Record<string, string>;
}) {
  const config = getDigestEmailConfig();
  if (!config) {
    throw new Error("LOOPS_TRANSACTIONAL_DIGEST_ID is not configured");
  }
  await sendLoopsTransactionalEmail({
    apiKey: config.apiKey,
    email,
    transactionalId: config.transactionalId,
    dataVariables,
  });
}

export async function sendHostedPasswordResetEmail({
  email,
  resetUrl,
}: {
  email: string;
  resetUrl: string;
}) {
  const config = getHostedAuthEmailConfig();
  await sendLoopsTransactionalEmail({
    apiKey: config.apiKey,
    email,
    transactionalId: config.passwordResetTemplateId,
    dataVariables: {
      appName: "OpenSEO",
      resetUrl,
    },
  });
}
