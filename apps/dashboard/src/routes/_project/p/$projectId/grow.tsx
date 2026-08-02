import { createFileRoute } from "@tanstack/react-router";
import { RankloopOutreachTab } from "@/client/features/rankloop-plan/RankloopOutreachTab";

export const Route = createFileRoute("/_project/p/$projectId/grow")({
  component: GrowPage,
});

// Off-page: where links and listings can come from (spec 0028).
//
// Today this is the link gap alone — domains linking to two or more of your
// competitors but not to you. Phase 2 adds the other two lanes (a curated
// directory pack and SERP-mined listicles) to the same board. The page
// exists now because the link gap was buried as a fourth tab under Plan,
// where nobody looking for "how do I get backlinks" would ever find it.
function GrowPage() {
  const { projectId } = Route.useParams();
  return (
    <div className="overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-6xl space-y-4">
        <div>
          <h1 className="text-2xl font-semibold">Grow</h1>
          <p className="text-sm text-base-content/70">
            Places that could link to you or list you. rankloop finds them and
            drafts the message; you decide what to send.
          </p>
        </div>
        <RankloopOutreachTab projectId={projectId} />
      </div>
    </div>
  );
}
