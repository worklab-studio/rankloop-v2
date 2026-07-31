import { defineConfig } from "tsup";

/** One executable file. `@rankloop/engine` stays external — it is the only
 * runtime dependency this package has or will ever have, and bundling it in
 * would hide that fact from anyone auditing what `npx rankloop` pulls down.
 *
 * No dts: nothing imports this package, it is run. The shebang on the entry
 * survives the build (esbuild keeps a leading `#!` line). */
export default defineConfig({
  entry: ["src/rankloop.ts"],
  format: ["esm"],
  target: "node20",
  dts: false,
  clean: true,
});
