import { Fragment, useState } from "react";
import { formatDay } from "@/client/features/dashboard/cardParts";
import {
  isFreshQuestionSlot,
  netNewEvidenceChips,
} from "@/client/features/rankloop-articles/netNewDisplay.logic";
import {
  formatFactorValue,
  formatScore,
} from "@/client/features/rankloop-articles/proposalDisplay.logic";
import {
  EvidenceChip,
  FreshQuestionChip,
  PageTypeChip,
  TypeChip,
} from "@/client/features/rankloop-articles/RankloopProposalChips";
import { RankloopPushGuidance } from "@/client/features/rankloop-articles/RankloopPushGuidance";
import { RankloopWriteAction } from "@/client/features/rankloop-articles/RankloopWriteAction";
import type { getRankloopProposals } from "@/serverFunctions/rankloopProposals";
import type { getRankloopArticles } from "@/serverFunctions/rankloopWriter";

type ProposalRow = Awaited<ReturnType<typeof getRankloopProposals>>[number];
type ArticleRow = Awaited<ReturnType<typeof getRankloopArticles>>[number];
type Decision = "approved" | "declined";

// The writer's slice of the row, grouped so adding generation to this table
// cost it one prop rather than four. `articles` is keyed by proposalId — the
// partial unique makes that a one-to-one for everything not yet published.
type WritingProps = {
  providerConfigured: boolean;
  articles: Map<string, ArticleRow>;
  pendingProposalId: string | null;
  onWrite: (row: ProposalRow) => void;
};

