import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Check } from "lucide-react";
import { captureClientEvent } from "@/client/lib/posthog";
import {
  computeNextStep,
  isStepDone,
  STEP_ORDER,
} from "@/client/features/dashboard/dashboardSteps";
import {
  AuditHealthCard,
  GscCard,
} from "@/client/features/dashboard/DashboardCards";
import { ContentInventoryCard } from "@/client/features/dashboard/ContentInventoryCard";
import { DigestCard } from "@/client/features/dashboard/DigestCard";
import { IndexationCard } from "@/client/features/dashboard/IndexationCard";
import { RankloopNeedsYou } from "@/client/features/rankloop-pipeline/RankloopNeedsYou";
import { RankloopSpine } from "@/client/features/rankloop-pipeline/RankloopSpine";
import { useSiteStudyPolling } from "@/client/features/dashboard/useSiteStudyPolling";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import type { DashboardActivation } from "@/server/features/dashboard/services/DashboardService";
import {
  getDashboardActivation,
  getDashboardOverview,
  markDashboardCompetitorClicked,
  refreshDashboardBacklinkSnapshot,
} from "@/serverFunctions/dashboard";
import { setProjectDomain } from "@/serverFunctions/projects";
import type { DashboardHeroStep } from "@/types/schemas/dashboard";

const HERO_COPY: Record<
  DashboardHeroStep,
  { title: string; body: string; cta: string }
> = {
  domain: {
    title: "What site are you working on?",
    body: "Set your project's domain and every card on this page starts working for it — backlinks and audits.",
    cta: "Save",
  },
  mcp: {
    title: "Connect your AI agent",
    body: "rankloop is built to be used from agents like Claude. Connect once, then ask it to use rankloop to help build your SEO strategy.",
    cta: "Show me how",
  },
  gsc: {
    title: "Connect Search Console",
    body: "Your real queries and clicks, straight from Google.",
    cta: "Connect",
  },
  competitor: {
    title: "Size up a competitor",
    body: "Paste a competitor's domain to see what they rank for and who links to them.",
    cta: "Open domain lookup",
  },
};

function scrollToCard(id: string) {
  document.getElementById(id)?.scrollIntoView({
    behavior: "smooth",
    block: "center",
  });
}

// Users paste full URLs; store the bare host like settings expects.
function normalizeDomainInput(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "");
}

