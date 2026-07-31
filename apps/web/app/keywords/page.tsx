import { Sparkles } from "lucide-react";
import { PageHeader, StatCard } from "@/components/ui";
import { keywords } from "@/lib/mock";
import KeywordTable from "./table";

/** Keyword research — the backlog every other screen feeds from. Server
 * shell computes the stat row; all filtering/sorting/queueing lives in the
 * KeywordTable client island. */

export default function KeywordsPage() {
  const total = keywords.length;
  const discovered = keywords.filter((k) => k.status === "discovered").length;
  const backlog = keywords.filter(
    (k) => k.status === "approved" || k.status === "queued",
  ).length;
  const published = keywords.filter((k) => k.status === "published").length;

  return (
    <>
      <PageHeader
        title="Keyword research"
        subtitle="Paid metrics, free long-tail and Search Console demand — one backlog, one score."
        actions={
          <button className="btn btn-primary btn-sm">
            <Sparkles className="h-4 w-4" />
            Run discovery
          </button>
        }
      />

      {/* the backlog funnel at a glance */}
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total keywords" value={String(total)} sub="across all sources" />
        <StatCard label="Discovered" value={String(discovered)} sub="waiting for a decision" />
        <StatCard label="Approved / queued" value={String(backlog)} sub="in the write pipeline" />
        <StatCard label="Published" value={String(published)} sub="live and reporting back" />
      </div>

      <KeywordTable rows={keywords} />
    </>
  );
}
