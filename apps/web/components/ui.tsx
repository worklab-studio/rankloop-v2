/** Shared UI primitives, matching OpenSEO's visual language exactly
 * (cardParts.tsx / keywords/utils.ts idioms): CardShell with header row +
 * divider, uppercase Stat labels with tabular-nums values, muted tag
 * chips, KD score tiers. Every screen composes these so the app reads as
 * one product. */

import type { EvidenceChip, ProposalType, ScoreFactor } from "@/lib/types";

export function PageHeader({
  title, subtitle, actions,
}: {
  title: string; subtitle?: string; actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-base-content/60">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** OpenSEO's CardShell, verbatim: rounded-xl, shadow-sm, header row +
 * divider. `stamp` is the small provenance line at the bottom. */
export function CardShell({
  title, stamp, action, children, bodyClassName,
}: {
  title: string; stamp?: string; action?: React.ReactNode;
  children: React.ReactNode; bodyClassName?: string;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100 shadow-sm">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <h2 className="text-base font-semibold leading-tight">{title}</h2>
        {action}
      </div>
      <div className={`border-t border-base-300 p-5 ${bodyClassName ?? ""}`}>
        {children}
        {stamp ? <p className="mt-4 text-[11px] text-base-content/45">{stamp}</p> : null}
      </div>
    </div>
  );
}

/** OpenSEO's Stat: uppercase label, big tabular-nums value. */
export function Stat({
  label, value, tone, sub,
}: {
  label: string; value: string; tone?: "success" | "error"; sub?: React.ReactNode;
}) {
  const toneClass = tone === "success" ? "text-success" : tone === "error" ? "text-error" : "";
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-base-content/60">{label}</p>
      <p className={`text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</p>
      {sub}
    </div>
  );
}

export function PercentDelta({ pct }: { pct: number }) {
  const rounded = Math.round(pct);
  const tone = rounded > 0 ? "text-success" : rounded < 0 ? "text-error" : "";
  return (
    <p className={`text-xs tabular-nums ${tone}`}>
      {rounded > 0 ? "▲" : rounded < 0 ? "▼" : ""} {Math.abs(rounded)}%
    </p>
  );
}

/** Legacy-shaped stat card kept for stat rows outside CardShells. */
export function StatCard({
  label, value, sub, deltaPct,
}: {
  label: string; value: string; sub?: string; deltaPct?: number;
}) {
  return (
    <div className="rounded-xl border border-base-300 bg-base-100 p-4 shadow-sm">
      <Stat
        label={label}
        value={value}
        sub={
          deltaPct !== undefined ? (
            <PercentDelta pct={deltaPct} />
          ) : sub ? (
            <p className="text-xs text-base-content/60">{sub}</p>
          ) : undefined
        }
      />
    </div>
  );
}

export type ChipColor =
  | "slate" | "rose" | "amber" | "lime" | "emerald" | "sky" | "violet" | "fuchsia";

export function TagChip({ color, children }: { color: ChipColor; children: React.ReactNode }) {
  return <span className={`tag-chip tag-chip-${color}`}>{children}</span>;
}

const CHIP_COLOR: Record<EvidenceChip["kind"], ChipColor> = {
  gsc: "sky",
  volume: "slate",
  gap: "violet",
  serp: "amber",
  pool: "lime",
  cluster: "slate",
  decay: "rose",
};

export function EvidenceChips({ evidence }: { evidence: EvidenceChip[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {evidence.map((e, i) => (
        <TagChip key={i} color={CHIP_COLOR[e.kind]}>{e.label}</TagChip>
      ))}
    </div>
  );
}

export const TYPE_LABEL: Record<ProposalType, { label: string; color: ChipColor }> = {
  write_new: { label: "write", color: "emerald" },
  retitle: { label: "retitle", color: "sky" },
  refresh: { label: "refresh", color: "amber" },
  push: { label: "push", color: "violet" },
  merge: { label: "merge", color: "rose" },
};

export function TypeBadge({ type }: { type: ProposalType }) {
  const t = TYPE_LABEL[type];
  return <TagChip color={t.color}>{t.label}</TagChip>;
}

/** OpenSEO's KD tier mapping (keywords/utils.ts), verbatim. */
export function scoreTierClass(value: number | null): string {
  if (value == null) return "score-tier-na";
  if (value <= 20) return "score-tier-1";
  if (value <= 35) return "score-tier-2";
  if (value <= 50) return "score-tier-3";
  if (value <= 65) return "score-tier-4";
  if (value <= 80) return "score-tier-5";
  return "score-tier-6";
}

/** Keyword difficulty badge in OpenSEO's tier colors. */
export function KdBadge({ value }: { value: number | null }) {
  return (
    <span className={`score-badge ${scoreTierClass(value)}`}>
      {value == null ? "—" : value}
    </span>
  );
}

/** Opportunity score: plain tabular number, weight by magnitude (scores are
 * ours, not OpenSEO's — but keep the same quiet numeric styling). */
export function ScoreBadge({ score }: { score: number }) {
  const cls = score >= 4 ? "font-semibold" : score >= 2.5 ? "font-medium" : "text-base-content/60";
  return <span className={`text-sm tabular-nums ${cls}`}>{score.toFixed(2)}</span>;
}

/** The explainability contract, rendered: every score shows its factors. */
export function ScoreBreakdown({ factors }: { factors: ScoreFactor[] }) {
  return (
    <div className="space-y-1 text-xs">
      {factors.map((f) => (
        <div key={f.name} className="flex items-baseline justify-between gap-4">
          <span className="tabular-nums text-base-content/80">
            {f.name === "base" ? "base" : "×"} {f.value.toFixed(2)} {f.name === "base" ? "" : f.name}
          </span>
          <span className="text-right text-base-content/50">{f.note}</span>
        </div>
      ))}
    </div>
  );
}

export function StatusDot({ ok }: { ok: boolean }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${ok ? "bg-success" : "bg-error"}`} />;
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-base-300 bg-base-100 px-5 py-10 text-center">
      <div className="text-sm font-medium text-base-content/70">{title}</div>
      {hint ? <div className="mt-1 text-sm text-base-content/50">{hint}</div> : null}
    </div>
  );
}

export const moreDetailsClass = "btn btn-ghost btn-xs";
