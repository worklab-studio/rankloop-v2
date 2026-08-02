import {
  Bookmark,
  Bot,
  FileText,
  Globe,
  Link2,
  LayoutDashboard,
  Map,
  MessageSquare,
  Microscope,
  Plug,
  Search,
  Send,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { linkOptions } from "@tanstack/react-router";
import { GoogleGlyphMuted } from "@/client/features/gsc/GoogleGlyph";

// The sidebar is the pipeline (spec 0028).
//
// It used to be a filing cabinet: fourteen flat items mixing OpenSEO's
// point-at-anything research tools with rankloop's operating loop, in no
// particular order. A new user could not tell where to start because there
// was no start. These six are the journey, in the order it happens, and the
// research tools live in a Toolbox below them — reachable, never in the way.
const journeyNavItems = [
  {
    to: "/p/$projectId" as const,
    label: "Today",
    icon: LayoutDashboard,
    // Without exact matching, the index path is a prefix of every project
    // route and this item would render active everywhere.
    activeOptions: { exact: true, includeSearch: false },
  },
  {
    to: "/p/$projectId/study" as const,
    label: "Study",
    icon: Microscope,
  },
  {
    to: "/p/$projectId/plan" as const,
    label: "Plan",
    icon: Map,
  },
  {
    to: "/p/$projectId/articles" as const,
    label: "Publish",
    icon: FileText,
  },
  {
    to: "/p/$projectId/grow" as const,
    label: "Grow",
    icon: Send,
  },
  {
    to: "/p/$projectId/connect" as const,
    label: "Connect",
    icon: Plug,
  },
] as const;

// Point-at-anything lookup tools. Every one of these still works and still
// has its URL — they are simply not on the path a new project walks.
const toolboxNavItems = [
  {
    to: "/p/$projectId/keywords" as const,
    label: "Keyword Research",
    icon: Search,
  },
  {
    to: "/p/$projectId/domain" as const,
    label: "Domain Overview",
    icon: Globe,
  },
  {
    to: "/p/$projectId/backlinks" as const,
    label: "Backlinks",
    icon: Link2,
  },
  {
    to: "/p/$projectId/rank-tracking" as const,
    label: "Rank Tracking",
    icon: TrendingUp,
  },
  {
    to: "/p/$projectId/search-performance" as const,
    label: "GSC Insights",
    icon: GoogleGlyphMuted,
  },
  {
    to: "/p/$projectId/receipts" as const,
    label: "Receipts",
    icon: Sparkles,
  },
  {
    to: "/p/$projectId/audit" as const,
    label: "Site Audit",
    icon: Bookmark,
  },
  {
    to: "/p/$projectId/ai-access" as const,
    label: "AI Access",
    icon: Bot,
  },
  {
    to: "/p/$projectId/brand-lookup" as const,
    label: "Brand Lookup",
    icon: Sparkles,
  },
  {
    to: "/p/$projectId/prompt-explorer" as const,
    label: "Prompt Explorer",
    icon: MessageSquare,
  },
  {
    to: "/p/$projectId/saved" as const,
    label: "Saved Keywords",
    icon: Bookmark,
  },
] as const;

const aiNavItem = linkOptions({
  to: "/ai" as const,
  label: "AI & MCP",
  icon: Bot,
});

// Always-visible sidebar group (not project-scoped, unlike the groups below).
export const connectNavGroup = {
  label: "Connect",
  collapsible: false,
  items: [aiNavItem],
};

// Two concrete builders rather than one generic helper: `linkOptions` infers
// from the literal `to` values, and a generic parameter widens them to
// `string`, at which point every route becomes unassignable.
function journeyItems(projectId: string) {
  return linkOptions(
    journeyNavItems.map((item) => ({
      ...item,
      params: { projectId },
      search: {},
    })),
  );
}

function toolboxItems(projectId: string) {
  return linkOptions(
    toolboxNavItems.map((item) => ({
      ...item,
      params: { projectId },
      search: {},
    })),
  );
}

export function getProjectNavGroups(projectId: string) {
  return [
    { label: null, collapsible: false, items: journeyItems(projectId) },
    {
      label: "Toolbox",
      // Collapsed by default: these are the tools you reach for when you
      // already know what you are looking for, and a new project never
      // does.
      collapsible: true,
      items: toolboxItems(projectId),
    },
  ];
}

export const dataforseoHelpLinkOptions = linkOptions({
  to: "/help/dataforseo-api-key",
});

export const openrouterHelpLinkOptions = linkOptions({
  to: "/help/openrouter-api-key",
});
