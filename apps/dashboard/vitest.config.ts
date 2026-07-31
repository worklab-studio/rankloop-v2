import { defineConfig } from "vitest/config";
import tsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsConfigPaths()],
  test: {
    environment: "node",
    // .tsx is collected too, and the environment stays node: the few component
    // tests here render through react-dom/server, which needs no DOM. Without
    // the second glob a *.test.tsx file is silently skipped — it passes CI by
    // never running, which is worse than not existing.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    restoreMocks: true,
    clearMocks: true,
  },
});