// The score's inputs, parsed server-side from factorsJson — every score
// must be explainable, so the breakdown names each factor with its value
// and the engine's note on why it counted.
function FactorBreakdown({ factors }: { factors: ProposalRow["factors"] }) {
  if (factors.length === 0) {
    return (
      <p className="text-sm text-base-content/60">
        No factor breakdown recorded for this proposal.
      </p>
    );
  }
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-base-content/60">
        Score factors
      </p>
      <ul className="mt-2 space-y-1">
        {factors.map((factor) => (
          <li
            key={factor.name}
            className="flex flex-wrap items-baseline gap-x-3 text-sm"
          >
            <span className="w-44 shrink-0 text-base-content/70">
              {factor.name}
            </span>
            <span className="font-medium tabular-nums">
              {formatFactorValue(factor.value)}
            </span>
            {factor.note ? (
              <span className="text-xs text-base-content/50">
                {factor.note}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

// The expanded area: score factors always, plus the execution guidance an
// approved row needs — inlink placement for a push, the manual-attestation
// escape hatch for a retitle applied outside the adapter.
function ProposalDetailRow({
  row,
  projectId,
  attesting,
  onAttest,
}: {
  row: ProposalRow;
  projectId: string;
  attesting: boolean;
  onAttest: (row: ProposalRow) => void;
}) {
  const approved = row.status === "approved";
  return (
    <tr>
      <td colSpan={5} className="bg-base-200/30 px-4 py-3">
        <div className="space-y-4">
          {approved && row.type === "push" ? (
            <RankloopPushGuidance projectId={projectId} proposalId={row.id} />
          ) : null}
          <FactorBreakdown factors={row.factors} />
          {approved && row.type === "retitle" ? (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={attesting}
                onClick={() => onAttest(row)}
              >
                Mark done (applied manually)
              </button>
              <span className="text-xs text-base-content/55">
                Already changed the title yourself? Marking it done starts the
                receipt.
              </span>
            </div>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function RowActions({
  row,
  projectId,
  hasConnection,
  writing,
  decidingId,
  attestingId,
  onDecide,
  onApplyRetitle,
  onAttest,
}: {
  row: ProposalRow;
  projectId: string;
  hasConnection: boolean;
  writing: WritingProps;
  decidingId: string | null;
  attestingId: string | null;
  onDecide: (proposalId: string, decision: Decision) => void;
  onApplyRetitle: (row: ProposalRow) => void;
  onAttest: (row: ProposalRow) => void;
}) {
  if (row.status === "proposed") {
    return (
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={decidingId === row.id}
          onClick={() => onDecide(row.id, "approved")}
        >
          Approve
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={decidingId === row.id}
          onClick={() => onDecide(row.id, "declined")}
        >
          Decline
        </button>
      </div>
    );
  }
  // Generation is the net-new track's only execution path: an optimize row
  // edits a page that exists, a net-new row has nothing until something
  // writes it.
  if (row.status === "approved" && row.track === "net_new") {
    return (
      <RankloopWriteAction
        projectId={projectId}
        article={writing.articles.get(row.id)}
        providerConfigured={writing.providerConfigured}
        isPending={writing.pendingProposalId === row.id}
        onWrite={() => writing.onWrite(row)}
      />
    );
  }
  // A retitle applies through the adapter, so the row action only appears
  // once a connection exists — without one, the More-details area still
  // offers the manual-attestation path and the banner explains why.
  if (row.status === "approved" && row.type === "retitle" && hasConnection) {
    return (
      <button
        type="button"
        className="btn btn-primary btn-sm"
        onClick={() => onApplyRetitle(row)}
      >
        Apply…
      </button>
    );
  }
  if (row.status === "approved" && row.type === "push") {
    return (
      <button
        type="button"
        className="btn btn-primary btn-sm"
        disabled={attestingId === row.id}
        onClick={() => onAttest(row)}
      >
        Mark done
      </button>
    );
  }
  const stampDate = row.executedAt ?? row.decidedAt;
  return stampDate ? (
    <span className="text-xs text-base-content/50">{formatDay(stampDate)}</span>
  ) : null;
}

export function RankloopProposalsTable({
  rows,
  projectId,
  hasConnection,
  writing,
  decidingId,
  attestingId,
  onDecide,
  onApplyRetitle,
  onAttest,
  onViewBrief,
}: {
  rows: ProposalRow[];
  projectId: string;
  hasConnection: boolean;
  writing: WritingProps;
  decidingId: string | null;
  attestingId: string | null;
  onDecide: (proposalId: string, decision: Decision) => void;
  onApplyRetitle: (row: ProposalRow) => void;
  onAttest: (row: ProposalRow) => void;
  onViewBrief: (row: ProposalRow) => void;
}) {
  // One breakdown open at a time: the row is an explanation you consult,
  // not a comparison view, and a single slot keeps the table calm.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="overflow-x-auto">
      <table className="table table-sm">
        <thead>
          <tr>
            <th>Type</th>
            <th>Proposal</th>
            <th>Evidence</th>
            <th className="text-right">Score</th>
            <th className="text-right" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Fragment key={row.id}>
              <tr>
                <td>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <TypeChip type={row.type} />
                    {/* Which approved shape this net-new row was written
                        against — the optimize rows have no page type, so the
                        chip is also what tells the two tracks apart. */}
                    {row.pageTypeName ? (
                      <PageTypeChip name={row.pageTypeName} />
                    ) : null}
                  </div>
                </td>
                <td>
                  {row.title ? (
                    <>
                      <span
                        className="block max-w-md truncate font-medium"
                        title={row.title}
                      >
                        {row.title}
                      </span>
                      <span
                        className="block max-w-md truncate font-mono text-xs text-base-content/50"
                        title={row.target}
                      >
                        {row.target}
                      </span>
                    </>
                  ) : (
                    <span
                      className="block max-w-md truncate font-mono"
                      title={row.target}
                    >
                      {row.target}
                    </span>
                  )}
                </td>
                <td>
                  <div className="flex flex-wrap gap-1.5">
                    {/* Leads the evidence, because the pool slot is the one
                        reason a row is here that its score does not explain. */}
                    {isFreshQuestionSlot(row.factors) ? (
                      <FreshQuestionChip />
                    ) : null}
                    {netNewEvidenceChips(row.evidence, row.pageTypeName).map(
                      (chip, index) => (
                        <EvidenceChip key={`${chip}-${index}`} label={chip} />
                      ),
                    )}
                  </div>
                </td>
                <td className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <span className="font-medium tabular-nums">
                      {formatScore(row.score)}
                    </span>
                    {/* Inspection sits with the score, decisions sit in the
                        actions column — a net-new row is worth reading before
                        it is worth approving. */}
                    {row.track === "net_new" ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs"
                        onClick={() => onViewBrief(row)}
                      >
                        View brief
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs"
                      aria-expanded={expandedId === row.id}
                      onClick={() =>
                        setExpandedId(expandedId === row.id ? null : row.id)
                      }
                    >
                      {expandedId === row.id ? "Hide details" : "More details"}
                    </button>
                  </div>
                </td>
                <td className="text-right">
                  <RowActions
                    row={row}
                    projectId={projectId}
                    hasConnection={hasConnection}
                    writing={writing}
                    decidingId={decidingId}
                    attestingId={attestingId}
                    onDecide={onDecide}
                    onApplyRetitle={onApplyRetitle}
                    onAttest={onAttest}
                  />
                </td>
              </tr>
              {expandedId === row.id ? (
                <ProposalDetailRow
                  row={row}
                  projectId={projectId}
                  attesting={attestingId === row.id}
                  onAttest={onAttest}
                />
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
