// Where the morning digest goes (spec 0025 §"Digest delivery"). S9 wrote the
// row and left `deliveredJson` null; this file fills it in.
//
// The rule the whole file is built around: **a delivery problem is never a
// routine failure.** The digest has already been stored by the time anything
// here runs, so a bounced email or a 500 from someone's endpoint costs the
// operator a notification, not their morning run. Every channel therefore
// records what happened — including that it could not happen — and nothing in
// this file throws. That log is also what makes "I never got the email"
// answerable from the card instead of from the logs.

import { getAuth } from "@/lib/auth";
import {
  isDigestEmailConfigured,
  sendRankloopDigestEmail,
} from "@/server/email/loops";
import {
  EVENT_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signEnvelope,
} from "@/server/features/rankloop/publish/adapters/webhook";
import {
  DIGEST_WEBHOOK_EVENT,
  digestEmailVariables,
  digestEnvelope,
} from "@/server/features/rankloop/routines/digestDelivery.logic";
import { DigestRepository } from "@/server/features/rankloop/routines/repositories/DigestRepository";
import type {
  DigestDelivery,
  DigestPayload,
} from "@/types/schemas/rankloopRoutines";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How much of a failure the log keeps. Long enough for a status code and a
 *  provider's sentence, short enough that a receiver answering with an HTML
 *  error page cannot put a kilobyte of markup in every digest row. */
const MAX_DELIVERY_ERROR_CHARS = 200;

/**
 * Namespaces the webhook secret's derivation.
 *
 * It sits where `signEnvelope` puts the timestamp, which is exactly the
 * position that keeps one signed domain from colliding with another — the
 * derived secret can never be mistaken for, or produced by, an envelope
 * signature.
 */
const DIGEST_SECRET_LABEL = "rankloop:digest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A bounded echo of what went wrong, for a column the operator reads. The
 *  message only — never the cause chain, which on a fetch failure can carry
 *  the request that produced it. */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_DELIVERY_ERROR_CHARS);
}

function failed(
  channel: DigestDelivery["channel"],
  at: string,
  error: string,
): DigestDelivery {
  return { channel, status: "failed", at, error };
}

/**
 * The per-project secret the digest envelope is signed with, or null when this
 * deployment has no secret to derive one from.
 *
 * Derived from the deployment secret rather than stored beside the URL: the
 * receiver gets a stable secret it can verify against without this app holding
 * a second credential that could leak, and because the project id is inside
 * the derivation, a receiver configured for one project cannot verify
 * another's envelopes. Handing out `BETTER_AUTH_SECRET` itself would do
 * neither — it is the key every stored credential is encrypted under.
 *
 * The bare secret is preferred over a rotated encryption key on purpose. What
 * comes out of here is configured on somebody else's server, and rotating this
 * deployment's encryption keys must not silently stop their receiver from
 * verifying anything.
 *
 * `signEnvelope` is the HMAC here as well as on the wire, so there is exactly
 * one HMAC in this path to get wrong.
 */
