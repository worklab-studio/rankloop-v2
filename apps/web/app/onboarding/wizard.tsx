"use client";

/** The onboarding wizard — Domain → Study → Plan → Connect. All state is
 * local and cosmetic: the demo streams the mock study log, shows the plan
 * the engine would propose, and flips connect rows optimistically.
 *
 * Returns a fragment: every stage section is a CardShell placed directly
 * in the layout's gap-5 column. The study stream stays a deliberately dark
 * terminal block inside light chrome (the OpenSEO code-block idiom). */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, Globe, Rocket, ScanSearch } from "lucide-react";
import { onboardingPlan, onboardingScript, settings, site } from "@/lib/mock";
import type { OnboardingLine } from "@/lib/types";
import { CardShell, StatusDot, TagChip } from "@/components/ui";

const STEPS = ["Domain", "Study", "Plan", "Connect"] as const;

const LINE_STYLE: Record<OnboardingLine["kind"], { prefix: string; cls: string }> = {
  finding: { prefix: "✓", cls: "text-success" },
  metric: { prefix: "▸", cls: "text-info" },
  warn: { prefix: "!", cls: "text-warning" },
  info: { prefix: "·", cls: "text-neutral-content/80" },
};

interface ConnectRow {
  id: string;
  label: string;
  detail: string;
  required: boolean;
  connected: boolean;
  /** label for the cosmetic connect button when not yet connected */
  action: string;
}

