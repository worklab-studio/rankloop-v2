import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Collapsible } from "@/client/features/ai-mcp/SetupControls";
import { formatDay } from "@/client/features/dashboard/cardParts";
import {
  adapterOptionLabel,
  configFromFields,
  EMPTY_PUBLISH_FIELDS,
  fieldsFromConnection,
  publishFieldsComplete,
  type PublishAdapterKind,
  type PublishCapabilityView,
  type PublishFormFields,
} from "@/client/features/rankloop-articles/publishConnection.logic";
import { RankloopPublishingFields } from "@/client/features/rankloop-articles/RankloopPublishingFields";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  getRankloopPublishCapabilities,
  getRankloopPublishConnection,
  saveRankloopPublishConnection,
  testRankloopPublishConnection,
} from "@/serverFunctions/rankloopPublish";
import { tagChipClass } from "@/shared/tag-colors";

type AdapterChoice = PublishAdapterKind | "none";

// Rule 2 of spec 0021, said where the switch is rather than in a changelog.
// It is the sentence that makes the toggle safe to leave on.
const OWNED_BLOCK_SENTENCE =
  "rankloop only edits a block it created, marked in your HTML.";

// The honest line for every target whose derived files are not ours. Claiming
// otherwise would be the one lie this screen could tell that nobody would
// catch until their sitemap went stale.
const FOREIGN_SITEMAP_SENTENCE =
  "Your site keeps generating its own sitemap; rankloop does not touch it.";

const OWNED_SITEMAP_SENTENCE =
  "rankloop regenerates sitemap.xml, rss.xml, llms.txt and llms-full.txt from the manifest and commits them alongside the post.";

function ConnectionStatusChip({ status }: { status: string }) {
  // 'unconfigured' renders nothing: saved-but-never-tested is not a verdict,
  // and a neutral chip would read like one.
  if (status !== "ok" && status !== "failed") return null;
  const color = status === "ok" ? "emerald" : "rose";
  return (
    <span
      className={`inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-[11px] font-medium ${tagChipClass(color)}`}
    >
      {status === "ok" ? "connected" : "failed"}
    </span>
  );
}

/** The draft default, offered only where the target has a status to set. */
function PostStatusField({
  capabilities,
  value,
  onChange,
}: {
  capabilities: PublishCapabilityView;
  value: "draft" | "publish";
  onChange: (next: "draft" | "publish") => void;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">Default post status</span>
      <select
        value={value}
        onChange={(event) =>
          onChange(event.target.value === "publish" ? "publish" : "draft")
        }
        className="select select-bordered select-sm w-44"
      >
        <option value="draft">Draft</option>
        <option value="publish">Published</option>
      </select>
      <span className="text-xs text-base-content/50">
        Draft is the default: a person sees the post on {capabilities.label}{" "}
        before the world does.
      </span>
    </label>
  );
}

/**
 * The toggle, and the sentence that makes it safe to leave on.
 *
 * Two targets let rankloop edit neighbouring pages and one hands the links
 * over instead, so the promise underneath is drawn from the capability rather
 * than repeated for all three — telling a webhook user "we only edit our own
 * block" would describe an edit rankloop never makes.
 */
function LinkInjectionField({
  capabilities,
  value,
  onChange,
}: {
  capabilities: PublishCapabilityView;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div>
      <label className="label cursor-pointer justify-start gap-2 py-0">
        <input
          type="checkbox"
          className="toggle toggle-sm toggle-primary"
          checked={value}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="label-text">Link to new posts</span>
      </label>
      <p className="mt-1.5 text-xs text-base-content/55">
        {capabilities.linkInjection === "edits-pages"
          ? `Up to 3 pages that already exist get a link to each new post. ${OWNED_BLOCK_SENTENCE} Delete the block and nothing breaks.`
          : "Up to 3 link targets ride along in the envelope. Your endpoint decides what to do with them — rankloop never edits those pages itself."}
      </p>
    </div>
  );
}

/**
 * Where approved work lands, and how much of the site rankloop may touch on
 * the way.
 *
 * The three targets are not variations on a theme — one drafts a post a human
 * releases, one opens a pull request, one hands a signed envelope to a site
 * rankloop never reaches into — so every control below is drawn from the
 * adapter's own `capabilities` rather than from its name. A target with no
 * draft state gets no draft select it would ignore, and the sitemap sentence
 * is the honest one everywhere except the one place those files are ours.
 */
