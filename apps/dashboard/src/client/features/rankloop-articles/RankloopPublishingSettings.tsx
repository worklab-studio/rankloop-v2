import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Collapsible } from "@/client/features/ai-mcp/SetupControls";
import { formatDay } from "@/client/features/dashboard/cardParts";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  getRankloopPublishConnection,
  saveRankloopPublishConnection,
  testRankloopPublishConnection,
} from "@/serverFunctions/rankloopPublish";
import { tagChipClass } from "@/shared/tag-colors";

type AdapterChoice = "wordpress" | "none";

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

export function RankloopPublishingSettings({
  projectId,
}: {
  projectId: string;
}) {
  const queryClient = useQueryClient();
  const [adapter, setAdapter] = useState<AdapterChoice>("none");
  const [baseUrl, setBaseUrl] = useState("");
  const [username, setUsername] = useState("");
  const [applicationPassword, setApplicationPassword] = useState("");
  const [synced, setSynced] = useState(false);

  const connectionQuery = useQuery({
    queryKey: ["rankloopPublishConnection", projectId],
    queryFn: () => getRankloopPublishConnection({ data: { projectId } }),
  });
  const connection = connectionQuery.data ?? null;

  // Seed the form from the stored connection exactly once. The password
  // never comes back from the server (masked reads return hasPassword only),
  // so the field stays empty and its placeholder shows the mask.
  if (connectionQuery.isSuccess && !synced) {
    if (connection) {
      setAdapter(connection.adapter);
      setBaseUrl(connection.config.baseUrl);
      setUsername(connection.config.username);
    }
    setSynced(true);
  }

  const invalidateConnection = () =>
    queryClient.invalidateQueries({
      queryKey: ["rankloopPublishConnection", projectId],
    });

  const saveMutation = useMutation({
    mutationFn: () =>
      saveRankloopPublishConnection({
        data: {
          projectId,
          adapter: "wordpress",
          baseUrl: baseUrl.trim(),
          username: username.trim(),
          // Empty means "keep the stored one" on an existing connection —
          // the user edits the URL or username without retyping the secret.
          applicationPassword: applicationPassword.trim() || undefined,
        },
      }),
    onSuccess: () => {
      void invalidateConnection();
      setApplicationPassword("");
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
          "Couldn't reach the site. Check the URL and credentials.",
        ),
      );
    },
  });

  const hasPassword = connection?.config.hasPassword ?? false;
  const canSave =
    baseUrl.trim() !== "" &&
    username.trim() !== "" &&
    (applicationPassword.trim() !== "" || hasPassword);

  return (
    <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100">
      <Collapsible
        id="publishing"
        title="Publishing"
        subtitle="How approved retitles reach your site"
      >
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">Adapter</span>
          <select
            value={adapter}
            onChange={(event) =>
              setAdapter(
                event.target.value === "wordpress" ? "wordpress" : "none",
              )
            }
            className="select select-bordered select-sm w-44"
          >
            <option value="none">Not connected</option>
            <option value="wordpress">WordPress</option>
          </select>
        </label>

        {adapter === "wordpress" ? (
          <>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Site URL</span>
              <input
                type="text"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://example.com"
                className="input input-bordered w-full max-w-md"
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Username</span>
              <input
                type="text"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="off"
                className="input input-bordered w-full max-w-md"
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Application password</span>
              <input
                type="password"
                value={applicationPassword}
                onChange={(event) => setApplicationPassword(event.target.value)}
                placeholder={
                  hasPassword ? "••••••••••••" : "xxxx xxxx xxxx xxxx xxxx xxxx"
                }
                autoComplete="new-password"
                className="input input-bordered w-full max-w-md"
              />
              <span className="text-xs text-base-content/50">
                Create one in WordPress under Users → Profile → Application
                passwords.
              </span>
            </label>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!canSave || saveMutation.isPending}
                onClick={() => saveMutation.mutate()}
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
          rankloop only ever updates what you approved. Application passwords
          can be revoked in WordPress at any time.
        </p>
      </Collapsible>
    </div>
  );
}
