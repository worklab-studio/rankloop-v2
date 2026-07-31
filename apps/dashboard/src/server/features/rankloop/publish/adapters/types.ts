// The one interface behind the three publish targets (spec 0021).
//
// Publishing is the step where rankloop writes to something the user owns, so
// the interface is shaped by restraint rather than by convenience. Three rules
// are visible in these types:
//
//   1. Hub before instance — `ensureHub` is its own call, made before
//      `createPost`, and returns whether it had to create the hub.
//   2. rankloop only ever edits what rankloop owns — the only write that
//      composes free text is `createPost`. `updatePost` takes a body that the
//      caller produced by reading `getPost` and merging the delimited
//      rankloop block into it; nothing here rewrites a user's prose.
//   3. Nothing publishes that has not passed the laws — enforced upstream, by
//      the workflow's preflight; an adapter never decides to publish.
//
// `capabilities` exists so surfaces state what will happen instead of guessing
// from the adapter's name.

import type { PublishAdapterKind } from "./config";

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** How contextual links reach the neighbouring pages on a target. */
export type LinkInjectionMode =
  /** rankloop reads each neighbour and writes its owned block back. */
  | "edits-pages"
  /** The target is told which links to add and applies them itself. */
  | "delegated";

/**
 * What a target supports, in the terms a publish surface has to speak. Each
 * field answers a sentence the UI would otherwise have to invent: does a human
 * see this before the world does, is the URL we show one the target confirmed,
 * does rankloop own the sitemap here or does the user's own build.
 */
export type PublishCapabilities = {
  kind: PublishAdapterKind;
  /** What to call this target in a sentence ("your WordPress site"). */
  label: string;
  /** The post can land unpublished for a human to release. */
  supportsDraft: boolean;
  /** Hubs are created by rankloop rather than expected to already exist. */
  createsHubs: boolean;
  /** How links reach neighbours (rule 2 applies either way). */
  linkInjection: LinkInjectionMode;
  /**
   * rankloop regenerates sitemap.xml / rss.xml / llms.txt / llms-full.txt on
   * this target. False everywhere but GitHub, and the settings panel says so
   * plainly rather than implying we handle it.
   */
  ownsDerivedArtifacts: boolean;
  /** Whether the published URL comes back from the target or is computed. */
  publishedUrl: "returned" | "computed";
  /** What `createPost` sends: rendered HTML, or the engine's markdown. */
  contentFormat: "html" | "markdown";
};

// ---------------------------------------------------------------------------
// What gets published
// ---------------------------------------------------------------------------

/** An approved article, exactly as the gate graded it. */
export type PublishArticle = {
  slug: string;
  title: string;
  description: string;
  /** YYYY-MM-DD, from the draft's own frontmatter. */
  date: string;
  /** The page type's name, which is the engine's display category. */
  category: string;
  keyword: string;
  /** Frontmatter block included: the bytes the laws ran against. */
  markdown: string;
  /** Where the page type's urlPattern puts this slug ("/compare/foo/"). */
  path: string;
};

/** The hub an instance belongs under. */
export type PublishHub = {
  /** Page type name, which doubles as the hub page's title. */
  name: string;
  /** The hub's own path ("/compare/"). */
  path: string;
  slug: string;
  /** One sentence for a hub page rankloop has to create from nothing. */
  description: string;
};

/** A hub that already exists on the target, as createPost sees it. */
export type PublishHubRef = {
  name: string;
  path: string;
  /** Adapter-native handle: WP page id, repo path, hub slug. */
  ref: string;
};

/**
 * What this publish run is called on targets that need a name for it. The
 * GitHub branch is named from the article's slug, so `ensureHub` and
 * `createPost` land on one branch and a resumed run finds the branch it
 * already made instead of opening a second pull request.
 */
export type PublishRun = { slug: string };

/** A contextual link the run intends to add to an existing page. */
export type PlannedLink = {
  /** The neighbour being edited. */
  fromPath: string;
  /** Where the link points — the article being published. */
  toPath: string;
  anchor: string;
};

export type CreatePostInput = {
  article: PublishArticle;
  /** Non-null by the time createPost runs: ensureHub goes first (rule 1). */
  hub: PublishHubRef | null;
  /**
   * The links this run means to inject. Targets that edit pages themselves
   * ignore this and receive `updatePost` calls instead; a delegated target
   * carries it in its payload.
   */
  links: PlannedLink[];
};

// ---------------------------------------------------------------------------
// What comes back
// ---------------------------------------------------------------------------

/**
 * Something the adapter deliberately did not do, in the user's words. A note
 * is not a failure: a skipped WordPress category or an unwritable meta field
 * still leaves a published post, and the run reports both.
 */
export type AdapterNote = string;

export type CreatedPost = {
  /** The idempotency guard the workflow stores: WP id, PR number, echo id. */
  ref: string;
  url: string;
  /**
   * 'unverified' means rankloop computed the URL from the page type's
   * urlPattern instead of being told it — the page may not be live yet.
   */
  urlConfidence: "verified" | "unverified";
  notes: AdapterNote[];
};

export type EnsuredHub = {
  ref: string;
  path: string;
  url: string;
  /** False when the hub already existed, which is the common case. */
  created: boolean;
  notes: AdapterNote[];
};

/** An existing page, fetched so its owned block can be merged (rule 2). */
export type ExistingPost = {
  ref: string;
  path: string;
  /** HTML on WordPress, markdown on GitHub — `contentFormat` says which. */
  body: string;
};

/**
 * A write to an existing page. `body` must be the result of reading that page
 * and merging rankloop's delimited block into it; adapters pass it through
 * untouched, so the only prose that ever changes is prose rankloop wrote.
 */
export type OwnedBlockUpdate = {
  ref: string;
  path: string;
  body: string;
};

/**
 * A derived artifact, regenerated whole from the manifest by the engine's
 * wire module. Only a target that owns these files ever receives them.
 */
export type DerivedArtifact = {
  /** Site-relative, as it is served ("/sitemap.xml"). */
  path: string;
  content: string;
};

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

export interface PublishAdapter {
  readonly capabilities: PublishCapabilities;
  /** Create the page type's hub if it is missing. Runs before createPost. */
  ensureHub(hub: PublishHub): Promise<EnsuredHub>;
  createPost(input: CreatePostInput): Promise<CreatedPost>;
  /** Null when the target has no page at that path, or cannot read pages. */
  getPost(path: string): Promise<ExistingPost | null>;
  updatePost(update: OwnedBlockUpdate): Promise<void>;
  /**
   * Regenerate the derived artifacts alongside the post that triggered them —
   * `ref` is the createPost ref, so they land in the same PR and a reviewer
   * sees one change rather than two.
   *
   * Optional, and present only where `capabilities.ownsDerivedArtifacts` is
   * true. Everywhere else these files belong to the user's own build and
   * writing them would be trespassing.
   */
  commitArtifacts?(input: {
    ref: string;
    artifacts: DerivedArtifact[];
  }): Promise<void>;
}
