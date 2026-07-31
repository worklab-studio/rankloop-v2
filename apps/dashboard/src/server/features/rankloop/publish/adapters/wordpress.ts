import { frontmatter } from "@rankloop/engine";
import { WordPressClient } from "@/server/features/rankloop/publish/services/wordpressClient";
import type { WordPressAdapterConfig } from "./config";
import { markdownToHtml } from "./markdownHtml.logic";
import { slugFromPath } from "./paths.logic";
import type {
  AdapterNote,
  CreatePostInput,
  CreatedPost,
  EnsuredHub,
  ExistingPost,
  OwnedBlockUpdate,
  PublishAdapter,
  PublishCapabilities,
  PublishHub,
} from "./types";

// The WordPress target. The user's site already exists, already has a theme,
// already has an editorial workflow — so this adapter's job is to fit into it
// rather than to impose one. Three shapes of restraint:
//
//   * posts land as drafts unless the user changed the setting, because a
//     human seeing the post in WordPress before the world does is the safe
//     default and costs one click;
//   * hubs are pages, because a hub is site architecture and a post-typed hub
//     would push itself through the RSS feed and the blog index;
//   * categories map to categories that exist and nothing else. A page type
//     named "Comparisons" is not permission to add "Comparisons" to somebody's
//     menu, so an unmatched name is a note on the receipt, not a new term.

export const wordpressCapabilities: PublishCapabilities = {
  kind: "wordpress",
  label: "your WordPress site",
  supportsDraft: true,
  createsHubs: true,
  linkInjection: "edits-pages",
  // WordPress sites generate their own sitemap (core does since 5.5, and every
  // SEO plugin overrides it). The settings panel says so rather than implying
  // rankloop handles it.
  ownsDerivedArtifacts: false,
  publishedUrl: "returned",
  contentFormat: "html",
};

/** The article body as HTML: frontmatter is fields here, not text. */
function bodyHtml(markdown: string): string {
  const [, body] = frontmatter(markdown);
  return markdownToHtml(body.trim());
}

export function createWordPressAdapter(
  config: WordPressAdapterConfig,
): PublishAdapter {
  const status = config.defaultPostStatus;

  async function ensureHub(hub: PublishHub): Promise<EnsuredHub> {
    const existing = await WordPressClient.findPageBySlug(config, hub.slug);
    if (existing) {
      return {
        ref: String(existing.id),
        path: hub.path,
        url: existing.link,
        created: false,
        notes: [],
      };
    }
    // The hub carries one sentence and stops. Its job is to exist and be
    // linkable (rule 1); filling it with prose rankloop invented would be
    // writing content, which is the one thing this product does not do.
    const created = await WordPressClient.createPage(config, {
      title: hub.name,
      slug: hub.slug,
      content: markdownToHtml(hub.description),
      // The hub and its first instance go live together or not at all — a
      // published hub linking to a draft post is a page about nothing.
      status,
    });
    return {
      ref: String(created.id),
      path: hub.path,
      url: created.link,
      created: true,
      notes: [`Created the ${hub.name} hub page as a ${status}.`],
    };
  }

  async function createPost(input: CreatePostInput): Promise<CreatedPost> {
    const { article } = input;
    const notes: AdapterNote[] = [];

    const { ids, missing } = await WordPressClient.resolveCategoryIds(config, [
      article.category,
    ]);
    for (const name of missing) {
      notes.push(
        `The "${name}" category doesn't exist in WordPress, so the post kept your site's default. rankloop never creates categories.`,
      );
    }

    const created = await WordPressClient.createPost(config, {
      title: article.title,
      slug: article.slug,
      content: bodyHtml(article.markdown),
      excerpt: article.description,
      status,
      categoryIds: ids,
    });

    // The meta description is a second call on purpose: which field is
    // writable is a property of the post WordPress just made, and writing a
    // meta key blind would 400 the create along with it.
    if (created.metaDescriptionField) {
      await WordPressClient.updatePost(config, {
        postId: created.id,
        title: article.title,
        metaDescription: article.description,
        metaDescriptionField: created.metaDescriptionField,
      });
    } else {
      notes.push(
        "No SEO plugin field for the meta description, so WordPress kept its own excerpt.",
      );
    }

    if (status === "draft") {
      notes.push(
        "The post is a draft. Publish it in WordPress when it reads right.",
      );
    }

    return {
      ref: String(created.id),
      // WordPress resolved this against its own permalink structure, which we
      // cannot see and should not guess.
      url: created.link,
      urlConfidence: "verified",
      notes,
    };
  }

  async function getPost(path: string): Promise<ExistingPost | null> {
    const post = await WordPressClient.findPostContentBySlug(
      config,
      slugFromPath(path),
    );
    if (!post) return null;
    return { ref: String(post.id), path, body: post.content };
  }

  /** The body arrives already merged (rule 2) — this only carries it. */
  async function updatePost(update: OwnedBlockUpdate): Promise<void> {
    await WordPressClient.updatePostContent(config, {
      postId: Number(update.ref),
      content: update.body,
    });
  }

  return {
    capabilities: wordpressCapabilities,
    ensureHub,
    createPost,
    getPost,
    updatePost,
  };
}
