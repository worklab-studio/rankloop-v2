import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The grep proof (spec 0021, acceptance 5): no adapter writes anywhere outside
// the delimited block except when creating a new post.
//
// It is a test rather than a line in a runbook because the claim is only worth
// something continuously. Somebody adding a fourth endpoint, or "just" a PATCH
// to fix a title, is exactly the change this rule exists to catch, and a
// reviewer reading a diff of an HTTP client is not reliably going to notice
// that the body being sent was never merged.
//
// Two things are pinned:
//   1. every non-GET request the publish layer can issue, each one annotated
//      with why it is allowed to exist;
//   2. the single path by which an existing page's body may be written — the
//      caller reads the page, merges through `mergeRelatedBlock`, and hands the
//      result to `updatePost`, which passes it through untouched.

const DIR = new URL(".", import.meta.url).pathname;

function source(file: string): string {
  return readFileSync(`${DIR}${file}`, "utf8");
}

/** Every line that sets a non-GET method, as `file:line`. */
function writeSites(files: string[]): string[] {
  const sites: string[] = [];
  for (const file of files) {
    source(file)
      .split("\n")
      .forEach((line, index) => {
        if (/method:\s*"(POST|PUT|PATCH|DELETE)"/.test(line)) {
          sites.push(`${file}:${index + 1}`);
        }
      });
  }
  return sites;
}

const FILES = [
  "adapters/github.ts",
  "adapters/githubApi.ts",
  "adapters/webhook.ts",
  "adapters/wordpress.ts",
  "services/wordpressClient.ts",
  "services/indexNow.ts",
];

/**
 * Every write the publish layer can make, and the reason each is allowed.
 *
 * A create is allowed by rule 2's own exception. An owned-block write is
 * allowed because its body came out of `mergeRelatedBlock`. Nothing else is
 * allowed at all, and a new entry here is a decision somebody has to write a
 * sentence for.
 */
const ALLOWED_WRITES: Record<string, string> = {
  "adapters/githubApi.ts:104":
    "createBranch — a ref, not content; the branch a create and its PR live on",
  "adapters/githubApi.ts:176":
    "putFile — the one file writer: new post, new hub, the owned block (already merged), and the derived artifacts this target owns",
  "adapters/githubApi.ts:234": "createPull — opens the PR; touches no page",
  "adapters/webhook.ts:131":
    "the signed envelope; this target edits nothing itself, it is told what to do",
  "services/wordpressClient.ts:231":
    "updatePost — title and meta description on a post that was just created, plus the S3b retitle a human attested",
  "services/wordpressClient.ts:302": "createPost — a new post",
  "services/wordpressClient.ts:351": "createPage — a new hub page",
  "services/wordpressClient.ts:450":
    "updatePostContent — the only write to an existing body, and it only ever carries a merged owned block",
  "services/indexNow.ts:21":
    "the IndexNow ping; a third party, not the user's site",
};

describe("the publish layer's write scope", () => {
  it("issues no write this file has not accounted for", () => {
    // Compared as a set of annotated sites: an unlisted write fails here with
    // its own file and line, and a listed one that moved fails too, which is
    // the moment to re-read why it was allowed.
    expect(writeSites(FILES).toSorted()).toEqual(
      Object.keys(ALLOWED_WRITES).toSorted(),
    );
  });

  it("writes an existing page's body through exactly one function", () => {
    // WordPress: the body write is `updatePostContent`, and its only caller is
    // the adapter's `updatePost`, which is handed an already-merged body.
    const client = source("services/wordpressClient.ts");
    const wordpress = source("adapters/wordpress.ts");
    expect([...client.matchAll(/updatePostContent/g)]).toHaveLength(2); // definition + export
    expect([...wordpress.matchAll(/updatePostContent\(/g)]).toHaveLength(1);
    expect(wordpress).toContain("content: update.body");

    // GitHub: `updatePost` commits `update.body` and composes nothing.
    const github = source("adapters/github.ts");
    const updateBody = /async function updatePost\([\s\S]*?\n  }/.exec(github);
    expect(updateBody?.[0]).toContain("update.body");
    expect(updateBody?.[0]).not.toContain("mergeRelatedBlock");

    // Webhook: this target has no body write at all.
    expect(source("adapters/webhook.ts")).toContain(
      "async function updatePost(update: OwnedBlockUpdate): Promise<void>",
    );
  });

  it("merges through the owned block in exactly one place", () => {
    // The merge is the only producer of an `updatePost` body, and it lives in
    // the links service. An adapter that called it would be composing content,
    // which is the line this product does not cross.
    const links = readFileSync(`${DIR}services/PublishLinksService.ts`, "utf8");
    expect([...links.matchAll(/mergeRelatedBlock\(/g)]).toHaveLength(1);
    expect(links).toContain("body: merged.content");
    for (const file of FILES) {
      expect(source(file)).not.toContain("mergeRelatedBlock");
    }
  });
});
