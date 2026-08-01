import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Section } from "@/client/features/rankloop-automation/RankloopAutomationParts";
import { digestWebhookUrlError } from "@/client/features/rankloop-automation/automationDisplay.logic";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { saveRankloopDigestDelivery } from "@/serverFunctions/rankloopRoutines";
import { getRankloopWriterSettings } from "@/serverFunctions/rankloopWriting";

// Where the morning digest goes besides this app. Two channels, both off by
// default, both opt-ins on the same row the writer dials live on — read
// through the settings query the Articles form already uses, saved through an
// endpoint that touches only these two columns so the two screens can never
// overwrite each other's fields.
//
// The card is the third channel and has no toggle, because it is not
// optional: the digest is written and stored whatever these say, and framing
// in-app as a switch would suggest turning everything off stops the digest
// rather than stopping the notifications.

export function RankloopDigestDelivery({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [digestEmail, setDigestEmail] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [synced, setSynced] = useState(false);

  const settingsQuery = useQuery({
    queryKey: ["rankloopWriterSettings", projectId],
    queryFn: () => getRankloopWriterSettings({ data: { projectId } }),
  });

  // Seed from the stored row exactly once, the same way the writer form does.
  // A project that has never saved settings has no row at all, and the
  // defaults it is running are the ones already in state.
  if (settingsQuery.isSuccess && !synced) {
    const settings = settingsQuery.data;
    if (settings) {
      setDigestEmail(settings.digestEmail);
      setWebhookUrl(settings.digestWebhookUrl ?? "");
    }
    setSynced(true);
  }

  const saveMutation = useMutation({
    mutationFn: () =>
      saveRankloopDigestDelivery({
        data: {
          projectId,
          digestEmail,
          // Empty clears the channel — a URL is the whole opt-in, so there is
          // no separate switch to leave on pointing at nothing.
          digestWebhookUrl: webhookUrl.trim() || null,
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["rankloopWriterSettings", projectId],
      });
      toast.success("Digest delivery saved");
    },
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(
          error,
          "Couldn't save the delivery settings. Try again.",
        ),
      );
    },
  });

  const urlError = digestWebhookUrlError(webhookUrl);

  return (
    <Section title="Digest delivery">
      <p className="text-sm text-base-content/70">
        The digest is written here every morning something happened. These send
        the same one somewhere else.
      </p>

      <label className="flex cursor-pointer items-start gap-3 py-0">
        <input
          type="checkbox"
          checked={digestEmail}
          onChange={(event) => setDigestEmail(event.target.checked)}
          className="toggle toggle-sm toggle-primary mt-0.5"
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium">Email the digest</span>
          <span className="block text-xs text-base-content/55">
            Goes to your organization&rsquo;s account address. A deployment with
            no transactional email configured records that on the card every
            morning rather than dropping it quietly.
          </span>
        </span>
      </label>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Webhook URL</span>
        <input
          type="url"
          value={webhookUrl}
          onChange={(event) => setWebhookUrl(event.target.value)}
          placeholder="https://example.com/hooks/rankloop"
          aria-invalid={urlError !== null}
          aria-describedby="digest-webhook-help"
          className={`input input-bordered input-sm w-full max-w-xl ${
            urlError === null ? "" : "input-error"
          }`}
        />
        {urlError === null ? null : (
          <span className="text-sm text-error">{urlError}</span>
        )}
        <span id="digest-webhook-help" className="text-xs text-base-content/55">
          One POST per digest, in the same signed envelope your publish endpoint
          already verifies &mdash;{" "}
          <code className="text-[11px]">X-Rankloop-Signature</code> over the
          timestamp and body, with{" "}
          <code className="text-[11px]">X-Rankloop-Event: digest.daily</code>{" "}
          naming the event. Leave it empty to switch the channel off.
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={urlError !== null || saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
        >
          {saveMutation.isPending ? (
            <Loader2 className="size-3 animate-spin" />
          ) : null}
          Save
        </button>
        {settingsQuery.isFetching ? (
          <Loader2 className="size-4 animate-spin text-base-content/40" />
        ) : null}
      </div>
    </Section>
  );
}