function OnboardingChecklist({
  projectId,
  activation,
}: {
  projectId: string;
  activation: DashboardActivation;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [domainInput, setDomainInput] = useState("");
  // null = follow the first actionable step; set once the user pages with ‹ ›.
  const [viewedIndex, setViewedIndex] = useState<number | null>(null);
  const invalidateActivation = () =>
    void queryClient.invalidateQueries({
      queryKey: ["dashboardActivation", projectId],
    });

  const competitorClickMutation = useMutation({
    mutationFn: () => markDashboardCompetitorClicked({ data: { projectId } }),
    onSuccess: invalidateActivation,
  });
  const domainMutation = useMutation({
    mutationFn: (domain: string) =>
      setProjectDomain({ data: { projectId, domain } }),
    onSuccess: () => {
      invalidateActivation();
      void queryClient.invalidateQueries({
        queryKey: ["dashboardOverview", projectId],
      });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (error) =>
      toast.error(
        getStandardErrorMessage(error, "Couldn't save the domain. Try again."),
      ),
  });

  // Hidden once every step is done.
  const nextStep = computeNextStep(activation);
  if (!nextStep) return null;

  const index = viewedIndex ?? STEP_ORDER.indexOf(nextStep);
  const step = STEP_ORDER[index];
  const copy = HERO_COPY[step];
  const done = isStepDone(activation, step);

  const page = (delta: number) =>
    setViewedIndex(Math.min(Math.max(index + delta, 0), STEP_ORDER.length - 1));

  const onSubmitDomain = () => {
    const domain = normalizeDomainInput(domainInput);
    if (!domain) return;
    captureClientEvent("dashboard:next_move_click", { step: "domain" });
    domainMutation.mutate(domain);
  };

  // Only the gsc/competitor steps use the fallback CTA button — domain
  // renders an inline form and mcp renders a Link.
  const onCta = () => {
    captureClientEvent("dashboard:next_move_click", { step });
    if (step === "gsc") {
      scrollToCard("connect-gsc");
    } else if (step === "competitor") {
      competitorClickMutation.mutate();
      void navigate({ to: "/p/$projectId/domain", params: { projectId } });
    }
  };

  return (
    <div className="rounded-xl border border-primary/25 bg-primary/5 shadow-sm">
      <div className="flex items-center justify-between gap-4 px-5 pt-4">
        <p className="text-xs font-medium uppercase tracking-wide text-primary">
          Onboarding checklist
        </p>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={`btn btn-ghost btn-xs btn-square ${
              index === 0 ? "invisible" : ""
            }`}
            aria-label="Previous step"
            disabled={index === 0}
            onClick={() => page(-1)}
          >
            <ChevronLeft className="size-4" />
          </button>
          <span className="text-xs tabular-nums text-base-content/60">
            {index + 1} / {STEP_ORDER.length}
          </span>
          <button
            type="button"
            className={`btn btn-ghost btn-xs btn-square ${
              index === STEP_ORDER.length - 1 ? "invisible" : ""
            }`}
            aria-label="Next step"
            disabled={index === STEP_ORDER.length - 1}
            onClick={() => page(1)}
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>
      <div className="flex flex-row flex-wrap items-center justify-between gap-4 p-5 pt-2">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{copy.title}</h2>
          <p className="mt-1 max-w-xl text-sm text-base-content/70">
            {copy.body}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          {done ? (
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-success">
              <Check className="size-4" />
              Done
            </span>
          ) : step === "domain" ? (
            <form
              className="join"
              onSubmit={(event) => {
                event.preventDefault();
                onSubmitDomain();
              }}
            >
              <input
                type="text"
                className="input input-bordered join-item w-52"
                placeholder="acme.com"
                value={domainInput}
                onChange={(event) => setDomainInput(event.target.value)}
                aria-label="Your site's domain"
              />
              <button
                type="submit"
                className="btn btn-primary join-item"
                disabled={
                  domainMutation.isPending ||
                  normalizeDomainInput(domainInput) === ""
                }
              >
                {copy.cta}
              </button>
            </form>
          ) : step === "mcp" ? (
            <Link
              to="/ai"
              className="link link-primary text-sm font-medium"
              onClick={() =>
                captureClientEvent("dashboard:next_move_click", { step })
              }
            >
              {copy.cta} →
            </Link>
          ) : (
            <button type="button" className="btn btn-primary" onClick={onCta}>
              {copy.cta}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function DashboardPage({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();

  const activationQuery = useQuery({
    queryKey: ["dashboardActivation", projectId],
    queryFn: () => getDashboardActivation({ data: { projectId } }),
  });
  const overviewQuery = useQuery({
    queryKey: ["dashboardOverview", projectId],
    queryFn: () => getDashboardOverview({ data: { projectId } }),
  });
  const study = useSiteStudyPolling(projectId);
  // Deduped with the app shell's identical query — this only feeds the

  const activation = activationQuery.data;
  const overview = overviewQuery.data;

  // Visit-triggered backlink snapshot: fire once per page view when the
  // overview reports a missing or stale snapshot for a project with a domain.
  // The server re-checks freshness, so a stray double-fire costs nothing.
  const refreshMutation = useMutation({
    mutationFn: () => refreshDashboardBacklinkSnapshot({ data: { projectId } }),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: ["dashboardOverview", projectId],
      }),
  });
  const refreshFiredRef = useRef(false);
  const needsSnapshot =
    activation?.domain != null &&
    overview !== undefined &&
    (overview.backlinks === null || overview.backlinks.stale);
  useEffect(() => {
    if (!needsSnapshot || refreshFiredRef.current) return;
    refreshFiredRef.current = true;
    refreshMutation.mutate();
  }, [needsSnapshot, refreshMutation]);

  if (activationQuery.isError) {
    return (
      <div className="px-4 py-4 md:px-6 md:py-6">
        <div className="alert alert-error">
          {getStandardErrorMessage(activationQuery.error)}
        </div>
      </div>
    );
  }

  // Wait for the overview too: rendering cards from `overview === undefined`
  // flashes their empty states (and reshuffles the data-first sort) once the
  // real data lands. An overview error falls through so the page still loads.
  if (!activation || overviewQuery.isPending) {
    return (
      <div
        className="mx-auto flex max-w-5xl flex-col gap-5 px-4 py-4 md:px-6 md:py-6"
        aria-busy
      >
        <div className="skeleton h-8 w-52" />
        <div className="skeleton h-36" />
        <div className="skeleton h-40" />
        <div className="skeleton h-32" />
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="skeleton h-44" />
          <div className="skeleton h-44" />
          <div className="skeleton h-44" />
          <div className="skeleton h-44" />
        </div>
      </div>
    );
  }

  const gscConnected = activation.gsc.connected;

  return (
    <div className="px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        <h1 className="text-2xl font-semibold">Today</h1>

        <OnboardingChecklist projectId={projectId} activation={activation} />

        {/* Decisions first, then state. The queue is populated only by
          stages that genuinely need a human, so it is usually two rows or
          absent entirely — everything else rankloop is getting to. */}
        <RankloopNeedsYou projectId={projectId} />

        <RankloopSpine projectId={projectId} />

        {/* Full width, and above the grid: the digest is the one card someone
          is meant to read top to bottom every morning, and its rows are
          sentences rather than a stat. */}
        <DigestCard projectId={projectId} />

        {/* Every card below is half width on large screens (the checklist, the
          progress spine and the digest are the three that span). Cards with
          data render before setup pitches and empty states. */}
        <div className="grid items-start gap-5 lg:grid-cols-2">
          {[
            // The MCP pitch used to lead this grid, which put "Connect your
            // AI agent" on screen twice — once as onboarding checklist step
            // 2/4 and again as its own card, a few hundred pixels apart. The
            // checklist keeps it; it is a setup step, and the checklist is
            // where setup steps live.
            {
              key: "gsc",
              hasData: gscConnected,
              node: <GscCard projectId={projectId} connected={gscConnected} />,
            },
            {
              key: "audit",
              hasData: overview?.audit != null,
              node: (
                <AuditHealthCard
                  projectId={projectId}
                  audit={overview?.audit ?? null}
                />
              ),
            },
            {
              key: "inventory",
              hasData: study?.inventory != null,
              node: (
                <ContentInventoryCard projectId={projectId} study={study} />
              ),
            },
            {
              key: "indexation",
              // The checks only ever run against a connected property, so the
              // GSC flag is what decides the bucket: without one this card is
              // a "connect Search Console" restatement and belongs below the
              // cards that have numbers.
              hasData: gscConnected,
              node: <IndexationCard projectId={projectId} />,
            },
            // Reach (backlinks, referring domains, domain rank) lives on
            // Study now. It used to appear here twice — as "Backlink pulse"
            // and again as "Authority" — with the same two numbers in both.
          ]
            .toSorted((a, b) => Number(b.hasData) - Number(a.hasData))
            .map((card) => (
              <div key={card.key}>{card.node}</div>
            ))}
        </div>
      </div>
    </div>
  );
}
