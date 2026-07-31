"use client";

/** The OpenSEO sidebar, ported faithfully: flat bg-base-200 (the content
 * panel is the raised surface), Browse|Chat underline tabs, grouped nav
 * with uppercase group labels, active item = base-300/50 tint + 3px
 * primary bar, footer with Help and the account dropdown (settings +
 * theme preference). Nav groups mirror OpenSEO's Overview / Research /
 * My Site / Connect — plus Write, which is ours. */

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";
import {
  BarChart3, Bot, ChevronsUpDown, CircleHelp, ClipboardCheck, FileText,
  Globe, LayoutDashboard, LayoutGrid, Link2, MessageCircle, Plus, Search,
  Settings, Sparkles, Target, TrendingUp, User,
} from "lucide-react";
import { site, chatThreads } from "@/lib/mock";
import { ThemePreferenceMenuItems } from "@/components/theme";

const navItemBaseClass =
  "relative flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm text-base-content/70";
const navItemClass = `${navItemBaseClass} transition-colors hover:bg-base-300/30 hover:text-base-content`;
const navItemActiveClass = `${navItemBaseClass} bg-base-300/50 hover:bg-base-300/50 font-medium text-base-content`;

interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  exact?: boolean;
}

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Overview",
    items: [{ href: "/", label: "Dashboard", icon: LayoutDashboard, exact: true }],
  },
  {
    label: "Write",
    items: [
      { href: "/opportunities", label: "Opportunities", icon: Target },
      { href: "/articles", label: "Articles", icon: FileText },
      { href: "/receipts", label: "Receipts", icon: BarChart3 },
    ],
  },
  {
    label: "Research",
    items: [
      { href: "/keywords", label: "Keyword Research", icon: Search },
      { href: "/domain", label: "Domain Overview", icon: Globe },
      { href: "/competitors", label: "Competitors", icon: TrendingUp },
      { href: "/backlinks", label: "Backlinks", icon: Link2 },
      { href: "/ai-visibility", label: "AI Visibility", icon: Sparkles },
    ],
  },
  {
    label: "My Site",
    items: [
      { href: "/search-performance", label: "Search Performance", icon: BarChart3 },
      { href: "/rank-tracking", label: "Rank Tracking", icon: TrendingUp },
      { href: "/audit", label: "Site Health", icon: ClipboardCheck },
    ],
  },
  {
    label: "Connect",
    items: [{ href: "/connect", label: "AI & MCP", icon: Bot }],
  },
];

function SidebarNavLink({ item }: { item: NavItem }) {
  const pathname = usePathname();
  const isActive = item.exact
    ? pathname === item.href
    : pathname.startsWith(item.href);
  const Icon = item.icon;
  return (
    <Link href={item.href} className={isActive ? navItemActiveClass : navItemClass}>
      {isActive ? (
        <div className="absolute left-0 top-1 bottom-1 w-[3px] rounded-r-full bg-primary" />
      ) : null}
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const onChat = pathname.startsWith("/chat");

  return (
    <div className="flex h-full w-60 flex-col bg-base-200">
      <div className="flex items-center justify-between px-4 pb-2 pt-3">
        <Link href="/" className="text-base font-semibold text-base-content">
          rankloop
        </Link>
      </div>

      {/* site switcher (ProjectSwitcher idiom) */}
      <div className="px-3 pb-1">
        <div className="dropdown w-full">
          <button
            type="button"
            tabIndex={0}
            className="flex w-full items-center justify-between gap-2 rounded-lg border border-base-300 bg-base-100 px-3 py-2 text-left"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{site.name}</span>
              <span className="block truncate text-xs text-base-content/50">{site.domain}</span>
            </span>
            <ChevronsUpDown className="h-4 w-4 shrink-0 text-base-content/40" />
          </button>
          <ul
            tabIndex={0}
            className="dropdown-content z-30 menu mt-1 w-56 rounded-box border border-base-300 bg-base-100 p-2 shadow-lg"
          >
            <li>
              <button type="button" className="font-medium">
                <Globe className="h-4 w-4" />
                {site.domain}
              </button>
            </li>
            <li>
              <Link href="/onboarding">
                <Plus className="h-4 w-4" />
                Add a site
              </Link>
            </li>
          </ul>
        </div>
      </div>

      {/* Browse | Chat underline tabs (PostHog-style, same as OpenSEO) */}
      <div className="px-3 pb-1">
        <div role="tablist" className="tabs tabs-border w-full">
          <Link
            href="/"
            role="tab"
            aria-selected={!onChat}
            className={`tab flex-1 gap-1.5 ${!onChat ? "tab-active" : ""}`}
          >
            <LayoutGrid className="size-4" />
            Browse
          </Link>
          <Link
            href="/chat"
            role="tab"
            aria-selected={onChat}
            className={`tab flex-1 gap-1.5 ${onChat ? "tab-active" : ""}`}
          >
            <MessageCircle className="size-4" />
            Chat
          </Link>
        </div>
      </div>

      {onChat ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          <div className="px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wider text-base-content/40">
            Conversations
          </div>
          {chatThreads.map((t) => (
            <Link
              key={t.id}
              href="/chat"
              className={t.active ? navItemActiveClass : navItemClass}
            >
              <MessageCircle className="h-4 w-4 shrink-0" />
              <span className="truncate">{t.title}</span>
            </Link>
          ))}
        </div>
      ) : (
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="mb-1">
              <div className="px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wider text-base-content/40">
                {group.label}
              </div>
              {group.items.map((item) => (
                <SidebarNavLink key={item.href} item={item} />
              ))}
            </div>
          ))}
        </nav>
      )}

      <div className="shrink-0 border-t border-base-300 px-2 py-2">
        <a
          href="https://github.com/worklab-studio/rankloop"
          target="_blank"
          rel="noreferrer"
          className={navItemClass}
        >
          <CircleHelp className="h-4 w-4 shrink-0" />
          <span className="truncate">Help &amp; Community</span>
        </a>
        <div className="dropdown dropdown-top w-full">
          <button
            type="button"
            tabIndex={0}
            className={`${navItemClass} w-full`}
            aria-label="Open account menu"
          >
            <User className="h-4 w-4 shrink-0" />
            <span className="truncate">you@cremanotes.example</span>
          </button>
          <ul
            tabIndex={0}
            className="dropdown-content z-30 menu mb-1 w-56 rounded-box border border-base-300 bg-base-100 p-2 shadow-lg"
          >
            <li>
              <Link href="/settings">
                <Settings className="h-4 w-4" />
                Settings
              </Link>
            </li>
            <li aria-hidden className="pointer-events-none my-1 h-px bg-base-300 p-0" />
            <ThemePreferenceMenuItems />
          </ul>
        </div>
      </div>
    </div>
  );
}
