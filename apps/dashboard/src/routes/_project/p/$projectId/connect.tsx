import { createFileRoute } from "@tanstack/react-router";
import { RankloopAutomationSettings } from "@/client/features/rankloop-automation/RankloopAutomationSettings";
import { RankloopThemePanel } from "@/client/features/rankloop-theme/RankloopThemePanel";
import { RankloopPublishingSettings } from "@/client/features/rankloop-articles/RankloopPublishingSettings";
import { RankloopWriterSettings } from "@/client/features/rankloop-articles/RankloopWriterSettings";
import { SearchConsoleConnectionCard } from "@/client/features/gsc/SearchConsoleConnectionCard";

export const Route = createFileRoute("/_project/p/$projectId/connect")({
  component: ConnectPage,
});

// Everything rankloop plugs into, in one place (spec 0028).
//
// Ordered by what a new project needs first, not by what is technically
// related: where posts go, then what rankloop is allowed to see, then how
// much it may do unattended. Project name and the archive control stay on
// Settings — this page is about connections, and mixing "delete my project"
// into it would be a trap.
function ConnectPage() {
  const { projectId } = Route.useParams();
  return (
    <div className="overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-4xl space-y-8">
        <div>
          <h1 className="text-2xl font-semibold">Connect</h1>
          <p className="text-sm text-base-content/70">
            Where posts go, what rankloop can see, and how much it may do on
            its own.
          </p>
        </div>

        <Section
          title="Publishing"
          detail="Where an approved article ends up. Copy-paste always works, with no setup — everything else is a shortcut."
        >
          <RankloopPublishingSettings projectId={projectId} />
        </Section>

        <Section
          title="Data"
          detail="Search Console is what lets rankloop see your real queries. Without it, it can still study your site and plan, but it is guessing at demand instead of reading it."
        >
          <SearchConsoleConnectionCard projectId={projectId} />
        </Section>

        <Section
          title="Writing"
          detail="Which model writes, in whose voice, and how many posts a day. The laws that decide whether a draft ships are not part of this — they never come from the writer."
        >
          <RankloopWriterSettings projectId={projectId} />
        </Section>

        <Section
          title="Design"
          detail="What your blog will look like, read from your own site. rankloop can also open a pull request that puts the blog in your repo, in your framework, styled with these tokens."
        >
          <RankloopThemePanel projectId={projectId} />
        </Section>

        <Section
          title="Automation"
          detail="How much rankloop may do unattended. Autonomy is earned per action type from measured results, never granted up front."
        >
          <RankloopAutomationSettings projectId={projectId} />
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-base-content/60">{detail}</p>
      </div>
      {children}
    </section>
  );
}
