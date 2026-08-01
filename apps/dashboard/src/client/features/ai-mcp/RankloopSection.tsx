import { CodeBlock } from "@/client/features/ai-mcp/SetupControls";

// The `rankloop` skill is rankloop's own; it does not exist in upstream's
// repo, so this install pointed at a skill that was never there.
const SKILL_INSTALL = `npx skills add worklab-studio/rankloop-v2 --skill rankloop`;
const REPO_KIT_INIT = `npx rankloop init`;

// The six tools an agent needs to run the loop, in the order it calls them.
// One line each: the skill teaches the routine, this list only has to make the
// division of labour obvious at a glance.
const RANKLOOP_TOOLS: { name: string; description: string }[] = [
  {
    name: "rankloop_status",
    description:
      "Today's quota, any indexation throttle and its reason, counts by status, spend to date.",
  },
  {
    name: "rankloop_proposals",
    description:
      "Approved proposals waiting to be written, with their evidence and page type.",
  },
  {
    name: "rankloop_brief",
    description:
      "The grounded brief for one proposal — the same brief this dashboard renders.",
  },
  {
    name: "rankloop_check",
    description:
      "Submit a draft, get the law report back as data: every law, pass or fail, with thresholds and excerpts. No model call.",
  },
  {
    name: "rankloop_publish_report",
    description:
      "Report what shipped — url, path, commit or PR. The article goes published and the receipt opens.",
  },
  {
    name: "rankloop_receipts",
    description:
      "Measured receipts, so the agent can see what its writing moved.",
  },
];

// What `rankloop init` leaves behind. Printed here as well as by the CLI
// because the two files in the middle are the ones a user has to know exist:
// they hold the voice and the shape of a post, and they are meant to be
// edited by hand.
const SCAFFOLDED: { path: string; description: string }[] = [
  {
    path: "rankloop.json",
    description: "Content directory, blog path, taxonomy, law overrides.",
  },
  {
    path: "rankloop/writer-prompt.md",
    description: "Your voice card and the verified-facts contract.",
  },
  {
    path: "rankloop/post-template.md",
    description: "The structure a post follows in this repo.",
  },
  {
    path: ".github/workflows/rankloop-check.yml",
    description: "The publish laws as a CI status check on every PR.",
  },
];

export function RankloopSection() {
  return (
    <section className="mt-12">
      <h2 className="text-base font-semibold">rankloop for your own agent</h2>
      <p className="mt-1.5 text-sm text-base-content/70 leading-relaxed">
        rankloop holds the judgment. Your agent holds the hands. Your source
        never leaves your machine &mdash; briefs and law verdicts cross the
        wire, nothing else. Your agent pulls the approved queue, writes the page
        natively in your repo, and reports what it shipped.
      </p>

      <div className="mt-5">
        <p className="text-xs font-medium uppercase tracking-wide text-base-content/50">
          rankloop tools
        </p>
        <ul className="mt-3 grid gap-x-8 gap-y-3 md:grid-cols-2">
          {RANKLOOP_TOOLS.map((tool) => (
            <li key={tool.name} className="flex flex-col gap-0.5">
              <span className="font-mono text-sm text-base-content">
                {tool.name}
              </span>
              <p className="text-xs text-base-content/60 leading-relaxed">
                {tool.description}
              </p>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-6">
        <p className="text-sm font-medium">Install the skill</p>
        <p className="mt-1 text-sm text-base-content/70 leading-relaxed">
          It teaches the routine, not the API: pull the approved proposals,
          fetch each brief, write in this repo&rsquo;s stack, call{" "}
          <span className="font-mono text-base-content">rankloop_check</span>{" "}
          until it passes, open a PR, report it. On first contact it studies the
          repo and writes your voice card and post template into it.
        </p>
        <div className="mt-3">
          <CodeBlock code={SKILL_INSTALL} />
        </div>
      </div>

      <div className="mt-6">
        <p className="text-sm font-medium">Set up the repo</p>
        <div className="mt-3">
          <CodeBlock code={REPO_KIT_INIT} />
        </div>
        <p className="mt-2 text-xs text-base-content/55">
          Detects the framework and content directory, then scaffolds, never
          overwriting. Re-running reports nothing to do.
        </p>
        <ul className="mt-3 space-y-2">
          {SCAFFOLDED.map((item) => (
            <li key={item.path} className="flex flex-col gap-0.5">
              <span className="font-mono text-xs text-base-content">
                {item.path}
              </span>
              <span className="text-xs text-base-content/60">
                {item.description}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <p className="mt-6 text-xs text-base-content/55 leading-relaxed">
        The laws run in your CI, offline, with no rankloop account &mdash;{" "}
        <span className="font-mono text-base-content">rankloop check</span> is
        the same engine as the grader here, so whichever writer produced a post,
        nothing merges that breaks the laws. Both writers share one queue, one
        gate, and one receipts view: run pSEO volume through rankloop and
        editorial through your own agent if that is the split you want.
      </p>
    </section>
  );
}
