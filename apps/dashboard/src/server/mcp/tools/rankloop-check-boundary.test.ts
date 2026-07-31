import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The boundary that is the product (spec 0023, acceptance 4): nothing on the
// `rankloop_check` path may reach a model.
//
// An agent that can call the grader will call it in a loop, so the grader has
// to be free and deterministic — and rankloop's whole claim is that the thing
// which judges an article is not the thing that wrote it. This is a grep,
// deliberately: a mocked-provider test proves the mock was not called, while
// this fails the moment the import appears.

/** Every module the tool reaches, from the handler down to the engine call.
 *  Adding a hop to that path without adding it here is the way this test
 *  would go quiet, so the list is the path, spelled out. */
const CHECK_PATH = [
  "src/server/mcp/tools/rankloop-writer-tools.ts",
  "src/server/features/rankloop/agent/services/AgentService.ts",
  "src/server/features/rankloop/agent/repositories/AgentRepository.ts",
  "src/server/features/rankloop/writing/services/ArticleGateService.ts",
  "src/server/features/rankloop/writing/gate.ts",
  "src/server/features/rankloop/writing/repair.logic.ts",
];

/** The provider surface the API writer uses (see writing/draft.ts). */
const MODEL_IMPORTS = [
  'from "ai"',
  "@openrouter/ai-sdk-provider",
  "@/server/lib/chatAgent",
  "writing/draft",
  "./draft",
];

describe("the rankloop_check path", () => {
  it.each(CHECK_PATH)("has no model client in %s", (path) => {
    const source = readFileSync(path, "utf8");
    for (const marker of MODEL_IMPORTS) {
      expect(source, `${path} imports ${marker}`).not.toContain(marker);
    }
  });
});
