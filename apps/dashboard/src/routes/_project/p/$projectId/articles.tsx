import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_project/p/$projectId/articles")({
  component: ArticlesLayout,
});

function ArticlesLayout() {
  return (
    <div className="px-4 py-4 pb-24 overflow-auto md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-7xl space-y-4">
        <div>
          <h1 className="text-2xl font-semibold">Articles</h1>
          <p className="text-sm text-base-content/70">
            Proposals from your own search data. Nothing changes your site
            without a yes.
          </p>
        </div>

        <Outlet />
      </div>
    </div>
  );
}
