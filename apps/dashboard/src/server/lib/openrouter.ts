import {
  createOpenRouter,
  type LanguageModelV3,
} from "@openrouter/ai-sdk-provider";
import {
  getOptionalEnvValue,
  getRequiredEnvValue,
} from "@/server/lib/runtime-env";

// OpenRouter model slug used for the in-app chat agents (onboarding + SAM) and
// for the rankloop writer. Override with OPENROUTER_MODEL to swap models
// without a code change. Exported because the writer names the model it is
// about to spend on in its confirm modal, and a second copy of this string is
// how that modal ends up quoting a model nobody is running.
export const DEFAULT_CHAT_AGENT_MODEL = "minimax/minimax-m3";

/**
 * Returns the AI SDK LanguageModel for the chat agents. `usage: { include: true }`
 * turns on OpenRouter usage accounting so each response carries its real USD
 * cost (providerMetadata.openrouter.usage.cost) — which we meter against the
 * shared usage-credit pool. `provider.order` prefers Together, then Atlas
 * Cloud (fp8); `zdr: true` restricts routing to Zero-Data-Retention endpoints
 * (prompts are never retained), which is the actual constraint — it excludes
 * MiniMax first-party without a hand-maintained allowlist. The account also
 * enforces this ("Non-frontier requires ZDR" data policy); the request-level
 * flag is belt-and-braces so the constraint survives a dashboard change.
 * Fallbacks stay on within the ZDR set because pinning providers caused a
 * prod outage (Jul 2026: Together upstream-rate-limited m3 and every chat
 * turn 429'd); as of Jul 2026 the ZDR set for m3 is Together/AtlasCloud/
 * Novita/Parasail at the same price plus Morph at 2x output as a last resort.
 *
 * `reasoning` turns on OpenRouter's reasoning-token channel so the model's
 * chain-of-thought comes back as a separate reasoning stream instead of
 * leaking into the visible answer text (MiniMax M3 otherwise dumps its
 * `<think>` trace inline). `effort: "medium"` is OpenRouter's default —
 * stated explicitly only because the SDK type requires one once the channel
 * is configured.
 */
export async function getChatAgentModel(): Promise<LanguageModelV3> {
  const apiKey = await getRequiredEnvValue("OPENROUTER_API_KEY");
  const modelId = await getOptionalEnvValue("OPENROUTER_MODEL");
  return buildChatAgentModel(apiKey, modelId, await getZdrPreference());
}

/**
 * Self-host escape hatch for the ZDR constraint above. Free models (`:free`)
 * are free BECAUSE they retain prompts, so `zdr: true` excludes every one of
 * them and any request routed at one fails with "No endpoints found matching
 * your data policy" — a message that points at the OpenRouter dashboard even
 * though the constraint came from OUR request. On a self-host install with a
 * BYO key the operator's prompts are their own, so let them opt out.
 * Default stays true: a hosted deployment handles other people's data.
 */
export async function getZdrPreference(): Promise<boolean> {
  const raw = (await getOptionalEnvValue("OPENROUTER_ZDR"))?.trim().toLowerCase();
  if (raw === "false" || raw === "0" || raw === "off") return false;
  return true;
}

/**
 * Synchronous variant for callers that already hold the env values. Think's
 * `getModel()` hook is sync and runs on every turn, so the SAM agent reads the
 * key/model from its DO env and builds the model here.
 */
export function buildChatAgentModel(
  apiKey: string,
  modelId?: string,
  zdr = true,
): LanguageModelV3 {
  return createOpenRouter({ apiKey })(modelId ?? DEFAULT_CHAT_AGENT_MODEL, {
    usage: { include: true },
    reasoning: { effort: "medium" },
    provider: {
      // The order preference only applies to the ZDR set; with zdr off the
      // operator has opted into the whole pool, so pinning two providers
      // would just re-narrow it for no reason.
      ...(zdr ? { order: ["together", "atlas-cloud/fp8"], zdr: true } : {}),
      allow_fallbacks: true,
    },
  });
}