async function digestWebhookSecret(projectId: string): Promise<string | null> {
  const { secretConfig } = await getAuth().$context;
  const secret =
    typeof secretConfig === "string"
      ? secretConfig
      : (secretConfig.legacySecret ??
        secretConfig.keys.get(secretConfig.currentVersion) ??
        null);
  if (!secret) return null;
  return signEnvelope(secret, DIGEST_SECRET_LABEL, projectId);
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/**
 * Mail, when the project asked for it.
 *
 * "The project opted in but this deployment cannot send" is recorded as a
 * failure rather than skipped silently. It repeats every morning, which is the
 * point: a toggle that is on and does nothing should say so on the surface
 * that shows the toggle, not in a log nobody opens.
 */
async function deliverEmail(input: {
  projectId: string;
  payload: DigestPayload;
  at: string;
}): Promise<DigestDelivery> {
  if (!isDigestEmailConfigured()) {
    return failed(
      "email",
      input.at,
      "this deployment has no Loops transactional path configured",
    );
  }
  try {
    const email = await DigestRepository.getDigestRecipient(input.projectId);
    if (!email) {
      return failed(
        "email",
        input.at,
        "the project's organization has no member to mail",
      );
    }
    await sendRankloopDigestEmail({
      email,
      dataVariables: digestEmailVariables(input.payload),
    });
    return { channel: "email", status: "sent", at: input.at, error: null };
  } catch (error) {
    return failed("email", input.at, describeError(error));
  }
}

/**
 * One signed POST, the same envelope shape the webhook publish adapter sends.
 *
 * The URL is re-checked here even though a form validated it on the way in:
 * this is a stored string that a migration or a hand-edited row could have
 * changed, and `fetch` on a `file:` or `javascript:` URL is not a request this
 * app should ever make on a schedule.
 */
async function deliverWebhook(input: {
  projectId: string;
  payload: DigestPayload;
  url: string;
  at: string;
}): Promise<DigestDelivery> {
  let target: URL;
  try {
    target = new URL(input.url);
  } catch {
    return failed(
      "webhook",
      input.at,
      "the configured webhook URL is not a URL",
    );
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return failed("webhook", input.at, "the webhook URL must be http or https");
  }

  try {
    // Signed over exactly the bytes that go out — serialize once, sign that
    // string, send that string (the adapter's rule, and for the same reason:
    // re-stringifying would risk signing a document the receiver never saw).
    const body = JSON.stringify(
      digestEnvelope({ projectId: input.projectId, payload: input.payload }),
    );
    const secret = await digestWebhookSecret(input.projectId);
    if (!secret) {
      // An unsigned envelope is worse than none: a receiver written against
      // the documented shape would reject it anyway, and one written loosely
      // would accept anything that reached the URL.
      return failed(
        "webhook",
        input.at,
        "this deployment has no secret to sign the envelope with",
      );
    }
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await signEnvelope(secret, timestamp, body);
    const response = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [EVENT_HEADER]: DIGEST_WEBHOOK_EVENT,
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: signature,
      },
      body,
    });
    if (!response.ok) {
      return failed(
        "webhook",
        input.at,
        `the endpoint returned ${response.status}`,
      );
    }
    return { channel: "webhook", status: "sent", at: input.at, error: null };
  } catch (error) {
    return failed("webhook", input.at, describeError(error));
  }
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/**
 * Deliver one stored digest on every channel the project has, and write the
 * log. Never throws.
 *
 * Called only by the run that won the INSERT, which is what keeps a retried
 * morning — or both dispatchers waking on the same clock — from mailing the
 * same digest twice. A day with no digest has nothing to deliver and never
 * reaches here.
 */
async function deliverDigest(input: {
  projectId: string;
  digestId: string;
  payload: DigestPayload;
  now: Date;
}): Promise<DigestDelivery[]> {
  const at = input.now.toISOString();
  // The row exists — that IS the in-app delivery, and recording it is what
  // makes an empty log mean "the delivery pass never ran".
  const deliveries: DigestDelivery[] = [
    { channel: "in_app", status: "stored", at, error: null },
  ];

  try {
    const optIns = await DigestRepository.getDeliveryOptIns(input.projectId);
    if (optIns?.digestEmail) {
      deliveries.push(
        await deliverEmail({
          projectId: input.projectId,
          payload: input.payload,
          at,
        }),
      );
    }
    if (optIns?.digestWebhookUrl) {
      deliveries.push(
        await deliverWebhook({
          projectId: input.projectId,
          payload: input.payload,
          url: optIns.digestWebhookUrl,
          at,
        }),
      );
    }
    await DigestRepository.recordDeliveries({
      digestId: input.digestId,
      projectId: input.projectId,
      deliveredJson: JSON.stringify(deliveries),
    });
  } catch (error) {
    // The two database calls are the only things above that can throw, and a
    // failure to record a delivery is the one failure this file cannot record.
    // It is still not worth a failed routine: the digest is already stored and
    // the operator will read it on the card either way.
    console.warn(
      `[routines] Digest delivery for ${input.projectId} was not logged: ${describeError(error)}`,
    );
  }

  return deliveries;
}

export const DigestDeliveryService = {
  deliverDigest,
};
