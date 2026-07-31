import { useState } from "react";
import { toast } from "sonner";
import { Modal } from "@/client/components/Modal";
import { SafeExternalLink } from "@/client/components/SafeExternalLink";
import {
  evidenceLine,
  matchReasonLine,
} from "@/client/features/rankloop-plan/outreachDisplay.logic";
import type { getRankloopOutreach } from "@/serverFunctions/rankloopOutreach";

type OutreachTargetRow = Awaited<
  ReturnType<typeof getRankloopOutreach>
>["targets"][number];

const eyebrowClass =
  "text-xs font-medium uppercase tracking-wide text-base-content/60";

export function RankloopOutreachMessageModal({
  target,
  onClose,
}: {
  target: OutreachTargetRow;
  onClose: (draftMessage: string) => void;
}) {
  const [message, setMessage] = useState(target.draftMessage ?? "");

  // Closing is saving — there is no Save button because there is nothing to
  // decide. The draft is a scratchpad for the human who will send it, and a
  // dialog that can lose an edit to Escape is worse than one that always
  // keeps it.
  const handleClose = () => onClose(message);

  const handleCopy = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      toast.error("Clipboard not available");
      return;
    }
    try {
      await navigator.clipboard.writeText(message);
      toast.success("Message copied");
    } catch {
      toast.error("Could not copy to clipboard");
    }
  };

  const matchReason = matchReasonLine(target.matchType);

  return (
    <Modal
      onClose={handleClose}
      labelledBy="outreach-draft-title"
      maxWidth="max-w-lg"
    >
      <h3 id="outreach-draft-title" className="text-lg font-semibold">
        Draft for {target.domain}
      </h3>

      <div className="space-y-1.5">
        <p className={eyebrowClass}>Evidence</p>
        <ul className="space-y-1 text-sm text-base-content/70">
          {target.evidence.map((entry) => (
            <li key={entry.competitorId}>{evidenceLine(entry)}</li>
          ))}
        </ul>
      </div>

      {target.assetPath ? (
        <div className="space-y-1.5">
          <p className={eyebrowClass}>Your asset</p>
          {target.assetUrl ? (
            <SafeExternalLink
              url={target.assetUrl}
              label={target.assetPath}
              className="link link-hover break-all inline-flex items-center gap-1 font-mono text-xs"
            />
          ) : (
            <p className="break-all font-mono text-xs">{target.assetPath}</p>
          )}
          {matchReason ? (
            <p className="text-xs text-base-content/55">{matchReason}</p>
          ) : null}
        </div>
      ) : null}

      {/* No Contact page block. outreach_targets.contactUrl has no writer and
          cannot get one cheaply: the only crawls in the product are the site
          audit (our own domain) and the competitor study, whose sitemap and
          page fetches are aimed at the COMPETITOR's domain — outreach targets
          are the domains linking to those competitors, collected from the
          DataForSEO referring-domains endpoint without a single HTTP request
          to them. Populating the column would mean a new fetch per target,
          which is not what the fix was worth. A block that can never render
          is a worse affordance than none, so it is gone rather than dormant;
          the column stays for whenever a crawl does reach these domains. And
          it stays a PAGE url when it does — rankloop extracts no addresses. */}

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Message</span>
        {target.draftMessage === null ? (
          <span className="text-xs text-base-content/55">
            Nothing of yours matched what this domain links to, so there is no
            draft &mdash; write your own, or come back after the next study.
          </span>
        ) : null}
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          rows={9}
          className="textarea textarea-bordered w-full"
        />
      </label>

      <p className="text-xs text-base-content/55">
        Copy it into your own email client &mdash; rankloop never sends.
      </p>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={handleClose}
        >
          Close
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={message.trim() === ""}
          onClick={() => void handleCopy()}
        >
          Copy message
        </button>
      </div>
    </Modal>
  );
}
