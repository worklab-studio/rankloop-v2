import type {
  PublishAdapterKind,
  PublishFormFields,
} from "@/client/features/rankloop-articles/publishConnection.logic";

type FieldGroupProps = {
  fields: PublishFormFields;
  hasSecret: boolean;
  onChange: (next: Partial<PublishFormFields>) => void;
};

/** The stored secret never comes back from the server, so the field stays
 *  empty and its placeholder carries the mask. */
function secretPlaceholder(hasSecret: boolean, example: string): string {
  return hasSecret ? "••••••••••••" : example;
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  help,
  secret,
  narrow,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  help?: string;
  secret?: boolean;
  narrow?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      <input
        type={secret ? "password" : "text"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete={secret ? "new-password" : "off"}
        className={
          narrow
            ? "input input-bordered input-sm w-44"
            : "input input-bordered w-full max-w-md"
        }
      />
      {help ? (
        <span className="text-xs text-base-content/50">{help}</span>
      ) : null}
    </label>
  );
}

/** The site root, asked for by every target that cannot tell rankloop where a
 *  post ended up. It is what turns the page type's URL pattern into a URL. */
function SiteUrlField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <TextField
      label="Site URL"
      value={value}
      onChange={onChange}
      placeholder="https://example.com"
      help="Where the pages end up. rankloop builds the published URL from this and the page type's pattern."
    />
  );
}

function WordPressFields({ fields, hasSecret, onChange }: FieldGroupProps) {
  return (
    <>
      <TextField
        label="Site URL"
        value={fields.baseUrl}
        onChange={(baseUrl) => onChange({ baseUrl })}
        placeholder="https://example.com"
      />
      <TextField
        label="Username"
        value={fields.username}
        onChange={(username) => onChange({ username })}
      />
      <TextField
        label="Application password"
        secret
        value={fields.applicationPassword}
        onChange={(applicationPassword) => onChange({ applicationPassword })}
        placeholder={secretPlaceholder(
          hasSecret,
          "xxxx xxxx xxxx xxxx xxxx xxxx",
        )}
        help="Create one in WordPress under Users → Profile → Application passwords. Revoking it there cuts rankloop off immediately."
      />
    </>
  );
}

function WebhookFields({ fields, hasSecret, onChange }: FieldGroupProps) {
  return (
    <>
      <TextField
        label="Endpoint URL"
        value={fields.url}
        onChange={(url) => onChange({ url })}
        placeholder="https://example.com/hooks/rankloop"
        help="rankloop POSTs one JSON envelope per publish: the article, its frontmatter, the hub, and the links to add."
      />
      <TextField
        label="Signing secret"
        secret
        value={fields.secret}
        onChange={(secret) => onChange({ secret })}
        placeholder={secretPlaceholder(hasSecret, "a long random string")}
        help="Every envelope carries an HMAC of its body. Check the signature header before you trust the payload."
      />
      <SiteUrlField
        value={fields.siteUrl}
        onChange={(siteUrl) => onChange({ siteUrl })}
      />
      {/* The probe is the one envelope a receiver gets before it has been
          written, so it is documented where the endpoint is typed rather than
          discovered as an unrecognised event in somebody's error log. */}
      <p className="text-xs text-base-content/55">
        Test connection sends one more event,{" "}
        <span className="font-mono">connection.test</span>, named in the{" "}
        <span className="font-mono">X-Rankloop-Event</span> header and signed
        like every other. It carries no article and asks for nothing back — any
        200 passes, so an endpoint that doesn&rsquo;t recognise it can answer
        and move on.
      </p>
    </>
  );
}

function GitHubFields({ fields, hasSecret, onChange }: FieldGroupProps) {
  return (
    <>
      <div className="flex flex-wrap gap-4">
        <TextField
          label="Owner"
          narrow
          value={fields.owner}
          onChange={(owner) => onChange({ owner })}
          placeholder="acme"
        />
        <TextField
          label="Repository"
          narrow
          value={fields.repo}
          onChange={(repo) => onChange({ repo })}
          placeholder="site"
        />
        <TextField
          label="Branch"
          narrow
          value={fields.baseBranch}
          onChange={(baseBranch) => onChange({ baseBranch })}
          placeholder="main"
        />
      </div>
      <TextField
        label="Access token"
        secret
        value={fields.token}
        onChange={(token) => onChange({ token })}
        placeholder={secretPlaceholder(hasSecret, "github_pat_…")}
        help="A fine-grained token scoped to this one repository, with contents and pull-request write."
      />
      <TextField
        label="Content directory"
        value={fields.contentDir}
        onChange={(contentDir) => onChange({ contentDir })}
        placeholder="content"
        help="Repo-relative root the page type's URL pattern hangs off. Posts land under it as frontmatter plus body — the shape the engine already parses."
      />
      {/* The one setting whose wrong value fails silently: the artifacts get
          committed, the build ignores them, and the sitemap goes stale with
          nothing to notice it. So the default is stated rather than implied. */}
      <TextField
        label="Public directory"
        value={fields.publicDir}
        onChange={(publicDir) => onChange({ publicDir })}
        placeholder="public"
        help="Repo-relative directory served at your site root — public by default, static or docs in some generators. sitemap.xml, rss.xml, llms.txt and llms-full.txt are committed here. Leave it empty if the repo root is the site root."
      />
      <SiteUrlField
        value={fields.siteUrl}
        onChange={(siteUrl) => onChange({ siteUrl })}
      />
      <div>
        <label className="label cursor-pointer justify-start gap-2 py-0">
          <input
            type="checkbox"
            className="checkbox checkbox-sm"
            checked={fields.commitMode === "pull-request"}
            onChange={(event) =>
              onChange({
                commitMode: event.target.checked ? "pull-request" : "direct",
              })
            }
          />
          <span className="label-text">Open a pull request</span>
        </label>
        <p className="mt-1.5 text-xs text-base-content/50">
          On, a person merges before anything is live. Off commits straight to{" "}
          {fields.baseBranch || "the branch"}, which is a deploy nobody
          reviewed.
        </p>
      </div>
    </>
  );
}

/**
 * The per-adapter half of the publishing form.
 *
 * Each target asks for the least it can: WordPress for an application password
 * revocable from the user's own profile screen, the webhook for a secret it
 * signs with and no login at all, GitHub for a token scoped to one repository.
 */
export function RankloopPublishingFields({
  adapter,
  ...props
}: FieldGroupProps & { adapter: PublishAdapterKind }) {
  if (adapter === "wordpress") return <WordPressFields {...props} />;
  if (adapter === "webhook") return <WebhookFields {...props} />;
  return <GitHubFields {...props} />;
}
