import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Collapsible } from "@/client/features/ai-mcp/SetupControls";
import { OptionCards } from "@/client/features/rankloop-articles/RankloopOptionCards";
import type { WriterMode } from "@/client/features/rankloop-articles/writerMode.logic";
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

// Which writer holds the pen. Both cards name what the mode costs and where
// the words come from, because that is the actual difference — the queue, the
// laws and the receipts are the same on either side.
const WRITER_MODE_OPTIONS: {
  value: WriterMode;
  title: string;
  body: string;
}[] = [
  {
    value: "api",
    title: "rankloop writes",
    body: "Drafts here with your OpenRouter key, checks the laws, and stops where the trust dial says. Every call is metered into the spend ledger.",
  },
  {
    value: "agent",
    title: "Your agent writes",
    body: "Your coding agent pulls approved proposals and briefs over MCP, writes the page in your own repo, and reports what it shipped. Nothing here spends.",
  },
];

export function RankloopWriterSettings({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [postsPerDay, setPostsPerDay] = useState("2");
  const [catchupCap, setCatchupCap] = useState("6");
  const [quotaStartDate, setQuotaStartDate] = useState("");
  const [voiceCardMd, setVoiceCardMd] = useState("");
  const [trustDial, setTrustDial] = useState<TrustDial>("titles");
  const [writerMode, setWriterMode] = useState<WriterMode>("api");
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
      setWriterMode(settings.writerMode);
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
          writerMode,
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
        subtitle="Who writes, how much you publish, in whose voice, and how far it runs alone"
      >
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-base-content/60">
            Who writes
          </p>
          <OptionCards
            name="rankloop-writer-mode"
            options={WRITER_MODE_OPTIONS}
            value={writerMode}
            columns={2}
            onChange={setWriterMode}
          />
          <p className="text-xs text-base-content/55">
            Same queue, same laws, same receipts either way &mdash; a project
            can run pSEO volume through rankloop and editorial through its own
            agent. In agent mode an approved proposal stays approved until the
            agent reports what it shipped.{" "}
            <Link to="/ai" className="link link-primary font-medium">
              Set up the tools and the skill in AI &amp; MCP →
            </Link>
          </p>
        </div>

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
          <OptionCards
            name="rankloop-trust-dial"
            options={TRUST_DIAL_OPTIONS}
            value={trustDial}
            columns={3}
            onChange={setTrustDial}
          />
          <p className="text-xs text-base-content/55">
            Saved now, not yet honored &mdash; today every proposal stops at the
            brief, whichever card is selected.
            {writerMode === "agent"
              ? " In agent mode it applies to nothing: your agent decides when to open the PR, and the laws still decide what may merge."
              : null}
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
