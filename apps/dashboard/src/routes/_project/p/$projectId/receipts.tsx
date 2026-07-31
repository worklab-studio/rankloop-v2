import { createFileRoute } from "@tanstack/react-router";
import { RankloopReceiptsPanel } from "@/client/features/rankloop-receipts/RankloopReceiptsPanel";

export const Route = createFileRoute("/_project/p/$projectId/receipts")({
  component: ReceiptsPage,
});

function ReceiptsPage() {
  const { projectId } = Route.useParams();
  return (
    <div className="overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-6xl space-y-4">
        <div>
          <h1 className="text-2xl font-semibold">Receipts</h1>
          <p className="text-sm text-base-content/70">
            Every executed action reports what it moved. Evaluation window: days
            14&ndash;42 after.
          </p>
        </div>
        <RankloopReceiptsPanel projectId={projectId} />
      </div>
    </div>
  );
}
