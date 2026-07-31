import type { PublishAdapterConfig } from "./config";
import { createGitHubAdapter, githubCapabilities } from "./github";
import type { PublishAdapter, PublishCapabilities, PublishRun } from "./types";
import { createWebhookAdapter, webhookCapabilities } from "./webhook";
import { createWordPressAdapter, wordpressCapabilities } from "./wordpress";

/**
 * What every target supports, readable without a connection.
 *
 * The publishing settings panel needs this before a project has chosen an
 * adapter — it is how the screen states what each option will do instead of
 * hard-coding three descriptions that drift from the adapters. Order is the
 * order the select offers them.
 */
export const publishAdapterCapabilities: PublishCapabilities[] = [
  wordpressCapabilities,
  webhookCapabilities,
  githubCapabilities,
];

/**
 * The one place that knows which adapter a connection means. Everything
 * downstream reads `adapter.capabilities` instead of branching on the name —
 * that is the point of the interface, and the reason this function is the
 * only switch on `config.adapter` in the feature.
 *
 * `run` is here because one target needs a name for the run: the GitHub
 * branch is derived from the article's slug so hub, post, links and derived
 * artifacts all land in one pull request.
 */
export function createPublishAdapter(
  config: PublishAdapterConfig,
  run: PublishRun,
): PublishAdapter {
  switch (config.adapter) {
    case "wordpress":
      return createWordPressAdapter(config);
    case "webhook":
      return createWebhookAdapter(config);
    case "github":
      return createGitHubAdapter(config, run);
  }
}
