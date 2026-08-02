import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import {
  groupByOperator,
  headlineFor,
  purposeHelp,
  purposeLabel,
  redirectNote,
  severityChipClass,
  severityLabel,
  toneTextClass,
} from "@/client/features/rankloop-verdict/aiAccessDisplay.logic";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  getRankloopAiAccess,
  runRankloopAiAccess,
} from "@/serverFunctions/rankloopVerdict";
import type { Finding } from "@/server/features/rankloop/verdict/findings.logic";

const chipBaseClass =
  "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[11px] font-medium";

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-xs btn-ghost gap-1"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? "Copied" : label}
    </button>
  );
}

/** A diff, rendered so added lines read as added. Deliberately not a syntax
 *  highlighter — the only thing that matters here is what changes. */
function DiffBlock({ diff }: { diff: string }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-md bg-base-300/40 p-3 text-[11px] leading-relaxed">
      {diff.split("\n").map((line, i) => (
        <div
          key={i}
          className={
            line.startsWith("+")
              ? "text-success"
              : line.startsWith("-")
                ? "text-error"
                : line.startsWith("@@")
                  ? "text-base-content/40"
                  : "text-base-content/70"
          }
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

function FixBody({ fix }: { fix: Finding["fix"] }) {
  if (fix.kind === "patch") {
    return (
      <div className="space-y-2">
        {fix.note ? (
          <p className="text-xs text-base-content/70">{fix.note}</p>
        ) : null}
        <DiffBlock diff={fix.diff} />
        <div className="flex flex-wrap items-center gap-2">
          <CopyButton text={fix.content} label={`Copy ${fix.filename}`} />
          {/* True of every patch. Anything more specific belongs in the
              finding's own note, where it knows which file it is talking
              about — a generic line here once claimed a brand new llms.txt
              would "replace the same block". */}
          <span className="text-[11px] text-base-content/50">
            This is the complete {fix.filename}, not a snippet.
          </span>
        </div>
        {fix.manualEdits && fix.manualEdits.length > 0 ? (
          <div className="rounded-md border border-warning/30 bg-warning/5 p-2">
            <p className="text-xs font-medium text-warning">
              These cannot be fixed by adding lines
            </p>
            <ul className="mt-1 space-y-1 text-xs text-base-content/70">
              {fix.manualEdits.map((edit) => (
                <li key={`${edit.agent}-${edit.line}`}>
                  <span className="font-medium">{edit.agent}</span> — line{" "}
                  {edit.line}: change <code>{edit.current}</code> to{" "}
                  <code>{edit.replacement}</code>. {edit.why}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    );
  }

  if (fix.kind === "manual") {
    return (
      <ol className="list-decimal space-y-1 pl-4 text-xs text-base-content/70">
        {fix.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-base-content/70">{fix.note}</p>
      <ul className="space-y-1 text-xs">
        {fix.items.map((item) => (
          <li key={item} className="font-mono text-base-content/60">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FindingCard({ finding }: { finding: Finding }) {
  return (
    <details className="group rounded-lg border border-base-300 bg-base-100">
      <summary className="flex cursor-pointer list-none items-start gap-3 p-3">
        <span
          className={`${chipBaseClass} mt-0.5 ${severityChipClass(finding.severity)}`}
        >
          {severityLabel(finding.severity)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{finding.title}</span>
          <span className="mt-0.5 block text-xs text-base-content/70">
            {finding.detail}
          </span>
        </span>
        <span className="mt-0.5 shrink-0 text-[11px] text-base-content/50 group-open:hidden">
          Show fix
        </span>
      </summary>
      <div className="border-t border-base-300 p-3">
        <FixBody fix={finding.fix} />
      </div>
    </details>
  );
}

function AgentTable({
  agents,
}: {
  agents: {
    name: string;
    operator: string;
    purpose: "training" | "search" | "user-fetch";
    allowed: boolean;
    rule: { type: "allow" | "disallow"; pattern: string; line: number } | null;
  }[];
}) {
  const groups = groupByOperator(agents);
  return (
    <div className="overflow-hidden rounded-lg border border-base-300">
      {groups.map((group) => (
        <div key={group.operator} className="border-b border-base-300 last:border-b-0">
          <div className="flex items-center justify-between bg-base-200/50 px-3 py-1.5">
            <span className="text-xs font-medium">{group.operator}</span>
            {group.blocked > 0 ? (
              <span className="text-[11px] text-error">
                {group.blocked} blocked
              </span>
            ) : (
              <span className="text-[11px] text-base-content/50">allowed</span>
            )}
          </div>
          {group.agents.map((agent) => (
            <div
              key={agent.name}
              className="flex items-center gap-3 px-3 py-2 text-xs"
            >
              {agent.allowed ? (
                <Check className="size-3.5 shrink-0 text-success" />
              ) : (
                <X className="size-3.5 shrink-0 text-error" />
              )}
              <span className="w-44 shrink-0 font-mono text-[11px]">
                {agent.name}
              </span>
              <span
                className="shrink-0 text-base-content/60"
                title={purposeHelp(agent.purpose)}
              >
                {purposeLabel(agent.purpose)}
              </span>
              {/* The rule that decided, so the claim can be checked against
                  the user's own file rather than taken on faith. */}
              {agent.rule ? (
                <span className="ml-auto truncate font-mono text-[11px] text-base-content/40">
                  robots.txt:{agent.rule.line}{" "}
                  {agent.rule.type === "allow" ? "Allow" : "Disallow"}:{" "}
                  {agent.rule.pattern}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function RankloopAiAccessPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["rankloopAiAccess", projectId],
    queryFn: () => getRankloopAiAccess({ data: { projectId } }),
  });

  const run = useMutation({
    mutationFn: () => runRankloopAiAccess({ data: { projectId } }),
    onSuccess: (card) => {
      queryClient.setQueryData(["rankloopAiAccess", projectId], card);
    },
  });

  if (query.isPending) {
    return (
      <div className="rounded-lg border border-base-300 bg-base-100 p-6">
        <span className="loading loading-spinner loading-sm" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="rounded-lg border border-error/30 bg-error/5 p-4 text-sm">
        {getStandardErrorMessage(query.error)}
      </div>
    );
  }

  const card = query.data;
  const headline = headlineFor(card);
  const note = redirectNote(card);
  const firstRun = card.state !== "ready";

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-base-300 bg-base-100 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className={`text-base font-semibold ${toneTextClass(headline.tone)}`}>
              {headline.title}
            </p>
            <p className="mt-1 text-sm text-base-content/70">{headline.detail}</p>
            {note ? (
              <p className="mt-2 text-xs text-base-content/50">{note}</p>
            ) : null}
          </div>
          <button
            type="button"
            className="btn btn-sm shrink-0 gap-1.5"
            disabled={run.isPending}
            onClick={() => run.mutate()}
          >
            <RefreshCw
              className={`size-3.5 ${run.isPending ? "animate-spin" : ""}`}
            />
            {firstRun ? "Run check" : "Re-check"}
          </button>
        </div>
        {run.isError ? (
          <p className="mt-3 text-xs text-error">
            {getStandardErrorMessage(run.error)}
          </p>
        ) : null}
        {card.checkedAt && !firstRun ? (
          <p className="mt-3 text-[11px] text-base-content/40">
            Checked {new Date(card.checkedAt).toLocaleString()}
            {card.htmlWords !== null
              ? ` · ${card.htmlWords.toLocaleString()} words of text found in your homepage HTML`
              : ""}
          </p>
        ) : null}
      </div>

      {/* Nothing below exists until a probe has run. Rendering empty tables
          with a first-run headline would suggest the check ran and found an
          empty site. */}
      {firstRun ? null : (
        <>
          {card.findings.length > 0 ? (
            <div className="space-y-2">
              {card.findings.map((finding) => (
                <FindingCard key={finding.id} finding={finding} />
              ))}
            </div>
          ) : null}

          {card.agents.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-medium text-base-content/60">
                Per crawler
              </p>
              <AgentTable agents={card.agents} />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
