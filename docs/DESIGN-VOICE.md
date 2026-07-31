# OpenSEO dashboard — product voice & state design reference

Lens: voice-and-states. Source: `apps/dashboard/src/client` (+ `src/routes`) at the vendored
commit. Everything quoted below is verbatim from the codebase, with file paths. The goal:
new Write-side copy (Opportunities, Articles, Receipts) must read like the same author.

---

## 1. The voice in one paragraph

Plain, confident, benefit-first. Short declarative sentences with contractions ("you
aren't limited", "Couldn't load"). It explains *why* a step matters in one concrete
clause ("Connect GSC to see how your website is actually performing in Google Search"),
never in marketing paragraphs. It is unusually honest about money ("Daily checks use 7x
more credits than weekly") and about data limits ("Search Console data trails by a few
days"). Success is terse past-tense ("Search Console connected"); failure names the thing
that failed and often what to do next ("Couldn't save the domain. Try again."). No
exclamation marks except one legacy toast ("Audit started!"). No emojis anywhere.

---

## 2. Capitalization system (this is the biggest tell)

Two registers coexist, deliberately:

**Title Case** — page identities and nav labels only:
- Nav (`src/client/navigation/items.ts`): `Dashboard`, `Keyword Research`, `Saved
  Keywords`, `Rank Tracking`, `GSC Insights`, `Domain Overview`, `Backlinks`, `Site
  Audit`, `Brand Lookup`, `Prompt Explorer`, `AI & MCP`. Sidebar groups: `Overview`,
  `Research`, `My Site`, `Connect`.
- Page `<h1 className="text-2xl font-semibold">` mirrors nav exactly: `Search
  Performance`, `Rank Tracking`, `Domain Overview`, `Site Audit`…

**Sentence case** — everything inside the page: card titles, modal titles, buttons,
labels, empty states:
- Dashboard card titles (`features/dashboard/DashboardCards.tsx`): `Search performance`,
  `Site audit`, `Backlink pulse`, `Connect your AI agent`.
- Modal titles: `Delete keywords?`, `Archive acme.com?`, `New project`, `One quick setup
  step`, `New: Connect Google Search Console`.
- Buttons: `Save changes`, `Create project`, `Connect with Google`, `Open setup guide`,
  `Run an audit`, `Show me how`, `Maybe later`, `I already connected`, `Change property`.

**Known feature-level drift** (older rank-tracking + audit code uses Title Case for
buttons/card titles: `Check Now`, `Add Domain`, `Run Now`, `Save Changes`, `Start New
Audit`, `Tracked Domains`, `Previous Audits` — `features/rank-tracking/*`,
`features/audit/launch/*`). The *newest* code (dashboard, projects, GSC, ai.tsx) is
consistently sentence case. **New Write features should follow the sentence-case register**
— it's where the codebase is heading, and it matches the dashboard cards Write will sit
next to.

Section eyebrows are uppercase-tracking labels, not headings:
```tsx
<p className="text-xs font-medium uppercase tracking-wide text-primary">
  Onboarding checklist
</p>
```
(`DashboardPage.tsx`; same pattern: `MCP server URL`, `Available skills`, `Step 1 of 4`,
stat labels `Clicks` / `Ref. domains` via `text-xs uppercase tracking-wide
text-base-content/60` in `cardParts.tsx`.)

---

## 3. Page headers: h1 + one-line subhead

Every page: `text-2xl font-semibold` h1 followed by a single `text-sm
text-base-content/70` sentence (with period) that states the job of the page. Verbatim set:

| Page | Subhead |
|---|---|
| Keyword Research (`features/keywords/page/KeywordResearchPage.tsx`) | "Discover keyword ideas, search demand, and ranking opportunities." |
| Saved Keywords (`features/saved-keywords/SavedKeywordsHeader.tsx`) | "Save keyword ideas from research, organize them with tags, and revisit when you're ready to act." |
| Search Performance (`features/search-performance/SearchPerformancePage.tsx`) | "See your site's clicks, impressions, CTR, and position from Google Search Console." |
| Domain Overview (`features/domain/DomainOverviewPage.tsx`) | "Analyze any domain's SEO profile: traffic, keywords, and backlinks." |
| Backlinks (`features/backlinks/BacklinksPage.tsx`) | "Understand who links to a site, what changed recently, and which pages attract links." |
| Brand Lookup (`features/ai-search/BrandLookupPage.tsx`) | "See how AI search cites any brand name or domain." |
| Prompt Explorer (`features/ai-search/PromptExplorerPage.tsx`) | "Ask any prompt across ChatGPT, Claude, Gemini, and Perplexity side-by-side." |
| Rank Tracking (`routes/_project/p/$projectId/rank-tracking.tsx`) | "Track keyword positions across domains" *(only one missing its period — an outlier, keep periods)* |
| AI & MCP (`routes/_app/ai.tsx`) | "Connect your AI agent to OpenSEO. Run keyword research, SERP analysis, domain lookups, and backlink reviews from your editor or chat." |

Pattern: verb-first ("Discover…", "See…", "Track…", "Understand…"), lists exactly three
concrete nouns where possible, ~8–14 words.

---

## 4. State taxonomy — every distinct pattern, with anatomy

### 4a. Blank-slate empty (user has never done the thing)

**Anatomy:** dashed border, centered, muted lucide icon, imperative headline, optional
one-line explainer of what they'll get. No shame, no "oops".

```tsx
// features/keywords/page/KeywordResearchEmptyState.tsx
<section className="rounded-2xl border border-dashed border-base-300 bg-base-100/70 p-6 text-center text-base-content/50 space-y-3">
  <Search className="size-10 mx-auto opacity-40" />
  <p className="text-lg font-medium text-base-content/80">
    Enter a keyword to get started
  </p>
  <p className="text-sm max-w-md mx-auto">
    Search for any keyword to see volume, difficulty, CPC, and related
    keyword ideas.
  </p>
</section>
```

The family (all `border-dashed`, all "Enter a X to get started" or a benefit variant):
- `features/domain/components/DomainHistorySection.tsx`: "Enter a domain to get started"
- `features/backlinks/BacklinksHistorySection.tsx`: "Enter a domain or URL to get started"
- `features/ai-search/components/BrandLookupHistorySection.tsx`:
  `emptyMessage="Search a brand name or domain to see how AI cites it"`
- `features/ai-search/components/PromptExplorerHistorySection.tsx`:
  `emptyMessage="Enter a prompt to compare model answers"`
- `features/audit/launch/AuditHistorySection.tsx`: icon + "No audits yet" (headline only)
- `features/rank-tracking/RankTrackingDomainList.tsx` (solid border variant, inside a card):
  "No tracked domains yet" + "Add a domain to start monitoring keyword rankings over time."
- `features/sam/SamSidebarPanel.tsx`: "No chats yet. Start a new one."
- `features/saved-keywords/SavedKeywordsTable.tsx`: "No saved keywords yet. Use the
  Keyword Research page to find and save keywords." — *empty states cross-sell the page
  that fills them.*

Dashboard-card variant (`EmptyCardBody` in `features/dashboard/cardParts.tsx`): plain
sentence + primary button, no icon:
```tsx
<EmptyCardBody
  message="Crawl your site for broken links, missing tags and indexability problems."
  cta={<Link ... className="btn btn-primary btn-sm">Run an audit</Link>}
/>
```
And the zero-config promise (`BacklinkPulseCard`): "We'll snapshot who links to your
domain — nothing to set up."

### 4b. Searched-but-nothing-found (a real query returned nothing)

Solid border (not dashed — the user *did* something), echoes their input back in bold,
blames the data, not the user:

```tsx
// KeywordResearchEmptyState.tsx (NoResultsState)
<p className="text-lg font-semibold text-base-content">
  Not enough keyword data for this query yet
</p>
<p className="text-sm text-base-content/70">
  We could not find keyword opportunities for
  <span className="font-medium text-base-content">{` "${lastSearchKeyword}" `}</span>
  in
  <span className="font-medium text-base-content">{` ${LOCATIONS[lastSearchLocationCode] || "this location"}`}</span>.
</p>
```

Others: `toast.info("Not enough data for this domain")`
(`features/domain/DomainOverviewPage.tsx`); rank-tracking suggestions: "We couldn't find
any keywords {domain} currently ranks for. You can add keywords manually."
(`features/rank-tracking/KeywordSuggestionStep.tsx` — note the graceful exit offer);
"No rankings found" as its section header. Approximate-match fallback
(`features/keywords/page/KeywordResearchDesktopResults.tsx`) is a warning strip, not an
error: `No exact match for "{searchedKeyword}". Showing closest related keywords
instead. Source: {lastResultSource} fallback.`

### 4c. Filtered-to-empty (data exists, filters hide it)

One-line label in a dashed box, always ends with a period, names the filter, offers reset:

```tsx
// features/backlinks/BacklinksPageEmptyTableState.tsx
<div className="rounded-xl border border-dashed border-base-300 p-10 text-center text-sm text-base-content/55">
  {label}
</div>
```
Labels: "No backlinks match this filter." / "No referring domains match this filter." /
"No top pages match this filter." / "No pages match these filters." / "No keywords match
your current filters." / "No keywords match this search." / "No saved keywords match the
current filters." / "No keywords match your search."
Rank-tracking domain list adds recovery: "No matching tracked domains" + "Try clearing
search or adjusting filters." + `Clear filters` ghost button
(`RankTrackingDomainList.tsx`).

The pattern distinguishes zero-data from zero-matches in one ternary:
```tsx
// features/rank-tracking/RankTrackingTable.tsx
{totalCount === 0
  ? 'No rank data yet. Click "Check Now" to run your first check.'
  : "No keywords match your search."}
```

### 4d. Setup-required / gate states (the thing needs configuration)

These are **pitches, not warnings** — headline names the action, body gives the concrete
benefit, one primary CTA, always a link to a setup guide when config is involved.

**GSC not connected** (`features/gsc/SearchConsoleConnectionCard.tsx`) — the canonical one:
```tsx
<p className="text-sm text-base-content/70">
  Connect GSC to see how your website is actually performing in Google
  Search.
</p>
<button ...><GoogleGlyph className="size-[18px]" />Connect with Google</button>
```
Card carries a `StatusPill`: `Connected` / `Not connected` / `Setup required`
(dot + rounded-full badge, success/neutral/warning tints).

**Missing DataForSEO key** — modal (`layout/AppShellParts.tsx`, `MissingSeoSetupModal`):
- Title: "One quick setup step" *(reframes the blocker as small)*
- Body: "Add your DataForSEO API key to start using OpenSEO."
- Buttons: `Dismiss` (ghost) / `Open setup guide` (primary, ExternalLink icon)

Same file, persistent banner variant: "Setup needed: add your DataForSEO API key to use
OpenSEO features. See the quick steps on the help page." And the unverifiable-state
banner (alert-info, hedged): "We could not verify your DataForSEO setup. If features are
not working, check the setup steps on the help page."

**Missing OpenRouter key** (`features/sam/SamSetupGate.tsx`): title "Enable AI Features";
body is instructional and names the env var in `<code>`: "SAM, OpenSEO's in-app AI agent,
needs an OpenRouter API key. Create a key on OpenRouter, set it as the
`OPENROUTER_API_KEY` environment variable, restart OpenSEO, then confirm here." Buttons:
`Confirm API Key` (pending: "Confirming...") / `Open OpenRouter Keys`. Fine print links
"OpenRouter API key setup guide".

**Self-hosted GSC OAuth missing** (`features/gsc/SelfHostedSetupWarning.tsx`):
alert-warning, bold first line "Google OAuth client not configured", then "Add your
Google client ID and secret to this OpenSEO deployment before connecting Search
Console." + "Open setup guide" link.

**Cloudflare Access MCP warning** (`routes/_app/ai.tsx`): "This instance is behind
Cloudflare Access. MCP clients cannot connect until Managed OAuth is enabled on your
Access application. Setup guide"

**Paid-plan gate** (`features/ai-search/components/AiSearchPaidPlanGate.tsx`): pill badge
`Paid plan` (Sparkles icon), h2 `Unlock {feature}`, one-line description, `Upgrade`
button, then a 3-column bullet grid (icon + bold micro-title + 1–2 sentence body), e.g.
from `BrandLookupPage.tsx`: "Track AI visibility" / "See the prompts" / "Map the
competition".

**Free-plan inline alert** (`features/rank-tracking/FreePlanAlert.tsx`): "We only start
to track keyword positions once you upgrade to the paid plan."

**Credits banners** (`features/billing/FreePlanBanner.tsx`), escalating tone by variant:
- info: "We hope you're enjoying OpenSEO! Upgrade anytime or reach out with questions."
- warning: "You're running low on credits. {Upgrade your plan|Buy more credits} to keep using OpenSEO."
- error: "You've used all your credits. {link} to continue using OpenSEO."

**Auth setup** (`components/AuthConfigErrorCard.tsx`): "Authentication setup required",
names exact env vars in `<code>` with constraints in parens ("(32+ characters)"), buttons
`Try Again` / `Open Setup Guide`.

### 4e. Loading states

Three tiers, chosen by scope:

1. **Page/section skeletons** — `skeleton` divs mirroring final layout, wrapper gets bare
   `aria-busy` (9 files use it). No text at all. See `BacklinksPageStates.tsx`
   (`BacklinksLoadingState`), `AiSearchLoadingState.tsx`,
   `PromptExplorerLoadingState.tsx` (skeletons match the model-count about to render),
   `DashboardPage.tsx`.
2. **Inline spinner + gerund word** for a small check: `<span className="loading
   loading-spinner loading-sm" /> Checking…` (`SearchConsoleOnboardingStep.tsx`,
   `SearchConsoleConnectionCard.tsx`), "Loading properties…" (`SitePicker.tsx`).
3. **Button self-labels while pending** — the button text becomes the gerund:
   `{isSubmitting ? <><Loader2 .../> Starting...</> : "Start Audit"}`
   (`LaunchFormCard.tsx`); "Saving…" (`SitePicker`), "Looking up..."
   (`BrandLookupSearchCard`), "Running…" (`PromptExplorerForm`), "Confirming..."
   (`SamSetupGate`), "Loading..." (`DomainSearchCard`).

Long-running with narration: audit `ProgressCard`
(`routes/_project/p/$projectId/audit/index.tsx`) — "Crawling pages" / "Running
Lighthouse checks", phase badge (`Discovery`/`Crawling`/`Lighthouse`/`Finalizing`),
`{n} / {total} pages`, live "Crawled Pages (n)" feed. Modal variant sets the *title* to
the gerund: "Finding your top keywords..." + "This usually takes a few seconds"
(`KeywordSuggestionStep.tsx`). First-run special case gets warmth:
`stamp="Taking your first snapshot…"` (`DashboardCards.tsx`).

*(Ellipsis inconsistency exists: `…` char in Checking…/Saving…/Running…/refreshing…, but
`...` in Starting.../Looking up.../Confirming.... Either passes as native; `…` is
slightly more common in newer code.)*

### 4f. Error states

- **Inline card-level failure, soft**: `Couldn't load Search Console data. Try again
  shortly.` — plain `text-base-content/60` paragraph, not even error-colored
  (`DashboardCards.tsx`, GscCard).
- **Section-level failure**: rounded card with `ShieldAlert` icon, h2 "Could not load
  backlinks", body `errorMessage ?? "Please try again in a moment."`, `Retry` button
  (`BacklinksPageStates.tsx`).
- **Route-level** (`components/DefaultCatchBoundary.tsx`): fallback "Something went
  wrong. Please try again." + `Try Again` (primary) + `Go Back`/`Home`.
- **Alert rows** for domain errors: `alert alert-error` + one sentence — "We could not
  load this audit. It may have been deleted." (audit route).
- **Blocked-crawl partial warning** (`features/audit/results/ResultsView.tsx`) — the
  best example of the voice explaining a technical failure with an action:
  "We were blocked on {n} pages." (bold) + "The site's bot protection challenged our
  crawler, so those pages couldn't be audited. If this is your site, allowlist the
  `OpenSEO-Audit` user agent in your WAF or bot-protection settings and re-run the audit."
- **Support escalation** (audit route): "Site audit couldn't fully crawl this website." +
  "This is often caused by anti-bot or firewall settings. Reach out at
  everyapp.dev/support and we'll help configure auditing for your site."
- **Expired connection** (`SitePicker.tsx`): "Connection expired. Reconnect to continue."
  + `Reconnect with Google`.
- **Standard error table** (`client/lib/error-messages.ts`) — server codes map to full
  sentences that state the limit and the fix:
  - `INSUFFICIENT_CREDITS`: "You've run out of credits. Add more credits or upgrade your plan to continue."
  - `AUDIT_ALREADY_RUNNING`: "You already have an audit running. Wait for it to finish or delete it before starting another."
  - `AUDIT_CAPACITY_REACHED`: "You've reached audit capacity for your account. Delete old audits from your projects to start a new one."
  - `DATAFORSEO_AUTH_FAILED`: "DataForSEO rejected the API key. Check that DATAFORSEO_API_KEY is the base64 of your DataForSEO login:password."
  - `RATE_LIMITED`: "Too many requests. Please wait and try again."
  - `UPSTREAM_UNAVAILABLE`: "The data provider is temporarily unavailable. Please retry in a moment."
  Everything error-shaped funnels through `getStandardErrorMessage(error, fallback)` —
  Write-side mutations must do the same.

### 4g. Partial data

Never hide a stat that's null — render `—` (em dash): `newLost()` in `cardParts.tsx`,
`backlinks.referringDomains === null ? "—" : ...`. Background refresh is a stamp suffix,
not a spinner takeover: `` `Backlinks · snapshot ${formatDay(...)}${refreshing ? " ·
refreshing…" : ""}` ``. Table refetch = small `Loader2` spinner next to filters while
stale data stays visible (`keepPreviousData`, `SearchPerformancePage.tsx`). Data-lag
honesty: "No data for this period yet. Search Console data trails by a few days."
(`SearchPerformanceParts.tsx`).

### 4h. Waiting-on-external states

`McpConnectCard.tsx` after auth but before first tool call: "Your agent is connected. Try
asking it:" + copyable prompt chips, then fine print explaining the card's own lifecycle:
"Waiting for your first call — this card disappears once your agent talks to OpenSEO."
*(The UI narrates its own state machine in one calm sentence — very characteristic.)*

---

## 5. Onboarding & coaching copy

**Wizard** (`features/onboarding/PostSignupOnboarding.tsx`, `onboardingModel.ts`):
- Eyebrow: "Step {n} of {total}"; title "Welcome to OpenSEO, {firstName}!"; helper
  "A few quick answers to set things up."
- Questions are conversational: "What tasks matter to you most?" ("Pick up to 3."),
  "Who are you doing SEO for?", "About how many client sites do you work on?",
  "How did you find OpenSEO?", "Connect with Google Search Console now?"
- Other-input placeholders: "Tell us what else..." / "Tell us more..."
- Buttons: `Back` / `Skip` / `Continue →` / `Finish →`.
- Fine print manages expectations and names the future: "For now, Search Console data
  flows through the OpenSEO MCP. We're building it into the OpenSEO app soon too."
- Market picker helper: "We'll use this country and language for keyword, SERP, and
  domain data unless you pick a different one. You can change it in project settings."

**Dashboard onboarding checklist** (`features/dashboard/DashboardPage.tsx`, `HERO_COPY`)
— one step at a time, pageable ‹ n / 4 ›, hidden forever once all done. The full copy
table, the model for any Write-side activation coaching:

| step | title | body | cta |
|---|---|---|---|
| domain | "What site are you working on?" | "Set your project's domain and every card on this page starts working for it — backlinks and audits." | `Save` |
| mcp | "Connect your AI agent" | "OpenSEO is built to be used from agents like Claude. Connect once, then ask it to use OpenSEO to help build your SEO strategy." | `Show me how` |
| gsc | "Connect Search Console" | "Your real queries and clicks, straight from Google." | `Connect` |
| competitor | "Size up a competitor" | "Paste a competitor's domain to see what they rank for and who links to them." | `Open domain lookup` |

Done state: green check + `Done`. Escape hatch is always offered ("I already connected"
ghost button on the MCP card; `dashboardSteps.ts` counts dismissal as done).

**Re-engagement modal** (`features/gsc/GscReEngagementModal.tsx`): title prefixed
"New: Connect Google Search Console"; body sells twice in two sentences: "Bring your real
clicks, impressions, and rankings into OpenSEO and query them from Claude or Codex over
MCP. It never uses credits." Decline button: `Maybe later` (never "No" / "Cancel" for
nudges).

---

## 6. Helper text under inputs

Always `text-xs text-base-content/50..60`, one or two sentences, and it does one of three
jobs:

1. **States the consequence/benefit**: "We'll flag whether each model mentions this
   brand." (`PromptExplorerForm.tsx`); "Add up to 5 competitor brands or domains to see
   your Share of Voice." (`BrandLookupSearchCard.tsx`); "What your customers might ask
   AI." (prompt textarea).
2. **States the cost, with multipliers and real dollars** (the house specialty):
   - "Tracking both devices uses 2x credits per keyword check"
   - "Daily checks use 7x more credits than weekly"
   - "10 pages is ~8x more expensive than 1 page"
   - "~$0.0045 per keyword per check" / "50 keywords would cost ~$2.70/month"
     (`RankTrackingConfigModal.tsx`)
   - "Est. $1.02 plus ~$0.24 to compare competitors" (`BrandLookupSearchCard.tsx`)
   - Tooltip: "…Turn this on to estimate each keyword's own volume. Costs 2x the
     credits." (`KeywordResearchSearchBar.tsx`)
   - `CheckConfirmModal.tsx`: "{n} keywords × {d} devices = {t} SERP checks", "Results in
     ~45s", "~$0.32".
3. **Defers setup honestly**: "You can connect Search Console and set up rank tracking
   after creating the project." (`CreateProjectModal.tsx`); "Change it later in project
   settings."

Advisory (not prescriptive) tone for choices: "Most Google searches come from mobile, but
select this based on your customer." (`RankTrackingConfigModal.tsx`).

Data-caveat info strips use `role="status"` + Info icon: "Keyword data for this country
comes from Google Ads — search volume, CPC, and trends are available, but difficulty and
intent are not." (`KeywordResearchSearchBar.tsx`).

Placeholders are examples, not labels: `acme.com`, `example.com`, `https://example.com`,
`Acme Inc.`, "Enter a keyword", "Enter a domain", "Enter a brand name or domain", "Add
competitors (comma-separated)", "Enter keywords, one per line", "Ask SAM to research,
analyze, or track anything…".

---

## 7. Toasts (complete verbatim inventory)

**Success — past-tense noun phrase, 2–4 words, no period:**
`Search Console connected` · `Search Console disconnected` · `Project created` ·
`Project updated` · `Project archived` · `Domain archived` ·
`Domain added for rank tracking` · `Configuration updated` · `Rank check started` ·
`Audit started!` *(sole exclamation in the app)* · `Audit deleted` · `Tag updated` ·
`Tag deleted` · `Prompt copied` · `MCP URL copied` · `Copied to clipboard` ·
`Copied data` · `Keywords copied to clipboard` · `Email copied to clipboard` ·
`Download started` · `CSV download started` · `Search Console connected`.

**Success — with counts (always inline-pluralized):**
`` `Saved ${n} keywords` `` · `` `Copied ${n} ${n === 1 ? "keyword" : "keywords"}` `` ·
`` `Added ${n} keywords for tracking` `` · `` `${n} keyword${n !== 1 ? "s" : ""} added` `` ·
`` `Metrics updated for ${n} keywords` ``.

**Error — three families (know them, prefer the first):**
- *Couldn't (newest, dashboard/GSC/perf):* "Couldn't save the domain. Try again." ·
  "Couldn't copy to clipboard" · "Couldn't fetch keywords"
- *Could not (mid-era):* "Could not copy to clipboard" · "Could not save keywords" ·
  "Could not update tag" · "Could not export CSV" · "Could not export to Sheets" ·
  "Could not start Google sign-in"
- *Failed to (oldest, mutation fallbacks):* "Failed to update project" · "Failed to
  create project" · "Failed to archive project" · "Failed to add keywords" · "Failed to
  save config" · "Failed to update config" · "Failed to start rank check" · "Failed to
  refresh keyword metrics" · "Failed to remove keywords"

**Error — validation (imperative, names the field):**
"Project name is required" · "Please enter a domain" · "Please enter a valid domain" ·
"Please select a city or region for local targeting" · "Select at least one keyword
first" · "No keywords to export" · "No data to export" · "Keywords must be 80 characters
or fewer." · "Clipboard not available"

**Info (status, no blame):**
"A rank check is already running" · "Use 'Check Now' to check these keywords" · "Not
enough data for this domain"

Errors from mutations always route through
`getStandardErrorMessage(error, "fallback...")` so coded server errors surface their
canonical sentence.

---

## 8. Confirmation copy

Modals confirm with a **question title naming the object**, one consequence sentence that
distinguishes destroyed vs preserved, then `Cancel` (ghost) + a labeled destructive
button that repeats the object:

```tsx
// features/saved-keywords/SavedKeywordsModals.tsx
<h3>Delete keywords?</h3>
<p>This will permanently delete {selectedCount} saved keyword{s}.</p>
// buttons: Cancel · Delete {n} keyword{s}   (btn-error, with count!)
```
```tsx
// features/rank-tracking/RankTrackingDomainList.tsx
<h3>Archive {archiveTarget.domain}?</h3>
<p>Scheduled checks will stop and this domain will be hidden from the
   list. Ranking history is preserved.</p>
// buttons: Cancel · Archive
```
Inline confirm (no modal) for project archive (`ProjectSettings.tsx`): "Archiving
**{name}** removes it from your workspace and stops its scheduled rank tracking. You can
restore it later from the Projects page." Buttons: `Yes, archive project` / `Cancel`.

Spend confirmation (`CheckConfirmModal.tsx`) is a *choice card*, not an OK dialog:
title "Check {n} keywords", math line, then a big option button (`Run Now` + time + cost)
and a small `Cancel`.

Post-action modal (`ExportToSheetsModal.tsx`): green check + "Copied {n} rows to your
clipboard" + next-step instruction "Open a new Google Sheet and paste to fill it." +
`Open new Google Sheet` button.

---

## 9. Stamps & footnotes

Bottom-of-card provenance stamps: `text-[11px] text-base-content/45`, **middot-separated
fragments, all lowercase after the source name**, rendered via `CardShell`'s `stamp` prop
(`cardParts.tsx`):
- "Google Search Console · last 28 days"
- `` `Site audit · crawled ${n} pages · ${formatDay(...)}` `` / "· crawl in progress" /
  "· last crawl failed"
- `` `Backlinks · snapshot ${formatDay(...)} · refreshing…` ``
- "Taking your first snapshot…"

Other footnote forms: "Updated {relative}" (`BrandLookupResults.tsx` BrandHeader);
"Connected by {email}" under the GSC property; "Fetched sample of prompts whose AI answer
cited **{target}** in its text or sources." (`BrandLookupCitationsCard.tsx`); page-bottom
feedback line on `/ai`: "Have feedback? Reach out on Discord or email ben@openseo.so."

Dates via `formatDay` → "Jun 12" (`month: "short", day: "numeric"`); audit list adds year.
Numbers: `toLocaleString()` for counts, `tabular-nums` class everywhere numerals column up,
`▲` / `▼` glyphs for deltas (`PercentDelta`, `BacklinkPulseCard`).

---

## 10. Progressive disclosure

- **`More details`** — the one and only card-level drill-in label, styled
  `moreDetailsClass = "btn btn-ghost btn-xs"` in the card header row, used by all three
  dashboard data cards (`cardParts.tsx`, `DashboardCards.tsx`). Behind it: the full
  feature page. Cards show 4 stats or top-3 issues, never more; overflow becomes
  "+ {n} more issue{s}" as a muted `<li>`.
- **`Collapsible`** (`features/ai-mcp/SetupControls.tsx`): title + optional muted
  subtitle ("Claude Code" / "Add with the CLI"), chevron-rotate, used for all setup
  guides so the page shows a menu of agents, not a wall of instructions.
- **Table expanders**: `` {expanded ? "Show less" : `+${remaining} more`} ``
  (`BrandLookupCitationTables.tsx`, `PromptExplorerResults.tsx`); long answers clamp with
  "Show less" (`MarkdownAnswer.tsx`).
- **Tooltips** carry the deep explanation so labels stay short: daisyUI `data-tip`
  ("Google reports one combined search volume for similar keywords…"), column-header
  `helpText` ("Estimated monthly prompt demand DataForSEO reports for this cited
  source…"), `title=` attr ("Lighthouse measures the performance of your pages and
  identifies issues.").
- Hover-reveal row actions: `opacity-0 group-hover:opacity-100`
  (`AuditHistorySection.tsx`, history rows' X buttons).

---

## 11. Punctuation & typography conventions

- **Em dash with spaces** for the pivot-to-benefit or aside: "…every card on this page
  starts working for it — backlinks and audits.", "Waiting for your first call — this
  card disappears once…", "Scheduled check skipped — insufficient credits".
- **Middot `·`** joins metadata fragments (stamps, row meta: "{location} · {devices} ·
  {schedule} · Last: {date}").
- **Curly quotes/apostrophes in JSX** via entities: `&rsquo;` `&apos;` `&ldquo;&rdquo;`
  (or literal `’` in string constants). Straight quotes only inside toast strings.
- Sentences in helper/empty copy end with periods; toasts, stamps, badges, buttons don't.
- Counts always pluralized inline with ternaries — never "(s)".
- `~` for estimates, `x` for multipliers ("2x credits", "~$0.85", "Results in ~45s").
- Product names exact: OpenSEO, Search Console / GSC, DataForSEO, Claude Code, Codex,
  Google AI Overview, Lighthouse, SAM (all-caps in-app agent; "Sam" in onboarding chat).

---

## 12. How "why" is explained (the persuasion pattern)

Every ask follows: **imperative verb + immediate concrete payoff**, ≤2 sentences, often
with an economic kicker:

- "Connect GSC to see how your website is actually performing in Google Search."
- "Your real queries and clicks, straight from Google."
- "Paste a competitor's domain to see what they rank for and who links to them."
- "Bring your real clicks, impressions, and rankings into OpenSEO and query them from
  Claude or Codex over MCP. It never uses credits."
- "OpenSEO is designed to give your AI agent the data it needs to build a great SEO
  strategy and help you execute it." + "This way you aren't limited on 'AI credits'."
- Even table empty-copy teaches: "No striking-distance queries in this period. These are
  queries ranking at positions 5 to 20, where an improvement is most likely to move
  traffic." (`SearchPerformanceParts.tsx`)

Never: "unlock powerful insights", "supercharge", "seamless", feature-adjective soup.
The word "powerful" appears nowhere in src/client.

---

## 13. THE 10 WRITING RULES

1. **Title Case only for page names and nav; sentence case for everything else** —
   card titles, buttons, modal titles, labels, badges. When in doubt, sentence case.
2. **Verb-first subhead under every h1**, one sentence, period, naming 2–3 concrete
   things the page shows ("Discover keyword ideas, search demand, and ranking
   opportunities.").
3. **Use contractions** ("you're", "we'll", "couldn't", "aren't") — prefer "Couldn't X"
   for new error copy; reserve "Failed to X" only as mutation fallback strings.
4. **Empty ≠ setup ≠ filtered.** Blank slate: dashed border + icon + "Enter a X to get
   started" (or "No X yet" + how to get the first one). Setup: solid card + benefit pitch
   + one primary CTA + status pill. Filtered: one line ending in a period, "No X match
   this filter." + reset affordance.
5. **Explain why in one benefit clause, not a paragraph** — imperative verb, concrete
   payoff, optionally an em-dash aside ("Set your project's domain and every card on this
   page starts working for it — backlinks and audits.").
6. **Show the money and the math**: real dollars with `~`, multipliers as "2x"/"7x",
   equations spelled out ("50 keywords × 2 devices = 100 SERP checks"). Costs go in
   `text-xs` helper text or the confirm dialog, never hidden.
7. **Toasts: success = terse past-tense noun phrase with counts** ("Saved 12 keywords",
   "Domain archived"); **errors name the failed thing + next step** ("Couldn't save the
   domain. Try again."); no periods on successes, no exclamation marks.
8. **Confirmations name the object and split the consequence**: question title
   ("Archive acme.com?"), one sentence saying what stops *and what's preserved*
   ("Ranking history is preserved."), destructive button repeats object and count
   ("Delete 3 keywords"), `Cancel` is always a ghost button.
9. **Loading is silent skeletons (`aria-busy`) at layout level, a gerund word at control
   level** ("Checking…", "Saving…", "Starting..."); long jobs narrate phases and counts
   ("Crawling pages", "34 / 120 pages"). Stale data stays visible with a small spinner.
10. **Stamp your data**: every data card footnotes source + window + freshness in
    `·`-separated lowercase fragments ("Google Search Console · last 28 days",
    "snapshot Jun 12 · refreshing…"); null metrics render "—", never disappear; known
    data lag is stated plainly ("Search Console data trails by a few days.").

---

## 14. PHRASE BANK — 15 verbatim lines that define the voice

Reuse these rhythms (not necessarily the words) when writing Opportunities/Articles/Receipts copy:

1. "Connect GSC to see how your website is actually performing in Google Search." — *setup pitch, benefit-first* (`SearchConsoleConnectionCard.tsx`)
2. "Set your project's domain and every card on this page starts working for it — backlinks and audits." — *coaching body, em-dash payoff* (`DashboardPage.tsx`)
3. "Your real queries and clicks, straight from Google." — *fragment as benefit line* (`DashboardPage.tsx`)
4. "We'll snapshot who links to your domain — nothing to set up." — *zero-config promise* (`DashboardCards.tsx`)
5. "One quick setup step" — *blocker reframed as small* (`AppShellParts.tsx`)
6. "Waiting for your first call — this card disappears once your agent talks to OpenSEO." — *UI narrating its own lifecycle* (`McpConnectCard.tsx`)
7. "No issues found — your site looks healthy." — *positive empty state* (`DashboardCards.tsx`)
8. "Not enough keyword data for this query yet" — *no-results headline: blames data, keeps hope with "yet"* (`KeywordResearchEmptyState.tsx`)
9. 'No rank data yet. Click "Check Now" to run your first check.' — *empty state that hands you the next action* (`RankTrackingTable.tsx`)
10. "Couldn't save the domain. Try again." — *error: object + next step, five words* (`DashboardPage.tsx`)
11. "Scheduled checks will stop and this domain will be hidden from the list. Ranking history is preserved." — *confirmation: what stops, what survives* (`RankTrackingDomainList.tsx`)
12. "Daily checks use 7x more credits than weekly" — *cost warning, concrete multiplier* (`RankTrackingConfigModal.tsx`)
13. "No data for this period yet. Search Console data trails by a few days." — *honest data-lag caveat* (`SearchPerformanceParts.tsx`)
14. "It never uses credits." — *economic kicker sentence* (`GscReEngagementModal.tsx`)
15. "We want to talk to you! We're super open to feedback and want to learn how you work so we can make OpenSEO better." — *the human register ceiling: support page only; product surfaces stay calmer than this* (`routes/_app/support.tsx`)