export function RankloopPublishingSettings({
  projectId,
}: {
  projectId: string;
}) {
  const queryClient = useQueryClient();
  const [adapter, setAdapter] = useState<AdapterChoice>("none");
  const [fields, setFields] = useState<PublishFormFields>(EMPTY_PUBLISH_FIELDS);
  const [postStatus, setPostStatus] = useState<"draft" | "publish">("draft");
  const [linkInjection, setLinkInjection] = useState(true);
  const [synced, setSynced] = useState(false);

  const capabilitiesQuery = useQuery({
    queryKey: ["rankloopPublishCapabilities", projectId],
    queryFn: () => getRankloopPublishCapabilities({ data: { projectId } }),
    // What a target supports is a property of the build, not of the project —
    // it never changes while the tab is open.
    staleTime: Infinity,
  });
  const connectionQuery = useQuery({
    queryKey: ["rankloopPublishConnection", projectId],
    queryFn: () => getRankloopPublishConnection({ data: { projectId } }),
  });
  const connection = connectionQuery.data ?? null;

  // Seed from the stored connection exactly once, so typing is never undone by
  // a background refetch landing mid-edit.
  if (connectionQuery.isSuccess && !synced) {
    if (connection) {
      setAdapter(connection.adapter);
      setFields(fieldsFromConnection(connection));
      setPostStatus(connection.config.defaultPostStatus);
      setLinkInjection(connection.config.linkInjection);
    }
    setSynced(true);
  }

  const invalidateConnection = () =>
    queryClient.invalidateQueries({
      queryKey: ["rankloopPublishConnection", projectId],
    });

  const saveMutation = useMutation({
    mutationFn: (target: PublishAdapterKind) =>
      saveRankloopPublishConnection({
        data: {
          projectId,
          adapter: target,
          config: configFromFields(target, fields, {
            defaultPostStatus: postStatus,
            linkInjection,
          }),
        },
      }),
    onSuccess: () => {
      void invalidateConnection();
      // Drop the secrets from component state the moment they are stored; the
      // placeholder mask takes over from here.
      setFields((current) => ({
        ...current,
        applicationPassword: "",
        secret: "",
        token: "",
      }));
      toast.success("Publishing connection saved");
    },
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(
          error,
          "Couldn't save the connection. Try again.",
        ),
      );
    },
  });

  const testMutation = useMutation({
    mutationFn: () => testRankloopPublishConnection({ data: { projectId } }),
    onSettled: () => {
      void invalidateConnection();
    },
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(
          error,
          "Couldn't reach the target. Check the address and credentials.",
        ),
      );
    },
  });

  const adapters = capabilitiesQuery.data ?? [];
  const capabilities =
    adapter === "none"
      ? null
      : (adapters.find((entry) => entry.kind === adapter) ?? null);
  const hasSecret = connection?.config.hasSecret ?? false;
  const canSave =
    adapter !== "none" && publishFieldsComplete(adapter, fields, hasSecret);

  return (
    <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100">
      <Collapsible
        id="publishing"
        title="Publishing"
        subtitle="Where approved work lands, and what rankloop may touch to get it there"
      >
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">Adapter</span>
          <select
            value={adapter}
            onChange={(event) => {
              const next = adapters.find(
                (entry) => entry.kind === event.target.value,
              );
              setAdapter(next?.kind ?? "none");
            }}
            className="select select-bordered select-sm w-44"
          >
            <option value="none">Not connected</option>
            {adapters.map((entry) => (
              <option key={entry.kind} value={entry.kind}>
                {adapterOptionLabel(entry.kind)}
              </option>
            ))}
          </select>
        </label>

        {adapter !== "none" && capabilities ? (
          <>
            <RankloopPublishingFields
              adapter={adapter}
              fields={fields}
              hasSecret={hasSecret}
              onChange={(next) =>
                setFields((current) => ({ ...current, ...next }))
              }
            />

            {capabilities.supportsDraft ? (
              <PostStatusField
                capabilities={capabilities}
                value={postStatus}
                onChange={setPostStatus}
              />
            ) : null}

            <LinkInjectionField
              capabilities={capabilities}
              value={linkInjection}
              onChange={setLinkInjection}
            />

            <p className="text-xs text-base-content/55">
              {capabilities.ownsDerivedArtifacts
                ? OWNED_SITEMAP_SENTENCE
                : FOREIGN_SITEMAP_SENTENCE}
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!canSave || saveMutation.isPending}
                onClick={() => saveMutation.mutate(adapter)}
              >
                {saveMutation.isPending ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : null}
                Save
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={!connection || testMutation.isPending}
                onClick={() => testMutation.mutate()}
              >
                {testMutation.isPending ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : null}
                Test connection
              </button>
              {connection ? (
                <ConnectionStatusChip status={connection.status} />
              ) : null}
              {connection?.lastCheckedAt ? (
                <span className="text-[11px] text-base-content/45">
                  checked {formatDay(connection.lastCheckedAt)}
                </span>
              ) : null}
            </div>
          </>
        ) : null}

        <p className="text-xs text-base-content/55">
          rankloop only ever writes what you approved, and only the pages it
          made. Credentials are encrypted at rest and can be revoked at the
          source at any time.
        </p>
      </Collapsible>
    </div>
  );
}
