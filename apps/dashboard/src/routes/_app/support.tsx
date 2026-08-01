import { createFileRoute } from "@tanstack/react-router";
import { RANKLOOP_REPO_URL, UPSTREAM_REPO_URL } from "@/shared/product";

// Support routing follows who can actually fix the thing.
//
// rankloop is a fork of OpenSEO. Bugs in this app — the pipeline, articles,
// receipts, or anything rankloop changed — go to rankloop's issue tracker.
// The OpenSEO Discord stays linked because it is a genuinely good room for
// questions about the SEO core rankloop inherited, but it is labelled as
// upstream's community so nobody files a rankloop bug there.
//
// Upstream's support address (ben@openseo.so) is deliberately NOT listed here:
// routing this fork's support load into the upstream author's inbox would be
// taking something the MIT License never offered.
const UPSTREAM_DISCORD_URL = "https://discord.gg/c9uGs3cFXr";

export const Route = createFileRoute("/_app/support")({
  component: SupportPage,
});

function SupportPage() {
  return (
    <div className="h-full overflow-auto bg-base-100 px-4 py-8 pb-24 md:px-6 md:py-12 md:pb-8">
      <div className="mx-auto max-w-xl">
        <p className="text-sm font-medium text-base-content/40">
          Help &amp; Community
        </p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">
          We want to hear from you
        </h1>
        <p className="mt-2 text-sm text-base-content/60">
          We're open to feedback and want to learn how you work so we can make
          rankloop better.
        </p>

        <div className="mt-8 space-y-3">
          <a
            href={`${RANKLOOP_REPO_URL}/issues`}
            target="_blank"
            rel="noreferrer"
            className="block rounded-lg border border-base-300 px-5 py-4 transition-colors hover:border-base-content/20"
          >
            <p className="text-sm font-semibold">rankloop on GitHub</p>
            <p className="mt-1 text-sm text-base-content/60">
              Report bugs, request features, or read the source. This is the
              right place for anything about rankloop itself.
            </p>
            <span className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-base-content">
              Open an issue
              <span aria-hidden="true">&rarr;</span>
            </span>
          </a>

          <div className="rounded-lg border border-base-300 px-5 py-4">
            <p className="text-sm font-semibold">
              OpenSEO &mdash; the project rankloop is built on
            </p>
            <p className="mt-1 text-sm text-base-content/60 leading-relaxed">
              rankloop is a fork of{" "}
              <a
                href={UPSTREAM_REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="link link-primary"
              >
                OpenSEO
              </a>{" "}
              (MIT), and the keyword, SERP, backlink, rank tracking, audit, and
              MCP tooling here is their work. Their{" "}
              <a
                href={UPSTREAM_DISCORD_URL}
                target="_blank"
                rel="noreferrer"
                className="link link-primary"
              >
                Discord
              </a>{" "}
              is a good room for questions about that SEO core &mdash; please
              send rankloop bugs to rankloop's tracker instead.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
