/** The spend ledger — rankloop 0.2's best safety idea, generalized.
 *
 * Every paid call's REAL cost (returned in the response body) is logged;
 * the budget ceiling caps what a ledger has EVER spent, not just this run,
 * so a misfiring cron loop can't drain an account. The same interface
 * records LLM and image spend, so a site's true cost-per-article is a
 * query, not a guess. */

export type SpendProvider = "dataforseo" | "llm" | "image" | "other";

export interface SpendLedger {
  /** Record one call's cost. `meta` is provider-specific context. */
  log(provider: SpendProvider, operation: string, costUsd: number, meta?: Record<string, unknown>): Promise<void>;
  /** Cumulative spend for a provider (all time — the ceiling is cumulative on purpose). */
  total(provider?: SpendProvider): Promise<number>;
}

/** In-memory ledger for tests, dry runs and single-shot scripts. */
export class MemoryLedger implements SpendLedger {
  readonly entries: { provider: SpendProvider; operation: string; costUsd: number; meta?: Record<string, unknown> }[] = [];

  async log(provider: SpendProvider, operation: string, costUsd: number, meta?: Record<string, unknown>): Promise<void> {
    this.entries.push({ provider, operation, costUsd, meta });
  }

  async total(provider?: SpendProvider): Promise<number> {
    return this.entries
      .filter((e) => !provider || e.provider === provider)
      .reduce((sum, e) => sum + e.costUsd, 0);
  }
}

export class BudgetExceededError extends Error {
  constructor(
    readonly spentUsd: number,
    readonly budgetUsd: number,
  ) {
    super(
      `budget ceiling hit: $${spentUsd.toFixed(2)} spent of a $${budgetUsd.toFixed(2)} ceiling — ` +
        "raise the budget or stop here (the ledger is cumulative on purpose)",
    );
    this.name = "BudgetExceededError";
  }
}
