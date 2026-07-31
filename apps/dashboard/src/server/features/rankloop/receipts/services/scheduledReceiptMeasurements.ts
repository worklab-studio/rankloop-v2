import { ReceiptsService } from "@/server/features/rankloop/receipts/services/ReceiptsService";

// Cron body for the `scheduled` Worker handler: advance due receipts through
// baseline → measuring → measured/contaminated. Daily-ish work riding the
// 15-minute cron: a receipt only becomes due twice in its six-week life, and
// the due-check inside the pass is one indexed read that returns nothing on
// almost every tick, so no separate daily scheduler is worth its moving
// parts. Wrapped in `withPgClient` at the entrypoint (server.ts).
export async function runScheduledReceiptMeasurements() {
  try {
    const result = await ReceiptsService.runMeasurementPass();
    const acted =
      result.flipped +
      result.measured +
      result.contaminated +
      result.lagged +
      result.skipped;
    // Quiet ticks stay quiet — logging "0 receipts" 96 times a day buries
    // the lines that matter.
    if (acted > 0) {
      console.log(
        `[cron] Receipt measurements: ${result.flipped} now measuring, ` +
          `${result.measured} measured, ${result.contaminated} contaminated, ` +
          `${result.lagged} waiting on data, ${result.skipped} skipped`,
      );
    }
  } catch (err) {
    console.error("[cron] Error running receipt measurements:", err);
  }
}
