import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Collapsible } from "@/client/features/ai-mcp/SetupControls";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  getRankloopWriterSettings,
  saveRankloopWriterSettings,
} from "@/serverFunctions/rankloopWriting";

type TrustDial = "titles" | "drafts" | "autopilot";

// How far the loop is allowed to run on its own. The three cards say what
// each setting stops at, because "trust" only means something if the user can
// read where the brakes are. Autopilot names its precondition instead of
// being greyed out with no explanation.
const TRUST_DIAL_OPTIONS: { value: TrustDial; title: string; body: string }[] =
  [
    {
      value: "titles",
      title: "Titles only",
      body: "rankloop picks the keyword and assembles the brief. You write the post.",
    },
    {
      value: "drafts",
      title: "Drafts",
      body: "rankloop writes the draft and stops at review. Nothing reaches your site without a yes.",
    },
    {
      value: "autopilot",
      title: "Autopilot",
      body: "rankloop writes, checks the laws and publishes on its own. Unlocks once receipts prove the loop on your site.",
    },
  ];

function TrustDialCards({
  value,
  onChange,
}: {
  value: TrustDial;
  onChange: (next: TrustDial) => void;
}) {
  return (
    <div className="grid gap-2 md:grid-cols-3">
      {TRUST_DIAL_OPTIONS.map((option) => {
        const selected = value === option.value;
        return (
          <label
            key={option.value}
            className={`flex cursor-pointer gap-2.5 rounded-lg border p-3 transition-colors ${
              selected
                ? "border-primary bg-primary/5"
                : "border-base-300 bg-base-200/20 hover:bg-base-200/40"
            }`}
          >
            <input
              type="radio"
              name="rankloop-trust-dial"
              className="radio radio-sm mt-0.5 shrink-0"
              checked={selected}
              onChange={() => onChange(option.value)}
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium">{option.title}</span>
              <span className="text-xs text-base-content/55">
                {option.body}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function RankloopWriterSettings({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [postsPerDay, setPostsPerDay] = useState("2");
  const [catchupCap, setCatchupCap] = useState("6");
  const [quotaStartDate, setQuotaStartDate] = useState("");
  const [voiceCardMd, setVoiceCardMd] = useState("");
  const [trustDial, setTrustDial] = useState<TrustDial>("titles");
  const [synced, setSynced] = useState(false);

  const settingsQuery = useQuery({
    queryKey: ["rankloopWriterSettings", projectId],
    queryFn: () => getRankloopWriterSettings({ data: { projectId } }),
  });
  const settings = settingsQuery.data ?? null;

  // Seed the form from the stored row exactly once. The numbers live in state
  // as strings so a half-typed field stays half-typed instead of snapping to
  // 0 on every keystroke.
  if (settingsQuery.isSuccess && !synced) {
    if (settings) {
      setPostsPerDay(String(settings.postsPerDay));
      setCatchupCap(String(settings.catchupCap));
      setQuotaStartDate(settings.quotaStartDate ?? "");
      setVoiceCardMd(settings.voiceCardMd ?? "");
      setTrustDial(settings.trustDial);
    }
    setSynced(true);
  }

  const saveMutation = useMutation({
    mutationFn: () =>
      saveRankloopWriterSettings({
        data: {
          projectId,
          postsPerDay: Number(postsPerDay),
          catchupCap: Number(catchupCap),
          // Empty clears the start date, which is how the quota is turned
          // off — selection then happens only when you press Propose now.
          quotaStartDate: quotaStartDate.trim() || null,
          voiceCardMd: voiceCardMd.trim() || null,
          trustDial,
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["rankloopWriterSettings", projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["rankloopWritingQuota", projectId],
      });
      toast.success("Writing settings saved");
    },
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(
          error,
          "Couldn't save the settings. Try again.",
        ),
      );
    },
  });

  const postsPerDayValid = Number.isInteger(Number(postsPerDay));
  const catchupCapValid = Number.isInteger(Number(catchupCap));

  return (
    <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100">
      <Collapsible
        id="writing"
        title="Writing"
        subtitle="How much you publish, in whose voice, and how far it runs alone"
      >
        <div className="flex flex-wrap gap-4">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Posts per day</span>
            <input
              type="number"
              min={0}
              max={20}
              value={postsPerDay}
              onChange={(event) => setPostsPerDay(event.target.value)}
              className="input input-bordered input-sm w-20 tabular-nums"
            />
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Catch-up cap</span>
            <input
              type="number"
              min={0}
              max={50}
              value={catchupCap}
              onChange={(event) => setCatchupCap(event.target.value)}
              className="input input-bordered input-sm w-20 tabular-nums"
            />
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Quota starts</span>
            <input
              type="date"
              value={quotaStartDate}
              onChange={(event) => setQuotaStartDate(event.target.value)}
              className="input input-bordered input-sm w-44"
            />
          </label>
        </div>

        <p className="text-xs text-base-content/55">
          A missed day is owed, not skipped &mdash; the cap is what stops a
          two-week gap from proposing 28 posts at once. Leave the start date
          empty to keep the quota off and propose manually.
        </p>

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">Voice card</span>
          <textarea
            value={voiceCardMd}
            onChange={(event) => setVoiceCardMd(event.target.value)}
            rows={6}
            placeholder="Who writes here, what they have actually done, the words they never use."
            className="textarea textarea-bordered w-full max-w-2xl"
          />
          <span className="text-xs text-base-content/50">
            Appended to every brief. Empty is fine: the brief then says to write
            plainly and in first person, rather than inventing a persona for
            you.
          </span>
        </label>

        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-base-content/60">
            Trust dial
          </p>
          <TrustDialCards value={trustDial} onChange={setTrustDial} />
          <p className="text-xs text-base-content/55">
            Saved now, not yet honored &mdash; today every proposal stops at the
            brief, whichever card is selected.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={
              !postsPerDayValid || !catchupCapValid || saveMutation.isPending
            }
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
      </Collapsible>
    </div>
  );
}
