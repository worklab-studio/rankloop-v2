import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/** The tests run against the engine's SOURCE, not its build output. The two
 * are the same code, but a stale `packages/engine/dist` would otherwise let a
 * law change land green here — and this package exists to be the law gate. */
export default defineConfig({
  resolve: {
    alias: {
      "@rankloop/engine": fileURLToPath(
        new URL("../engine/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    restoreMocks: true,
  },
});
