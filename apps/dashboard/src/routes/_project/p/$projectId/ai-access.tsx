import { createFileRoute } from "@tanstack/react-router";
import { RankloopAiAccessPanel } from "@/client/features/rankloop-verdict/RankloopAiAccessPanel";

export const Route = createFileRoute("/_project/p/$projectId/ai-access")({
  component: AiAccessPage,
});

function AiAccessPage() {
  const { projectId } = Route.useParams();
  return (
    <div className="overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-4xl space-y-4">
        <div>
          <h1 className="text-2xl font-semibold">AI access</h1>
          <p className="text-sm text-base-content/70">
            Whether AI crawlers can read your site, and what to change if they
            cannot. Reads your robots.txt, looks for llms.txt, and checks
            whether anything in front of your site turns bots away.
          </p>
        </div>
        <RankloopAiAccessPanel projectId={projectId} />
      </div>
    </div>
  );
}
