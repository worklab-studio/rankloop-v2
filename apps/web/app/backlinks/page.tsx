import type { Metadata } from "next";
import { ExternalLink } from "lucide-react";
import { backlinks, backlinksSummary, fmtInt } from "@/lib/mock";
import { CardShell, EmptyState, PageHeader, StatCard, TagChip } from "@/components/ui";

export const metadata: Metadata = { title: "Backlinks — rankloop" };

function stripProtocol(u: string): string {
  return u.replace(/^https?:\/\//, "");
}

function targetPath(u: string): string {
  try {
    return new URL(u).pathname;
  } catch {
    return u;
  }
}

function fmtDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default function BacklinksPage() {
  const s = backlinksSummary;
  // live links first, freshest first; lost links sink to the bottom
  const rows = [...backlinks].sort(
    (a, b) => Number(a.lost) - Number(b.lost) || b.firstSeen.localeCompare(a.firstSeen),
  );

  return (
    <>
      <PageHeader
        title="Backlinks"
        subtitle="Link profile from the backlink index — snapshot daily, deltas over 30 days."
      />

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <StatCard label="Backlinks" value={fmtInt(s.backlinks)} sub="total live links" />
        <StatCard
          label="Referring domains"
          value={fmtInt(s.referringDomains)}
          sub="unique linking sites"
        />
        <StatCard label="Domain rank" value={fmtInt(s.rank)} sub="index scale 0–1000" />
        <StatCard label="Broken" value={fmtInt(s.brokenBacklinks)} sub="point at pages that 404" />
        {/* new/lost needs two tones in one value, so it gets a StatCard-shaped twin */}
        <div className="rounded-xl border border-base-300 bg-base-100 p-4 shadow-sm">
          <p className="text-xs uppercase tracking-wide text-base-content/60">Last 30 days</p>
          <p className="text-2xl font-semibold tabular-nums">
            <span className="text-success">+{s.newLast30d}</span>
            <span className="text-base-content/30"> / </span>
            <span className="text-error">−{s.lostLast30d}</span>
          </p>
          <p className="text-xs text-base-content/60">new vs lost links</p>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No backlinks discovered yet"
          hint="The index has not found any links to this site — publish, and check back after the next snapshot."
        />
      ) : (
        <CardShell
          title="Recent backlinks"
          action={<span className="badge badge-ghost badge-sm">{rows.length}</span>}
          stamp="Read-only intel. Actions live in Opportunities — rankloop never automates outreach."
        >
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Target</th>
                  <th>Anchor</th>
                  <th>Follow</th>
                  <th>First seen</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr
                    key={`${b.sourceUrl}→${b.targetUrl}`}
                    className={b.lost ? "opacity-50" : undefined}
                  >
                    <td>
                      <a
                        href={b.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group flex max-w-xs items-center gap-1.5 hover:text-primary"
                        title={b.sourceUrl}
                      >
                        <span className="truncate font-medium">{stripProtocol(b.sourceUrl)}</span>
                        <ExternalLink className="h-3 w-3 shrink-0 text-base-content/40 group-hover:text-primary" />
                      </a>
                    </td>
                    <td className="font-mono text-xs text-base-content/70">
                      {targetPath(b.targetUrl)}
                    </td>
                    <td className="italic text-base-content/70">&ldquo;{b.anchor}&rdquo;</td>
                    <td>
                      {b.dofollow ? (
                        <TagChip color="slate">dofollow</TagChip>
                      ) : (
                        <span className="badge badge-ghost badge-sm">nofollow</span>
                      )}
                    </td>
                    <td
                      className="whitespace-nowrap tabular-nums text-base-content/60"
                      title={b.firstSeen}
                    >
                      {fmtDate(b.firstSeen)}
                    </td>
                    <td>
                      {b.lost ? (
                        <TagChip color="rose">lost</TagChip>
                      ) : (
                        <span className="badge badge-ghost badge-sm">live</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardShell>
      )}
    </>
  );
}
