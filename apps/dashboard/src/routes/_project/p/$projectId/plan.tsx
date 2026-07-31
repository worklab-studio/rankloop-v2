import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_project/p/$projectId/plan")({
  component: PlanLayout,
});

function PlanLayout() {
  return (
    <div className="px-4 py-4 pb-24 overflow-auto md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-7xl space-y-4">
        <div>
          <h1 className="text-2xl font-semibold">Plan</h1>
          <p className="text-sm text-base-content/70">
            Who you&rsquo;re up against, what demand exists, and which pages are
            worth building.
          </p>
        </div>

        <Outlet />
      </div>
    </div>
  );
}
