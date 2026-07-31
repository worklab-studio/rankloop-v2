import { defineConfig } from "tsup";

/** Bundled build for consumers outside the workspace (the dashboard links
 * this package from a separate pnpm root, so it can't rely on the raw
 * `.ts`-extension source exports). One flat ESM file + type declarations;
 * no minify — the output is read by bundlers, not browsers. */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
});