export function Wizard() {
  const [step, setStep] = useState(0);
  const [domain, setDomain] = useState(`https://${site.domain}`);

  // ── study stream ──────────────────────────────────────────────────────
  const [visible, setVisible] = useState(0);
  const streaming = step === 1 && visible < onboardingScript.length;
  const studyDone = visible >= onboardingScript.length;
  const termRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (step !== 1) return;
    const id = window.setInterval(() => {
      setVisible((v) => Math.min(v + 1, onboardingScript.length));
    }, 450);
    return () => window.clearInterval(id);
  }, [step]);

  // keep the terminal pinned to the newest line
  useEffect(() => {
    const el = termRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible]);

  // auto-advance to the plan once the study finishes
  useEffect(() => {
    if (step !== 1 || !studyDone) return;
    const t = window.setTimeout(() => setStep(2), 1100);
    return () => window.clearTimeout(t);
  }, [step, studyDone]);

  // ── toast ─────────────────────────────────────────────────────────────
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  }
  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
  }, []);

  // ── connect checklist (seeded from the study's findings) ──────────────
  const [rows, setRows] = useState<ConnectRow[]>([
    {
      id: "gsc",
      label: "Search Console service account",
      detail: `read-only · ${settings.integrations.gscProperty}`,
      required: true,
      connected: settings.integrations.gscConnected,
      action: "Connect GSC",
    },
    {
      id: "adapter",
      label: "Publish adapter",
      detail: `WordPress REST detected at ${site.domain}/wp-json — confirm to publish drafts`,
      required: true,
      connected: false, // the study warned: adapter needs your choice
      action: "Use WordPress REST",
    },
    {
      id: "ai",
      label: `AI key (${settings.integrations.aiProvider})`,
      detail: "writes drafts · never grades its own work",
      required: true,
      connected: settings.integrations.aiKeySet,
      action: "Add key",
    },
    {
      id: "dataforseo",
      label: "DataForSEO key",
      detail: "unlocks volume, KD and competitor gap · budget-capped",
      required: false,
      connected: settings.integrations.dataforseoKeySet,
      action: "Add key",
    },
  ]);
  const [started, setStarted] = useState(false);
  const requiredMissing = rows.filter((r) => r.required && !r.connected).length;

  function connectRow(id: string, label: string) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, connected: true } : r)));
    showToast(`${label} connected`);
  }

  function startStudy() {
    setVisible(0);
    setStep(1);
  }

  return (
    <>
      {/* stepper — neutral steps, primary only for done/current */}
      <ul className="steps w-full">
        {STEPS.map((label, i) => (
          <li
            key={label}
            className={`step text-xs ${i <= step ? "step-primary" : ""}`}
            data-content={i < step ? "✓" : String(i + 1)}
          >
            {label}
          </li>
        ))}
      </ul>

      {/* ── step 1 · domain ─────────────────────────────────────────── */}
      {step === 0 ? (
        <CardShell
          title="Domain"
          stamp="takes about a minute · read-only until you say otherwise"
        >
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <Globe className="h-8 w-8 text-primary" />
            <h3 className="text-xl font-semibold">Which site should rankloop study?</h3>
            <p className="max-w-md text-sm text-base-content/60">
              It reads your pages, your Search Console footprint and your competitors —
              then proposes a plan. Nothing is written until you approve.
            </p>
            <form
              className="mt-2 flex w-full max-w-xl flex-col items-center gap-3 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                if (domain.trim()) startStudy();
              }}
            >
              <input
                type="url"
                required
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="https://yourdomain.com"
                className="input input-bordered w-full font-mono"
                aria-label="Site URL"
              />
              <button
                type="submit"
                className="btn btn-primary whitespace-nowrap"
                disabled={!domain.trim()}
              >
                <ScanSearch className="h-4 w-4" />
                Study my site
              </button>
            </form>
          </div>
        </CardShell>
      ) : null}

      {/* ── step 2 · study stream ───────────────────────────────────── */}
      {step === 1 ? (
        <CardShell
          title={`Studying ${domain.replace(/^https?:\/\//, "")}`}
          action={
            <div className="flex items-center gap-3">
              <span className="font-mono text-xs text-base-content/50">
                {visible}/{onboardingScript.length}
              </span>
              {streaming ? (
                <button
                  className="btn btn-ghost btn-xs"
                  onClick={() => setVisible(onboardingScript.length)}
                >
                  skip ahead
                </button>
              ) : (
                <span className="badge badge-ghost badge-sm gap-1">
                  <Check className="h-3 w-3 text-success" /> study complete
                </span>
              )}
            </div>
          }
        >
          <progress
            className="progress progress-primary h-1 w-full"
            value={visible}
            max={onboardingScript.length}
          />
          {/* deliberate dark terminal inside light chrome — the study log
           * reads as machine output, not page content */}
          <div
            ref={termRef}
            className="mt-3 max-h-96 overflow-y-auto rounded-lg bg-neutral p-4 font-mono text-sm text-neutral-content"
          >
            {onboardingScript.slice(0, visible).map((line, i) => {
              const s = LINE_STYLE[line.kind];
              return (
                <div key={i} className={`flex gap-2 py-0.5 ${s.cls}`}>
                  <span className="w-3 shrink-0 select-none text-center">{s.prefix}</span>
                  <span className="min-w-0">{line.text}</span>
                </div>
              );
            })}
            {streaming ? (
              <div className="flex gap-2 py-0.5">
                <span className="w-3 shrink-0" />
                <span className="animate-pulse">▌</span>
              </div>
            ) : (
              <div className="flex gap-2 py-0.5 text-success">
                <span className="w-3 shrink-0 select-none text-center">✓</span>
                <span>study complete — drafting your plan ...</span>
              </div>
            )}
          </div>
        </CardShell>
      ) : null}

      {/* ── step 3 · proposed plan ──────────────────────────────────── */}
      {step === 2 ? (
        <>
          <p className="text-sm text-base-content/60">
            Here is the plan the study produced. Everything below is editable later —
            approving it only sets defaults, it publishes nothing.
          </p>

          <div className="grid items-start gap-5 lg:grid-cols-2">
            <CardShell
              title="Voice"
              stamp="learned from your existing posts — every draft is graded against it"
            >
              <ul className="space-y-2 text-sm">
                {onboardingPlan.voiceCard.map((rule, i) => (
                  <li key={i} className="flex gap-2">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                    <span>{rule}</span>
                  </li>
                ))}
              </ul>
            </CardShell>

            <CardShell
              title="Laws calibration"
              stamp="calibrated so all 34 existing posts pass — the grader is never the author"
            >
              <div className="overflow-x-auto">
                <table className="table table-sm">
                  <thead>
                    <tr>
                      <th>law</th>
                      <th>value</th>
                      <th>calibrated from</th>
                    </tr>
                  </thead>
                  <tbody>
                    {onboardingPlan.laws.map((law) => (
                      <tr key={law.name}>
                        <td className="font-mono text-xs">{law.name}</td>
                        <td className="font-medium tabular-nums">{law.value}</td>
                        <td className="text-base-content/60">{law.calibratedFrom}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardShell>
          </div>

          <CardShell
            title="Taxonomy"
            stamp="four hubs, mapped from what the site already publishes"
          >
            <div className="overflow-x-auto">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>category</th>
                    <th>hub</th>
                    <th>note</th>
                  </tr>
                </thead>
                <tbody>
                  {onboardingPlan.taxonomy.map((t) => (
                    <tr key={t.category}>
                      <td className="font-medium">{t.category}</td>
                      <td className="font-mono text-xs">/{t.hub}/</td>
                      <td className="text-base-content/60">{t.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardShell>

          <CardShell
            title="Seed clusters"
            stamp="where the first proposals will come from"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              {onboardingPlan.clusters.map((c) => (
                <div key={c.name} className="rounded-lg border border-base-300 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{c.name}</span>
                    <TagChip color="lime">{c.seedCount} seeds</TagChip>
                  </div>
                  <p className="mt-1 text-xs text-base-content/60">{c.note}</p>
                </div>
              ))}
            </div>
          </CardShell>

          <CardShell
            title="Cadence"
            action={
              <Link href="/settings" className="btn btn-ghost btn-xs">
                Edit later in Settings
              </Link>
            }
          >
            <div className="flex flex-wrap items-center justify-between gap-4">
              <p className="text-sm text-base-content/70">{onboardingPlan.cadence}</p>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => {
                  setStep(3);
                  showToast("plan approved — nothing publishes yet");
                }}
              >
                Approve plan
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </CardShell>
        </>
      ) : null}

      {/* ── step 4 · connect ────────────────────────────────────────── */}
      {step === 3 ? (
        <>
          <CardShell
            title="Connect the pipes"
            stamp="three required, one optional — the study pre-connected what it could"
          >
            <ul className="divide-y divide-base-300">
              {rows.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center gap-4 py-3 first:pt-0 last:pb-0"
                >
                  <div className="w-28 shrink-0">
                    {r.connected ? (
                      <TagChip color="emerald">connected</TagChip>
                    ) : (
                      <TagChip color="amber">action needed</TagChip>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {r.label}
                      {!r.required ? <TagChip color="slate">optional</TagChip> : null}
                    </div>
                    <div className="truncate text-xs text-base-content/50">{r.detail}</div>
                  </div>
                  {!r.connected ? (
                    <button
                      className="btn btn-sm"
                      onClick={() => connectRow(r.id, r.label)}
                    >
                      {r.action}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </CardShell>

          {started ? (
            <CardShell title="The engine is running">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-2 text-sm text-base-content/70">
                  <StatusDot ok />
                  <span>
                    First proposals land on the Overview within a few minutes — every one
                    shows its evidence before you approve it.
                  </span>
                </div>
                <Link href="/" className="btn btn-primary btn-sm">
                  Go to Overview
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </CardShell>
          ) : (
            <CardShell title="Launch">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <p className="text-sm text-base-content/60">
                  {requiredMissing === 0
                    ? `Ready: ${site.name} · ${onboardingPlan.cadence.split(" · ")[0]} · trust dial starts at "titles"`
                    : `${requiredMissing} required connection${requiredMissing === 1 ? "" : "s"} left before launch`}
                </p>
                <button
                  className="btn btn-primary"
                  disabled={requiredMissing > 0}
                  onClick={() => {
                    setStarted(true);
                    showToast("engine started — quota owed today: 2");
                  }}
                >
                  <Rocket className="h-4 w-4" />
                  Start the engine
                </button>
              </div>
            </CardShell>
          )}
        </>
      ) : null}

      {/* toast — fixed, so it never disturbs the gap-5 column */}
      {toast ? (
        <div className="toast toast-end z-50">
          <div className="flex items-center gap-2 rounded-xl border border-base-300 bg-base-100 px-4 py-3 shadow-lg">
            <Check className="h-4 w-4 text-success" />
            <span className="text-sm">{toast}</span>
          </div>
        </div>
      ) : null}
    </>
  );
}
