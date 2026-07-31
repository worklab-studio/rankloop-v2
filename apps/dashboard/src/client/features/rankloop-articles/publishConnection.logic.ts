import type {
  getRankloopPublishCapabilities,
  getRankloopPublishConnection,
} from "@/serverFunctions/rankloopPublish";

// The publishing form's shapes and its two translations — stored connection →
// form, form → wire.
//
// Everything the screen branches on comes from the server: the adapter list
// and what each one supports are the adapters' own `capabilities`, so a fourth
// target appears in the select without this file learning its name. The only
// per-adapter knowledge here is the field bag, and its keys are copied from
// the stored config so saving is a copy rather than a translation.

/** The capability record each adapter publishes about itself. */
export type PublishCapabilityView = Awaited<
  ReturnType<typeof getRankloopPublishCapabilities>
>[number];

export type PublishAdapterKind = PublishCapabilityView["kind"];

type StoredPublishConnection = Awaited<
  ReturnType<typeof getRankloopPublishConnection>
>;

/**
 * One flat bag for every adapter's fields, keyed exactly as the stored config
 * keys them.
 *
 * Flat rather than a union so switching the select and switching back doesn't
 * wipe what you already typed — someone comparing a webhook against a
 * WordPress connection shouldn't lose the URL for looking. Only the fields the
 * chosen adapter renders are sent on save.
 */
export type PublishFormFields = {
  // wordpress
  baseUrl: string;
  username: string;
  applicationPassword: string;
  // webhook
  url: string;
  secret: string;
  // github
  owner: string;
  repo: string;
  token: string;
  baseBranch: string;
  contentDir: string;
  publicDir: string;
  commitMode: "pull-request" | "direct";
  /** Shared by webhook and github: the site root a computed URL hangs off. */
  siteUrl: string;
};

export const EMPTY_PUBLISH_FIELDS: PublishFormFields = {
  baseUrl: "",
  username: "",
  applicationPassword: "",
  url: "",
  secret: "",
  owner: "",
  repo: "",
  token: "",
  baseBranch: "main",
  contentDir: "content",
  publicDir: "public",
  // A pull request is the default because it is the only shape of this write
  // that a person sees before the site changes.
  commitMode: "pull-request",
  siteUrl: "",
};

/** How each target is named in the select. `capabilities.label` reads as a
 *  sentence fragment ("your WordPress site"), which is right in prose and
 *  wrong in a dropdown. */
const ADAPTER_OPTION_LABELS: Record<PublishAdapterKind, string> = {
  wordpress: "WordPress",
  webhook: "Webhook",
  github: "GitHub",
};

export function adapterOptionLabel(kind: PublishAdapterKind): string {
  return ADAPTER_OPTION_LABELS[kind];
}

/**
 * Enough typed to save.
 *
 * A stored secret satisfies the secret field: an existing connection lets you
 * fix a typo in the URL without re-reading the password out of wp-admin, which
 * is why the save path treats an empty secret as "keep the stored one".
 */
export function publishFieldsComplete(
  adapter: PublishAdapterKind,
  fields: PublishFormFields,
  hasSecret: boolean,
): boolean {
  if (adapter === "wordpress") {
    return (
      fields.baseUrl.trim() !== "" &&
      fields.username.trim() !== "" &&
      (fields.applicationPassword.trim() !== "" || hasSecret)
    );
  }
  if (adapter === "webhook") {
    return (
      fields.url.trim() !== "" &&
      fields.siteUrl.trim() !== "" &&
      (fields.secret.trim() !== "" || hasSecret)
    );
  }
  return (
    fields.owner.trim() !== "" &&
    fields.repo.trim() !== "" &&
    fields.baseBranch.trim() !== "" &&
    fields.siteUrl.trim() !== "" &&
    (fields.token.trim() !== "" || hasSecret)
  );
}

/** Seed the form from the stored connection. Secrets never come back, so only
 *  the readable half is restored and the mask lives in the placeholder. */
export function fieldsFromConnection(
  connection: NonNullable<StoredPublishConnection>,
): PublishFormFields {
  const config = connection.config;
  if (config.adapter === "wordpress") {
    return {
      ...EMPTY_PUBLISH_FIELDS,
      baseUrl: config.baseUrl,
      username: config.username,
    };
  }
  if (config.adapter === "webhook") {
    return {
      ...EMPTY_PUBLISH_FIELDS,
      url: config.url,
      siteUrl: config.siteUrl,
    };
  }
  return {
    ...EMPTY_PUBLISH_FIELDS,
    owner: config.owner,
    repo: config.repo,
    baseBranch: config.baseBranch,
    contentDir: config.contentDir,
    publicDir: config.publicDir,
    commitMode: config.commitMode,
    siteUrl: config.siteUrl,
  };
}

type PublishSettingsFields = {
  defaultPostStatus: "draft" | "publish";
  linkInjection: boolean;
};

/**
 * The blob to store, per adapter. An empty secret is omitted rather than sent
 * blank — omitted is what the server reads as "keep the stored one", and a
 * blank string would wipe a working credential on an unrelated edit.
 */
export function configFromFields(
  adapter: PublishAdapterKind,
  fields: PublishFormFields,
  settings: PublishSettingsFields,
) {
  if (adapter === "wordpress") {
    return {
      adapter: "wordpress" as const,
      ...settings,
      baseUrl: fields.baseUrl.trim(),
      username: fields.username.trim(),
      applicationPassword: fields.applicationPassword.trim() || undefined,
    };
  }
  if (adapter === "webhook") {
    return {
      adapter: "webhook" as const,
      ...settings,
      url: fields.url.trim(),
      secret: fields.secret.trim() || undefined,
      siteUrl: fields.siteUrl.trim(),
    };
  }
  return {
    adapter: "github" as const,
    ...settings,
    owner: fields.owner.trim(),
    repo: fields.repo.trim(),
    token: fields.token.trim() || undefined,
    baseBranch: fields.baseBranch.trim(),
    contentDir: fields.contentDir.trim(),
    publicDir: fields.publicDir.trim(),
    commitMode: fields.commitMode,
    siteUrl: fields.siteUrl.trim(),
  };
}
