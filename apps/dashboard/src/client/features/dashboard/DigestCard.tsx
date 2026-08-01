import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import {
  CardShell,
  moreDetailsClass,
} from "@/client/features/dashboard/cardParts";
import { SafeExternalLink } from "@/client/components/SafeExternalLink";
import { proposalTypeDisplay } from "@/client/features/rankloop-articles/proposalDisplay.logic";
import {
  digestDayLabel,
  measuredResultLine,
  measuredResultTone,
} from "@/client/features/rankloop-automation/digestDisplay.logic";
import { getRankloopDigests } from "@/serverFunctions/rankloopRoutines";

type Digest = Awaited<ReturnType<typeof getRankloopDigests>>[number];

// The one surface a solo operator is meant to read every morning: what is
// waiting on a decision, what went live, what the receipts finally said, and
// what is stuck. Everything on it exists elsewhere in more detail — the point
// is that on the day it happened, it is all in one place.
//
// The list has holes in it by design. A day with nothing on it is never
// written and never stored, so a gap between rows is a quiet week rather than
// a missed run, and an unbroken column of "no activity" cards is exactly what
// this avoids.

function DigestSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium uppercase tracking-wide text-base-content/60">
        {title}
      </p>
      {children}
    </div>
  );
}

function AwaitingSection({
  awaiting,
}: {
  awaiting: Digest["payload"]["awaiting"];
}) {
  if (awaiting.total === 0) return null;
  const hidden = awaiting.total - awaiting.top.length;
  return (
    <DigestSection title="Waiting on you">
      <ul className="space-y-1.5">
        {awaiting.top.map((row) => (
          <li key={row.id} className="text-sm">
            <span className="text-base-content/60">
              {proposalTypeDisplay(row.type).label}
              {" · "}
            </span>
            <span className="font-mono text-xs">{row.title ?? row.target}</span>
            {/* One evidence line, not all of them: the card is the ask, the
                Proposals table is where the full case lives. */}
            {row.evidence.length > 0 ? (
              <span className="block text-xs text-base-content/55">
                {row.evidence[0]}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <p className="text-xs text-base-content/55">+ {hidden} more waiting</p>
      ) : null}
    </DigestSection>
  );
}

function ShippedSection({
  shipped,
}: {
  shipped: Digest["payload"]["shipped"];
}) {
  if (shipped.length === 0) return null;
  return (
    <DigestSection title="Shipped">
      <ul className="space-y-1.5">
        {shipped.map((row) => (
          <li key={row.articleId} className="text-sm">
            {/* The URL comes back from a publish adapter, so it goes through
                the same guard as every other externally-sourced link. A null
                one renders as plain text rather than a link that may 404. */}
            {row.url === null ? (
              <span>{row.title}</span>
            ) : (
              <SafeExternalLink
                url={row.url}
                label={row.title}
                className="link link-hover inline-flex items-center gap-1"
              />
            )}
          </li>
        ))}
      </ul>
    </DigestSection>
  );
}

function MeasuredSection({
  measured,
}: {
  measured: Digest["payload"]["measured"];
}) {
  if (measured.length === 0) return null;
  return (
    <DigestSection title="Measured">
      <ul className="space-y-1.5">
        {measured.map((row) => (
          <li
            key={row.receiptId}
            className="flex flex-wrap items-baseline gap-x-2 text-sm"
          >
            <span className="font-mono text-xs">{row.target}</span>
            <span className={`tabular-nums ${measuredResultTone(row)}`}>
              {measuredResultLine(row)}
            </span>
          </li>
        ))}
      </ul>
    </DigestSection>
  );
}

function BlockedSection({
  blocked,
}: {
  blocked: Digest["payload"]["blocked"];
}) {
  if (blocked.length === 0) return null;
  return (
    <DigestSection title="Blocked">
      <ul className="space-y-1.5">
        {blocked.map((row) => (
          // Severity dot, not a badge — the same idiom the audit issues use,
          // and these are the rows somebody has to act on.
          <li
            key={`${row.kind}-${row.detail}`}
            className="flex items-start gap-2 text-sm"
          >
            <span className="mt-1.5 size-2 shrink-0 rounded-full bg-warning" />
            <span className="text-base-content/70">{row.detail}</span>
          </li>
        ))}
      </ul>
    </DigestSection>
  );
}

function DigestRow({
  digest,
  open,
  onToggle,
}: {
  digest: Digest;
  open: boolean;
  onToggle: () => void;
}) {
  const contentId = `digest-${digest.id}`;
  return (
    <li className="border-b border-base-300 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={contentId}
        className="flex w-full items-center gap-2 py-2.5 text-left"
      >
        <ChevronDown
          className={`size-4 shrink-0 text-base-content/40 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
        <span className="w-14 shrink-0 text-sm font-medium tabular-nums">
          {digestDayLabel(digest.forDate)}
        </span>
        <span className="min-w-0 truncate text-sm text-base-content/60">
          {digest.payload.headline}
        </span>
      </button>
      {open ? (
        <div id={contentId} className="space-y-4 pb-4 pl-6 pr-1">
          <AwaitingSection awaiting={digest.payload.awaiting} />
          <ShippedSection shipped={digest.payload.shipped} />
          <MeasuredSection measured={digest.payload.measured} />
          <BlockedSection blocked={digest.payload.blocked} />
        </div>
      ) : null}
    </li>
  );
}

export function DigestCard({ projectId }: { projectId: string }) {
  const digestsQuery = useQuery({
    queryKey: ["rankloopDigests", projectId],
    queryFn: () => getRankloopDigests({ data: { projectId } }),
  });
  // undefined means nobody has clicked yet, which is what opens the newest one
  // on arrival without pinning it open once they have.
  const [openId, setOpenId] = useState<string | null | undefined>(undefined);

  if (digestsQuery.isPending) {
    return (
      <CardShell title="Daily digest">
        <div aria-busy className="space-y-2">
          {[0, 1, 2].map((index) => (
            <div key={index} className="skeleton h-5 w-full" />
          ))}
        </div>
      </CardShell>
    );
  }

  if (digestsQuery.isError) {
    return (
      <CardShell title="Daily digest">
        <p className="text-sm text-base-content/60">
          Couldn&rsquo;t load the digests. Try again shortly.
        </p>
      </CardShell>
    );
  }

  const digests = digestsQuery.data;
  const activeId = openId === undefined ? (digests[0]?.id ?? null) : openId;

  return (
    <CardShell
      title="Daily digest"
      stamp="written after the morning routine · a day with nothing on it is not written at all"
      action={
        <Link
          to="/p/$projectId/settings"
          params={{ projectId }}
          hash="automation"
          className={moreDetailsClass}
        >
          Automation
        </Link>
      }
    >
      {digests.length === 0 ? (
        <p className="text-sm text-base-content/70">
          No digest yet. One is written the first morning something happens — a
          proposal to decide, a post that went live, a receipt that closed.
        </p>
      ) : (
        <ul className="-my-2.5">
          {digests.map((digest) => (
            <DigestRow
              key={digest.id}
              digest={digest}
              open={digest.id === activeId}
              onToggle={() =>
                setOpenId(digest.id === activeId ? null : digest.id)
              }
            />
          ))}
        </ul>
      )}
    </CardShell>
  );
}
