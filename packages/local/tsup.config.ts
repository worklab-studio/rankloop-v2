import { defineConfig } from "tsup";

/** One executable file, zero runtime dependencies — the same audit story as
 * `rankloop` (packages/cli): what `npx rankloop-local` pulls down is exactly
 * what is in this repo, nothing bundled from anywhere else. */
export default defineConfig({
  entry: ["src/rankloop-local.ts"],
  format: ["esm"],
  target: "node20",
  dts: false,
  clean: true,
});
