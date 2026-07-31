import { symmetricDecrypt } from "better-auth/crypto";
import { getAuth } from "@/lib/auth";
import { PublishConnectionRepository } from "@/server/features/rankloop/publish/repositories/PublishConnectionRepository";
import { AppError } from "@/server/lib/errors";
import { parseAdapterConfig, type PublishSettings } from "./config";
import { createPublishAdapter } from "./createAdapter";
import type { PublishAdapter, PublishRun } from "./types";

// Where a stored connection becomes a live adapter. Everything above this line
// in the workflow talks to `PublishAdapter` and cannot tell the three targets
// apart; this module is the only one that decrypts, which is what keeps the
// credential blast radius to a single file.

/** Same key contract as PublishConnectionService and the self-hosted GSC
 *  grant: BETTER_AUTH_SECRET via Better Auth's secretConfig, so the operator
 *  manages exactly one secret. */
async function cipherKey() {
  const ctx = await getAuth().$context;
  return ctx.secretConfig;
}

/** The two shared settings plus the one per-adapter setting a surface has to
 *  read. `directCommit` is lifted out of the GitHub blob because it is the
 *  difference between "opens a pull request" and "commits" — a difference the
 *  capabilities cannot carry (both are the same adapter) and a difference the
 *  Publish panel promises out loud before the button. False for every target
 *  that has no such choice. */
type ResolvedPublishSettings = PublishSettings & { directCommit: boolean };

type ResolvedPublishAdapter = {
  adapter: PublishAdapter;
  settings: ResolvedPublishSettings;
};

/**
 * The project's publish target, or null when it has none.
 *
 * Null rather than a throw: "no connection" is the ordinary state of a project
 * that has not set publishing up, and preflight turns it into a sentence the
 * user can act on. A connection that exists but no longer parses is a
 * different story and throws — that is a broken deployment, not an
 * un-onboarded one.
 *
 * `run` names the publish for the one target that needs a name for it: the
 * GitHub branch comes from the article's slug, so hub, post, links and derived
 * artifacts all land in one pull request even though they are four steps.
 */
export async function resolvePublishAdapter(
  projectId: string,
  run: PublishRun,
): Promise<ResolvedPublishAdapter | null> {
  const row = await PublishConnectionRepository.getForProject(projectId);
  if (!row) return null;

  const decrypted = await symmetricDecrypt({
    key: await cipherKey(),
    data: row.configJson,
  });
  let raw: unknown;
  try {
    raw = JSON.parse(decrypted);
  } catch {
    throw new AppError(
      "PUBLISH_NOT_CONNECTED",
      "The stored publish connection could not be read.",
    );
  }

  const config = parseAdapterConfig(row.adapter, raw);
  return {
    adapter: createPublishAdapter(config, run),
    settings: {
      defaultPostStatus: config.defaultPostStatus,
      linkInjection: config.linkInjection,
      directCommit:
        config.adapter === "github" && config.commitMode === "direct",
    },
  };
}
