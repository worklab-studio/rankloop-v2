// Structural subset of the article row, so this module stays a pure display
// layer with no server or db import behind it — the same shape
// articleDisplay.logic.ts takes.
type ArticleLike = { status: string };

export type WriterMode = "api" | "agent";

/**
 * What the action slot on an approved net-new proposal offers.
 *
 * - `open-draft` — something is already written against this proposal
 * - `waiting-agent` — agent mode: the row is the agent's to pick up over MCP
 * - `add-key` — api mode with no OpenRouter key configured yet
 * - `write` — api mode, ready to spend
 */
type WriteActionState = "open-draft" | "waiting-agent" | "add-key" | "write";

/**
 * Which of the four shapes the row action takes.
 *
 * An existing article outranks the mode, and that ordering is the whole point:
 * flipping a project to agent mode while a draft is mid-workflow must not hide
 * the only link to it. The reverse case matters too — an agent reported a post
 * through `rankloop_publish_report`, so the row carries an article this app
 * never wrote, and "Open draft" is still the honest action.
 *
 * In agent mode the proposal simply stays `approved`. Nothing in the dashboard
 * advances it, because the thing that would advance it is running on the
 * user's machine; the queue, the laws and the receipts are shared, so a
 * project can run pSEO volume through the API writer and editorial posts
 * through its own agent without either track needing its own screen.
 */
export function writeActionState(input: {
  writerMode: WriterMode;
  article: ArticleLike | undefined;
  providerConfigured: boolean;
}): WriteActionState {
  if (input.article) return "open-draft";
  if (input.writerMode === "agent") return "waiting-agent";
  if (!input.providerConfigured) return "add-key";
  return "write";
}
