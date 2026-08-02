import { createFileRoute } from "@tanstack/react-router";
import { RankloopArmoryBoard } from "@/client/features/rankloop-grow/RankloopArmoryBoard";

export const Route = createFileRoute("/_project/p/$projectId/grow")({
  component: GrowPage,
});

// Off-page: where links and listings can come from (specs 0028, 0029).
//
// One board over three lanes — the checked directory pack, pages your
// competitors are already linked from, and SERP-mined roundups. It was
// previously the link gap alone, buried as a fourth tab under Plan, where
// nobody looking for "how do I get backlinks" would ever find it.
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
        <RankloopArmoryBoard projectId={projectId} />
      </div>
    </div>
  );
}
