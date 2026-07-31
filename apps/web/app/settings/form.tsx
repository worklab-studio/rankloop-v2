"use client";

/** The interactive half of Settings. All state is local and cosmetic —
 * this is the M2 demo shell; Save writes nothing. The read-only Site and
 * laws cards arrive server-rendered via props so the island stays small;
 * the PageHeader lives here so Save can be its action. */

import { useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import type { SettingsModel, SpendEntry, TrustDial } from "@/lib/types";
import { CardShell, PageHeader, TagChip } from "@/components/ui";
import { SpendBar } from "@/components/charts";

type AdapterChoice = "wordpress" | "webhook" | "git";
type AiProvider = SettingsModel["integrations"]["aiProvider"];

const TRUST_OPTIONS: { value: TrustDial; desc: string }[] = [
  { value: "titles", desc: "Approve every title" },
  { value: "drafts", desc: "Approve every finished draft" },
  { value: "autopilot", desc: "Receipts earn autopilot" },
];

const ADAPTER_FALLBACK: Record<AdapterChoice, string> = {
  wordpress: "WordPress REST — point at your wp-json endpoint",
  webhook: "POST article JSON to your endpoint, you render it",
  git: "commit markdown to a branch, your CI deploys",
};

export default function SettingsForm({
  settings, spend, siteSection, lawsSection,
}: {
  settings: SettingsModel;
  spend: SpendEntry[];
  siteSection: ReactNode;
  lawsSection: ReactNode;
}) {
  const { integrations } = settings;

  const [trust, setTrust] = useState<TrustDial>(settings.trustDial);
  const [postsPerDay, setPostsPerDay] = useState(settings.postsPerDay);
  const [catchupCap, setCatchupCap] = useState(settings.catchupCap);
  const [adapter, setAdapter] = useState<AdapterChoice>(
    integrations.adapter === "none" ? "wordpress" : integrations.adapter,
  );
  const [aiProvider, setAiProvider] = useState<AiProvider>(integrations.aiProvider);
  const [dfsBudget, setDfsBudget] = useState(settings.budgets.dataforseoUsd);
  const [llmBudget, setLlmBudget] = useState(settings.budgets.llmUsd);
  const [showToast, setShowToast] = useState(false);

  const dfsSpent = spend.find((s) => s.provider === "dataforseo")?.monthUsd ?? 0;
  const llmSpent = spend.find((s) => s.provider === "llm")?.monthUsd ?? 0;

  const adapterDetail =
    adapter === integrations.adapter ? integrations.adapterDetail : ADAPTER_FALLBACK[adapter];
  const aiKeyReady = aiProvider === integrations.aiProvider && integrations.aiKeySet;

  function parseBudget(raw: string, fallback: number): number {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
  }

  function save() {
    setShowToast(true);
    window.setTimeout(() => setShowToast(false), 2500);
  }

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle={`${settings.site.name} — one config describes the whole site. The engine holds no opinions of its own.`}
        actions={
          <>
            <span className="text-xs text-base-content/40">demo shell — nothing is persisted</span>
            <button type="button" className="btn btn-primary btn-sm" onClick={save}>
              Save changes
            </button>
          </>
        }
      />

      {siteSection}

      {/* ── trust dial — THE control ─────────────────────────────────── */}
      <CardShell
        title="Trust dial"
        action={
          <span className="text-xs text-base-content/50">
            how much the engine may do without you
          </span>
        }
      >
        <div className="grid gap-3 sm:grid-cols-3">
          {TRUST_OPTIONS.map((o) => {
            const active = trust === o.value;
            return (
              <label
                key={o.value}
                className={`cursor-pointer rounded-lg border p-4 transition ${
                  active
                    ? "border-primary ring-1 ring-primary"
                    : "border-base-300 hover:border-base-content/25"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold capitalize">{o.value}</span>
                  <input
                    type="radio"
                    name="trust-dial"
                    className="radio radio-sm"
                    checked={active}
                    onChange={() => setTrust(o.value)}
                  />
                </div>
                <p className="mt-1 text-sm text-base-content/60">{o.desc}</p>
                {o.value === "autopilot" ? (
                  <p className="mt-2 text-xs text-base-content/45">
                    unlocks after the 90-day receipt cohort clears baseline
                  </p>
                ) : null}
              </label>
            );
          })}
        </div>
      </CardShell>

      {/* ── cadence ──────────────────────────────────────────────────── */}
      <CardShell
        title="Cadence"
        stamp={`a missed day is owed, not skipped — the backlog drains at up to ${catchupCap}/day until the quota is level again.`}
      >
        <div className="flex flex-wrap items-start gap-8">
          <NumberField
            label="posts per day"
            value={postsPerDay}
            min={1}
            max={6}
            onChange={setPostsPerDay}
            hint={`≈ ${postsPerDay * 30} posts / month`}
          />
          <NumberField
            label="catch-up cap"
            value={catchupCap}
            min={1}
            max={12}
            onChange={setCatchupCap}
            hint="max posts on any single day"
          />
        </div>
      </CardShell>

      {/* ── integrations ─────────────────────────────────────────────── */}
      <CardShell title="Integrations">
        <div className="divide-y divide-base-300">
          <IntegrationRow
            name="Google Search Console"
            hint="service account (self-host) — read-only, feeds the receipt loop"
          >
            {integrations.gscConnected ? (
              <>
                <TagChip color="emerald">connected</TagChip>
                <span className="font-mono text-xs text-base-content/70">
                  {integrations.gscProperty}
                </span>
              </>
            ) : (
              <TagChip color="slate">not set</TagChip>
            )}
          </IntegrationRow>

          <IntegrationRow name="Publish adapter" hint={adapterDetail}>
            <select
              className="select select-sm w-40"
              value={adapter}
              onChange={(e) => setAdapter(e.target.value as AdapterChoice)}
              aria-label="publish adapter"
            >
              <option value="wordpress">wordpress</option>
              <option value="webhook">webhook</option>
              <option value="git">git</option>
            </select>
          </IntegrationRow>

          <IntegrationRow
            name="DataForSEO key"
            hint="keyword volumes, SERP snapshots, competitor gaps"
          >
            {integrations.dataforseoKeySet ? (
              <>
                <TagChip color="emerald">connected</TagChip>
                <span className="font-mono text-xs text-base-content/70">dfs_••••</span>
                <TagChip color="amber">budget-capped</TagChip>
              </>
            ) : (
              <TagChip color="slate">not set</TagChip>
            )}
          </IntegrationRow>

          <IntegrationRow
            name="AI provider"
            hint="writes the drafts — the grader is never the author"
          >
            <select
              className="select select-sm w-40"
              value={aiProvider}
              onChange={(e) => setAiProvider(e.target.value as AiProvider)}
              aria-label="AI provider"
            >
              <option value="anthropic">anthropic</option>
              <option value="openai">openai</option>
              <option value="openrouter">openrouter</option>
            </select>
            {aiKeyReady ? (
              <>
                <TagChip color="emerald">connected</TagChip>
                <span className="font-mono text-xs text-base-content/70">sk-••••</span>
              </>
            ) : (
              <TagChip color="slate">not set</TagChip>
            )}
          </IntegrationRow>
        </div>
      </CardShell>

      {/* ── budgets ──────────────────────────────────────────────────── */}
      <CardShell
        title="Budgets"
        stamp="hard caps — spend stops at the line, it never overdrafts."
      >
        <div className="grid gap-6 sm:grid-cols-2">
          <BudgetField
            label="DataForSEO / month"
            value={dfsBudget}
            onChange={(raw) => setDfsBudget(parseBudget(raw, dfsBudget))}
          >
            <SpendBar label="spent this month" spent={dfsSpent} budget={Math.max(1, dfsBudget)} />
          </BudgetField>
          <BudgetField
            label="LLM / month"
            value={llmBudget}
            onChange={(raw) => setLlmBudget(parseBudget(raw, llmBudget))}
          >
            <SpendBar label="spent this month" spent={llmSpent} budget={Math.max(1, llmBudget)} />
          </BudgetField>
        </div>
      </CardShell>

      {/* laws table (server-rendered, read-only) */}
      {lawsSection}

      {showToast ? (
        <div className="toast toast-end z-50">
          <div className="alert alert-success">
            <Check className="h-4 w-4" />
            <span>Saved (demo)</span>
          </div>
        </div>
      ) : null}
    </>
  );
}

/* ── little pieces ─────────────────────────────────────────────────── */

function NumberField({
  label, value, min, max, onChange, hint,
}: {
  label: string; value: number; min: number; max: number;
  onChange: (v: number) => void; hint?: string;
}) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-base-content/50">
        {label}
      </div>
      <input
        type="number"
        className="input input-sm w-24 tabular-nums"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, Math.round(n))));
        }}
        aria-label={label}
      />
      {hint ? <div className="mt-1 text-xs text-base-content/50">{hint}</div> : null}
    </div>
  );
}

function IntegrationRow({
  name, hint, children,
}: {
  name: string; hint: string; children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3.5 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="text-sm font-medium">{name}</div>
        <div className="mt-0.5 text-xs text-base-content/50">{hint}</div>
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function BudgetField({
  label, value, onChange, children,
}: {
  label: string; value: number; onChange: (raw: string) => void; children: ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-base-content/50">
          {label}
        </div>
        <label className="input input-sm flex w-44 items-center gap-1">
          <span className="text-base-content/50">$</span>
          <input
            type="number"
            min={0}
            className="grow tabular-nums"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-label={label}
          />
          <span className="whitespace-nowrap text-xs text-base-content/40">/ mo</span>
        </label>
      </div>
      {children}
    </div>
  );
}
