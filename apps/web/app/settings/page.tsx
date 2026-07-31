import { CardShell, EmptyState, TagChip } from "@/components/ui";
import { settings, spend } from "@/lib/mock";
import SettingsForm from "./form";

/** Settings — the whole site is one config object (the rankloop.toml
 * equivalent). Read-only facts render on the server; everything the user
 * can turn lives in the SettingsForm client island, which also owns the
 * PageHeader so Save can sit in the header action slot. */
export default function SettingsPage() {
  return (
    <SettingsForm
      settings={settings}
      spend={spend}
      siteSection={<SiteCard />}
      lawsSection={<LawsCard />}
    />
  );
}

function SiteCard() {
  const { name, url, mode, blogPath } = settings.site;
  const taxonomy = Object.entries(settings.taxonomy);

  return (
    <CardShell title="Site">
      <div className="overflow-x-auto">
        <table className="table table-sm">
          <tbody>
            <SiteRow label="name">
              <span className="font-medium">{name}</span>
            </SiteRow>
            <SiteRow label="url">
              <span className="font-mono text-xs text-base-content/70">{url}</span>
            </SiteRow>
            <SiteRow label="mode">
              <span className="flex flex-wrap items-center gap-2">
                <TagChip color="slate">{mode}</TagChip>
                <span className="text-xs text-base-content/50">
                  {mode === "html" ? "JSON-LD + schema laws" : "frontmatter laws"}
                </span>
              </span>
            </SiteRow>
            <SiteRow label="blog path">
              <span className="font-mono text-xs text-base-content/70">/{blogPath}/</span>
            </SiteRow>
            <SiteRow label="taxonomy">
              {taxonomy.length ? (
                <span className="flex flex-wrap gap-1">
                  {taxonomy.map(([category, hub]) => (
                    <TagChip key={category} color="slate">
                      {category} → /{hub}
                    </TagChip>
                  ))}
                </span>
              ) : (
                <span className="text-base-content/50">
                  no categories yet — onboarding proposes a taxonomy from your existing posts
                </span>
              )}
            </SiteRow>
          </tbody>
        </table>
      </div>
    </CardShell>
  );
}

function SiteRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <tr>
      <td className="w-36 align-top text-xs font-medium uppercase tracking-wide text-base-content/50">
        {label}
      </td>
      <td className="text-sm">{children}</td>
    </tr>
  );
}

/** Read-only: laws are calibrated by onboarding, not hand-tuned in a UI. */
function LawsCard() {
  return (
    <CardShell
      title="The laws"
      action={<span className="badge badge-ghost badge-sm">read-only</span>}
      stamp="calibrated so your existing corpus passes — every current post already clears the bar. Edit in the rankloop.toml equivalent (M3)."
    >
      {settings.laws.length ? (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>law</th>
                <th>value</th>
              </tr>
            </thead>
            <tbody>
              {settings.laws.map((law) => (
                <tr key={law.name}>
                  <td className="font-medium">{law.name}</td>
                  <td className="font-mono text-xs tabular-nums">{law.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title="No laws configured"
          hint="run onboarding — laws are calibrated from your existing corpus"
        />
      )}
    </CardShell>
  );
}
