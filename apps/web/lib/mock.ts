/** Demo dataset for the M2 UI shell: one fictional home-espresso site,
 * "Crema Notes" — the same fictional niche the engine's parity fixtures
 * use. Values are realistic for a ~8-month-old niche site. Every screen
 * reads ONLY from this module, so swapping in the live API later is a
 * one-file change. */

import type {
  AiVisibility, Article, AuditIssue, BacklinkItem, BacklinksSummary,
  ChatMessage, ChatThread, ChecklistItem, Competitor, DomainLookup,
  GapKeyword, KeywordRow, McpTool, OnboardingLine, OnboardingPlan,
  PagePerfRow, PositionBucket, Proposal, QueryPerfRow, ReceiptSeries,
  SettingsModel, SiteHealth, SiteSummary, SpendEntry, TrackedKeyword,
  TrafficPoint,
} from "./types";

export const site: SiteSummary = {
  id: "site_crema",
  name: "Crema Notes",
  domain: "cremanotes.example",
  trustDial: "titles",
  postsPerDay: 2,
  quotaOwedToday: 2,
  poolSlotReserved: true,
};

/** 28 days of GSC-style traffic, gently trending up with weekly rhythm. */
export const traffic: TrafficPoint[] = Array.from({ length: 28 }, (_, i) => {
  const day = new Date(Date.UTC(2026, 6, 3 + i)); // 2026-07-03 .. 2026-07-30
  const weekend = [0, 6].includes(day.getUTCDay()) ? 0.72 : 1;
  const impressions = Math.round((310 + i * 14) * weekend);
  const clicks = Math.round(impressions * (0.031 + i * 0.0006));
  return { date: day.toISOString().slice(0, 10), impressions, clicks };
});

export const trafficTotals = {
  impressions: traffic.reduce((s, p) => s + p.impressions, 0),
  clicks: traffic.reduce((s, p) => s + p.clicks, 0),
  avgPosition: 14.2,
  ctrPct: 3.6,
  impressionsDeltaPct: 42,
  clicksDeltaPct: 51,
};

export const proposals: Proposal[] = [
  {
    id: "p1", type: "write_new", target: "espresso puck screen worth it",
    title: "Are Puck Screens Worth It? What Changed in My Shots",
    score: 4.61, status: "proposed", category: "Guides", source: "unserved",
    createdAt: "2026-07-30",
    factors: [
      { name: "base", value: 2.46, note: "vol 720 · KD 18 · informational" },
      { name: "evidence", value: 1.25, note: "94 impressions in 28d with no page" },
      { name: "weakness", value: 1.3, note: "3 forum results in top-10" },
      { name: "clusterNeed", value: 1.15, note: "accessories cluster at 40% coverage" },
    ],
    evidence: [
      { label: "GSC · 94 impr/28d · no page", kind: "gsc" },
      { label: "vol 720 · KD 18", kind: "volume" },
      { label: "SERP: 3 forums in top-10", kind: "serp" },
    ],
  },
  {
    id: "p2", type: "write_new", target: "breville bambino vs gaggia classic",
    title: "Bambino vs Gaggia Classic: I Owned Both for a Year",
    score: 4.22, status: "proposed", category: "Compare", source: "gap",
    createdAt: "2026-07-30",
    factors: [
      { name: "base", value: 3.19, note: "vol 2900 · KD 34 · commercial" },
      { name: "gap", value: 1.15, note: "espressotoolbox.example ranks #3, we are absent" },
      { name: "weakness", value: 1.15, note: "1 forum + 1 aged post in top-10" },
    ],
    evidence: [
      { label: "gap: espressotoolbox.example #3", kind: "gap" },
      { label: "vol 2900 · KD 34", kind: "volume" },
    ],
  },
  {
    id: "p3", type: "retitle", target: "/blog/best-espresso-tampers/",
    title: "Retitle: page ranks #6 but CTR is 1.1% (expected 3.0%)",
    score: 3.9, status: "proposed", category: "Lists", source: "ctr-deficit",
    createdAt: "2026-07-29",
    factors: [
      { name: "base", value: 3.12, note: "1.9k impr/28d at pos 6.3" },
      { name: "proximity", value: 1.25, note: "already page one — title is the bottleneck" },
    ],
    evidence: [
      { label: "GSC · pos 6.3 · 1.9k impr", kind: "gsc" },
      { label: "CTR 1.1% vs 3.0% expected", kind: "gsc" },
    ],
  },
  {
    id: "p4", type: "write_new", target: "why does my espresso taste salty",
    title: "Why Does Espresso Taste Salty? (It's Not the Water)",
    score: 1.4, status: "proposed", category: "Guides", source: "pool",
    createdAt: "2026-07-30",
    factors: [
      { name: "base", value: 1.4, note: "harvested question · neutral prior, no metrics" },
    ],
    evidence: [
      { label: "r/espresso · 41 comments", kind: "pool" },
      { label: "pool slot: real pain beats no metrics", kind: "pool" },
    ],
  },
  {
    id: "p5", type: "push", target: "/blog/dial-in-espresso-grinder/",
    title: "Push: 'grinder dial in chart' sits at #11 — add 3 internal links",
    score: 3.4, status: "approved", category: "Guides", source: "page2",
    createdAt: "2026-07-28",
    factors: [
      { name: "base", value: 1.94, note: "vol 480 · KD 22" },
      { name: "proximity", value: 1.5, note: "pos 11 — one push from page one" },
      { name: "evidence", value: 1.25, note: "210 impr/28d" },
    ],
    evidence: [
      { label: "GSC · pos 11 · 210 impr", kind: "gsc" },
      { label: "3 strong pages can link in", kind: "cluster" },
    ],
  },
  {
    id: "p6", type: "refresh", target: "/blog/espresso-ratio-guide/",
    title: "Refresh: clicks down 38% from peak over 4 weeks",
    score: 3.1, status: "proposed", category: "Guides", source: "decay",
    createdAt: "2026-07-27",
    factors: [
      { name: "base", value: 2.48, note: "was top-5 for 'espresso ratio' cluster" },
      { name: "proximity", value: 1.25, note: "still pos 8 — recoverable" },
    ],
    evidence: [
      { label: "clicks: 122/wk → 76/wk", kind: "decay" },
      { label: "2 fresher competitors above", kind: "serp" },
    ],
  },
  {
    id: "p7", type: "merge", target: "/blog/espresso-grind-size/ + /blog/grind-settings-espresso/",
    title: "Cannibalization: two pages trade positions for 'espresso grind size'",
    score: 2.8, status: "proposed", category: "Guides", source: "page2",
    createdAt: "2026-07-26",
    factors: [
      { name: "base", value: 2.8, note: "both pages get impressions; neither holds top-10" },
    ],
    evidence: [
      { label: "both pages seen for query · pos 9-14", kind: "gsc" },
      { label: "human decision required", kind: "cluster" },
    ],
  },
  {
    id: "p8", type: "write_new", target: "flair 58 water debris fix",
    title: "Flair 58 Dripping From the Piston? The 10-Minute Fix",
    score: 2.9, status: "declined", category: "Guides", source: "unserved",
    createdAt: "2026-07-25",
    factors: [
      { name: "base", value: 2.32, note: "vol 90 · KD 8 · informational" },
      { name: "evidence", value: 1.25, note: "31 impr/28d" },
    ],
    evidence: [{ label: "GSC · 31 impr/28d", kind: "gsc" }],
  },
];

export const articles: Article[] = [
  {
    id: "a1", slug: "puck-screens-worth-it",
    title: "Are Puck Screens Worth It? What Changed in My Shots",
    description: "I ran 40 shots with and without a puck screen. Here is what actually changed, and what did not.",
    keyword: "espresso puck screen worth it", category: "Guides", status: "writing",
    wordCount: 0, attempts: 0, lawReport: [], excerpt: "", publishedAt: null,
    publishedUrl: null, receipts: null, costUsd: 0.04,
  },
  {
    id: "a2", slug: "bambino-vs-gaggia-classic",
    title: "Bambino vs Gaggia Classic: I Owned Both for a Year",
    description: "Twelve months with each machine. Where the Bambino wins, where the Gaggia holds up, and who should buy which.",
    keyword: "breville bambino vs gaggia classic", category: "Compare", status: "gate",
    wordCount: 1840, attempts: 2,
    lawReport: [
      { law: "em dash", ok: true },
      { law: "word count >= 850", ok: true },
      { law: "h2 sections >= 4", ok: true },
      { law: "faq entries >= 3", ok: true },
      { law: "internal links >= 2", ok: false, detail: "links to /blog/gaggia-mods/ which does not exist" },
      { law: "no filler AI phrases", ok: false, detail: "\"game-changer\" in section 3" },
      { law: "first-person experience", ok: true },
      { law: "keyword density <= 2.5%", ok: true },
    ],
    excerpt: "I bought the Bambino first, and for eight months I thought the Gaggia crowd was romanticizing hardware...",
    publishedAt: null, publishedUrl: null, receipts: null, costUsd: 0.31,
  },
  {
    id: "a3", slug: "58mm-vs-54mm-portafilter",
    title: "58mm vs 54mm Portafilters: What Actually Transfers",
    description: "Basket geometry, accessory ecosystems, and whether the 4mm matter in the cup.",
    keyword: "58mm vs 54mm portafilter", category: "Compare", status: "review",
    wordCount: 1620, attempts: 1,
    lawReport: [
      { law: "em dash", ok: true }, { law: "word count >= 850", ok: true },
      { law: "h2 sections >= 4", ok: true }, { law: "faq entries >= 3", ok: true },
      { law: "internal links >= 2", ok: true }, { law: "no filler AI phrases", ok: true },
      { law: "first-person experience", ok: true }, { law: "keyword density <= 2.5%", ok: true },
    ],
    excerpt: "The 54mm basket gets treated like a compromise, and for two years I repeated that line myself. Then I measured...",
    publishedAt: null, publishedUrl: null, receipts: null, costUsd: 0.22,
  },
  {
    id: "a4", slug: "espresso-preinfusion-explained",
    title: "Pre-Infusion, Explained With a Pressure Gauge",
    description: "What pre-infusion actually does to extraction, measured on a modified machine.",
    keyword: "what is preinfusion espresso", category: "Guides", status: "published",
    wordCount: 1490, attempts: 1,
    lawReport: [
      { law: "em dash", ok: true }, { law: "word count >= 850", ok: true },
      { law: "h2 sections >= 4", ok: true }, { law: "faq entries >= 3", ok: true },
      { law: "internal links >= 2", ok: true }, { law: "no filler AI phrases", ok: true },
      { law: "first-person experience", ok: true }, { law: "keyword density <= 2.5%", ok: true },
    ],
    excerpt: "My machine has a gauge most machines hide, and it changed how I think about the first eight seconds of every shot...",
    publishedAt: "2026-07-08", publishedUrl: "https://cremanotes.example/blog/espresso-preinfusion-explained/",
    receipts: {
      targetQuery: "what is preinfusion espresso",
      positionBefore: null, positionAfter: 6.8,
      impressionsDelta: 840, clicksDelta: 44,
    },
    costUsd: 0.27,
  },
  {
    id: "a5", slug: "espresso-tastes-sour-fixes",
    title: "Espresso Tastes Sour: The Fix Order That Works",
    description: "Sourness has four causes. Fix them in this order and stop wasting beans.",
    keyword: "espresso tastes sour", category: "Guides", status: "published",
    wordCount: 1210, attempts: 3,
    lawReport: [
      { law: "em dash", ok: true }, { law: "word count >= 850", ok: true },
      { law: "h2 sections >= 4", ok: true }, { law: "faq entries >= 3", ok: true },
      { law: "internal links >= 2", ok: true }, { law: "no filler AI phrases", ok: true },
      { law: "first-person experience", ok: true }, { law: "keyword density <= 2.5%", ok: true },
    ],
    excerpt: "Sour espresso is under-extracted espresso, but that sentence never helped anyone at 7am. Here is the order I check...",
    publishedAt: "2026-07-15", publishedUrl: "https://cremanotes.example/blog/espresso-tastes-sour-fixes/",
    receipts: {
      targetQuery: "espresso tastes sour",
      positionBefore: 12.4, positionAfter: 4.1,
      impressionsDelta: 620, clicksDelta: 58,
    },
    costUsd: 0.44,
  },
  {
    id: "a6", slug: "wdt-tools-comparison",
    title: "I Tested 5 WDT Tools on the Same Puck",
    description: "Needle count, gauge and handle ergonomics: what mattered across 50 distribution tests.",
    keyword: "best wdt tool", category: "Lists", status: "failed",
    wordCount: 640, attempts: 3,
    lawReport: [
      { law: "word count >= 850", ok: false, detail: "640 words after 3 attempts" },
      { law: "faq entries >= 3", ok: false, detail: "2 FAQ entries" },
      { law: "first-person experience", ok: true },
    ],
    excerpt: "Weiss Distribution Technique tools multiplied faster than anyone needed...",
    publishedAt: null, publishedUrl: null, receipts: null, costUsd: 0.58,
  },
];

export const keywords: KeywordRow[] = [
  { keyword: "best espresso grinder under 300", volume: 1900, difficulty: 28, intent: "commercial", score: 5.12, source: "dataforseo", status: "approved", category: "Lists" },
  { keyword: "espresso puck screen worth it", volume: 720, difficulty: 18, intent: "informational", score: 4.61, source: "gsc", status: "proposed", category: "Guides" },
  { keyword: "breville bambino vs gaggia classic", volume: 2900, difficulty: 34, intent: "commercial", score: 4.22, source: "dataforseo", status: "proposed", category: "Compare" },
  { keyword: "how to dial in espresso", volume: 880, difficulty: 15, intent: "informational", score: 4.9, source: "dataforseo", status: "published", category: "Guides" },
  { keyword: "grinder dial in chart", volume: 480, difficulty: 22, intent: "informational", score: 3.4, source: "gsc", status: "approved", category: "Guides" },
  { keyword: "why does my espresso taste salty", volume: null, difficulty: null, intent: null, score: 1.4, source: "reddit", status: "proposed", category: "Guides" },
  { keyword: "espresso ratio calculator", volume: 1300, difficulty: 31, intent: "informational", score: 3.9, source: "dataforseo", status: "discovered", category: "Data" },
  { keyword: "flair 58 water debris fix", volume: 90, difficulty: 8, intent: "informational", score: 2.9, source: "gsc", status: "skipped", category: "Guides" },
  { keyword: "single dose grinder pros cons", volume: 590, difficulty: 21, intent: "informational", score: 3.7, source: "autocomplete", status: "discovered", category: "Guides" },
  { keyword: "espresso bar pressure explained", volume: 260, difficulty: 12, intent: "informational", score: 3.2, source: "autocomplete", status: "discovered", category: "Guides" },
  { keyword: "58mm vs 54mm portafilter", volume: 640, difficulty: 19, intent: "informational", score: 4.05, source: "dataforseo", status: "queued", category: "Compare" },
  { keyword: "how long do espresso machines last", volume: 720, difficulty: 24, intent: "informational", score: 3.55, source: "autocomplete", status: "discovered", category: "Guides" },
  { keyword: "what is preinfusion espresso", volume: 410, difficulty: 14, intent: "informational", score: 3.8, source: "dataforseo", status: "published", category: "Guides" },
  { keyword: "espresso distribution tools compared", volume: 170, difficulty: 9, intent: "commercial", score: 2.95, source: "stackexchange", status: "discovered", category: "Lists" },
  { keyword: "cheap espresso setup reddit", volume: 1000, difficulty: 26, intent: "commercial", score: 3.6, source: "autocomplete", status: "discovered", category: "Lists" },
];

export const competitors: Competitor[] = [
  { domain: "espressotoolbox.example", intersections: 214, avgPosition: 8.2, keywordCount: 1830, tracked: true },
  { domain: "thecoffeecompass.example", intersections: 156, avgPosition: 11.6, keywordCount: 4210, tracked: true },
  { domain: "baristahq.example", intersections: 98, avgPosition: 9.9, keywordCount: 12400, tracked: false },
  { domain: "homebrewlab.example", intersections: 61, avgPosition: 14.3, keywordCount: 760, tracked: false },
];

export const gapKeywords: GapKeyword[] = [
  { keyword: "breville bambino vs gaggia classic", volume: 2900, difficulty: 34, competitorDomain: "espressotoolbox.example", competitorPosition: 3, intent: "commercial" },
  { keyword: "espresso machine descaling guide", volume: 1600, difficulty: 22, competitorDomain: "thecoffeecompass.example", competitorPosition: 5, intent: "informational" },
  { keyword: "bottomless portafilter spraying", volume: 880, difficulty: 16, competitorDomain: "espressotoolbox.example", competitorPosition: 2, intent: "informational" },
  { keyword: "espresso scale with timer", volume: 1300, difficulty: 29, competitorDomain: "thecoffeecompass.example", competitorPosition: 7, intent: "commercial" },
  { keyword: "flow control gaggia worth it", volume: 320, difficulty: 13, competitorDomain: "espressotoolbox.example", competitorPosition: 4, intent: "commercial" },
  { keyword: "espresso water recipe", volume: 990, difficulty: 27, competitorDomain: "thecoffeecompass.example", competitorPosition: 6, intent: "informational" },
];

export const backlinksSummary: BacklinksSummary = {
  backlinks: 412, referringDomains: 87, rank: 142, brokenBacklinks: 6,
  newLast30d: 14, lostLast30d: 5,
};

export const backlinks: BacklinkItem[] = [
  { sourceUrl: "https://coffeeforums.example/t/puck-prep-megathread", targetUrl: "https://cremanotes.example/blog/wdt-tools-comparison/", anchor: "this WDT comparison", dofollow: true, firstSeen: "2026-07-24", lost: false },
  { sourceUrl: "https://morningbrew.example/links-we-liked", targetUrl: "https://cremanotes.example/blog/espresso-tastes-sour-fixes/", anchor: "fix order that works", dofollow: true, firstSeen: "2026-07-19", lost: false },
  { sourceUrl: "https://baristahq.example/roundup-july", targetUrl: "https://cremanotes.example/", anchor: "Crema Notes", dofollow: false, firstSeen: "2026-07-12", lost: false },
  { sourceUrl: "https://old-blog.example/espresso-links", targetUrl: "https://cremanotes.example/blog/espresso-ratio-guide/", anchor: "ratio guide", dofollow: true, firstSeen: "2026-05-02", lost: true },
];

export const receiptSeries: ReceiptSeries[] = [
  {
    articleId: "a5", articleTitle: "Espresso Tastes Sour: The Fix Order That Works",
    targetQuery: "espresso tastes sour", publishedAt: "2026-07-15",
    impressionsDelta: 620, clicksDelta: 58,
    points: [
      { date: "2026-07-01", position: 12.8 }, { date: "2026-07-04", position: 12.1 },
      { date: "2026-07-07", position: 12.6 }, { date: "2026-07-10", position: 12.2 },
      { date: "2026-07-13", position: 12.4 }, { date: "2026-07-16", position: 10.8 },
      { date: "2026-07-19", position: 8.9 }, { date: "2026-07-22", position: 6.7 },
      { date: "2026-07-25", position: 5.2 }, { date: "2026-07-28", position: 4.3 },
      { date: "2026-07-30", position: 4.1 },
    ],
  },
  {
    articleId: "a4", articleTitle: "Pre-Infusion, Explained With a Pressure Gauge",
    targetQuery: "what is preinfusion espresso", publishedAt: "2026-07-08",
    impressionsDelta: 840, clicksDelta: 44,
    points: [
      { date: "2026-07-01", position: null }, { date: "2026-07-04", position: null },
      { date: "2026-07-07", position: null }, { date: "2026-07-10", position: 34.0 },
      { date: "2026-07-13", position: 21.5 }, { date: "2026-07-16", position: 14.2 },
      { date: "2026-07-19", position: 11.0 }, { date: "2026-07-22", position: 9.4 },
      { date: "2026-07-25", position: 7.9 }, { date: "2026-07-28", position: 7.1 },
      { date: "2026-07-30", position: 6.8 },
    ],
  },
];

export const spend: SpendEntry[] = [
  { provider: "dataforseo", monthUsd: 6.4, budgetUsd: 25 },
  { provider: "llm", monthUsd: 8.1, budgetUsd: 40 },
  { provider: "image", monthUsd: 1.2, budgetUsd: 10 },
];

export const settings: SettingsModel = {
  site: { name: "Crema Notes", url: "https://cremanotes.example", mode: "html", blogPath: "blog" },
  taxonomy: { Guides: "guides", Compare: "compare", Lists: "lists", Data: "data" },
  trustDial: "titles",
  postsPerDay: 2,
  catchupCap: 6,
  laws: [
    { name: "word count", value: "850 – 4500" },
    { name: "H2 sections", value: "≥ 4" },
    { name: "FAQ entries", value: "≥ 3" },
    { name: "internal links", value: "≥ 2, must resolve" },
    { name: "em dashes", value: "banned" },
    { name: "first person", value: "required" },
    { name: "keyword density", value: "≤ 2.5%" },
    { name: "banned phrases", value: "15 defaults" },
  ],
  integrations: {
    gscConnected: true, gscProperty: "sc-domain:cremanotes.example",
    adapter: "wordpress", adapterDetail: "cremanotes.example/wp-json (connected)",
    dataforseoKeySet: true, aiProvider: "anthropic", aiKeySet: true,
  },
  budgets: { dataforseoUsd: 25, llmUsd: 40 },
};

export const onboardingScript: OnboardingLine[] = [
  { text: "Fetching https://cremanotes.example ...", kind: "info" },
  { text: "Reading homepage + 6 key pages", kind: "info" },
  { text: "This is a home-espresso publication: gear reviews, technique guides, measured tests", kind: "finding" },
  { text: "Voice: first person, measured claims, numbers over adjectives (\"I ran 40 shots\", \"12 months with each\")", kind: "finding" },
  { text: "Design tokens: cream background #faf6f0, espresso-brown accent #4a2c1a, serif display headings", kind: "finding" },
  { text: "Existing blog: 34 posts under /blog/, JSON-LD BlogPosting on every page", kind: "metric" },
  { text: "Connecting Search Console (read-only) ...", kind: "info" },
  { text: "You appear for 412 queries · 28-day impressions 9,840 · 14 queries sit at positions 5-20", kind: "metric" },
  { text: "Unserved demand found: 9 queries with impressions and no page (e.g. \"espresso puck screen worth it\", 94 impr)", kind: "finding" },
  { text: "Pulling competitor overlap from DataForSEO Labs ...", kind: "info" },
  { text: "Top overlap: espressotoolbox.example (214 shared keywords) · thecoffeecompass.example (156)", kind: "metric" },
  { text: "Keyword gap: 61 keywords competitors rank top-10 for within your difficulty ceiling (KD ≤ 32)", kind: "metric" },
  { text: "Existing posts measured: median 1,340 words, 5 H2s, FAQ on 80% — laws calibrated so all 34 posts pass", kind: "finding" },
  { text: "No deploy command detected — publish adapter needs your choice (WordPress REST detected as likely)", kind: "warn" },
];

export const onboardingPlan: OnboardingPlan = {
  voiceCard: [
    "First person, working-practitioner: \"I measured\", \"in my testing\", never \"we here at\"",
    "Numbers over adjectives; every claim testable or hedged honestly",
    "Short declarative sentences carry the weight; no marketing cadence",
    "Credit competitors fairly; \"it depends\" is a publishable answer",
  ],
  taxonomy: [
    { category: "Guides", hub: "guides", note: "technique + troubleshooting (your strongest cluster)" },
    { category: "Compare", hub: "compare", note: "X vs Y — highest commercial intent" },
    { category: "Lists", hub: "lists", note: "tested roundups only, never untested listicles" },
    { category: "Data", hub: "data", note: "measured tables: pressures, ratios, dimensions" },
  ],
  clusters: [
    { name: "dialing in / technique", seedCount: 22, note: "core authority cluster, 68% covered" },
    { name: "machine comparisons", seedCount: 18, note: "gap-driven: competitors own this" },
    { name: "accessories", seedCount: 14, note: "40% covered, high affiliate potential" },
    { name: "troubleshooting", seedCount: 16, note: "harvest-fed, low competition" },
  ],
  cadence: "2 posts/day with catch-up (cap 6) · weekly improve pass · news watch on 3 vendor feeds",
  laws: [
    { name: "word_min", value: "850", calibratedFrom: "shortest good existing post: 890" },
    { name: "h2_min", value: "4", calibratedFrom: "site median: 5" },
    { name: "faq_min", value: "3", calibratedFrom: "80% of posts have FAQ" },
    { name: "internal_links_min", value: "2", calibratedFrom: "site median: 3" },
  ],
};

// ---------- read-side feature screens (OpenSEO parity) ----------

export const checklist: ChecklistItem[] = [
  { label: "Connect Search Console", done: true, href: "/settings", detail: "sc-domain:cremanotes.example · read-only" },
  { label: "Choose a publish adapter", done: true, href: "/settings", detail: "WordPress REST connected" },
  { label: "Add your AI key", done: true, href: "/settings", detail: "Anthropic · budget-capped" },
  { label: "Approve your first titles", done: false, href: "/opportunities", detail: "6 proposals waiting with evidence" },
];

export const searchQueries: QueryPerfRow[] = [
  { query: "espresso tastes sour", impressions: 1480, clicks: 96, ctrPct: 6.5, position: 4.1, deltaPos7d: -1.1, page: "/blog/espresso-tastes-sour-fixes/", signal: null },
  { query: "best espresso tampers", impressions: 1900, clicks: 21, ctrPct: 1.1, position: 6.3, deltaPos7d: 0.2, page: "/blog/best-espresso-tampers/", signal: "ctr-deficit" },
  { query: "what is preinfusion espresso", impressions: 1240, clicks: 58, ctrPct: 4.7, position: 6.8, deltaPos7d: -0.3, page: "/blog/espresso-preinfusion-explained/", signal: null },
  { query: "grinder dial in chart", impressions: 210, clicks: 4, ctrPct: 1.9, position: 11.0, deltaPos7d: -0.5, page: "/blog/dial-in-espresso-grinder/", signal: "page2" },
  { query: "espresso puck screen worth it", impressions: 94, clicks: 0, ctrPct: 0, position: 14.2, deltaPos7d: 0.8, page: "/blog/espresso-accessories-guide/", signal: "unserved" },
  { query: "espresso ratio calculator", impressions: 320, clicks: 9, ctrPct: 2.8, position: 8.4, deltaPos7d: 0.1, page: "/blog/espresso-ratio-guide/", signal: null },
  { query: "how to dial in espresso", impressions: 860, clicks: 41, ctrPct: 4.8, position: 5.2, deltaPos7d: -0.2, page: "/blog/dial-in-espresso-grinder/", signal: null },
  { query: "flair 58 water debris fix", impressions: 31, clicks: 0, ctrPct: 0, position: 18.9, deltaPos7d: 1.4, page: "/blog/flair-58-maintenance/", signal: "unserved" },
  { query: "espresso grind size chart", impressions: 540, clicks: 12, ctrPct: 2.2, position: 9.6, deltaPos7d: 0.4, page: "/blog/espresso-grind-size/", signal: "page2" },
  { query: "wdt tool worth it", impressions: 260, clicks: 11, ctrPct: 4.2, position: 7.3, deltaPos7d: -0.9, page: "/blog/wdt-tools-comparison/", signal: null },
  { query: "crema notes espresso", impressions: 120, clicks: 64, ctrPct: 53.3, position: 1.1, deltaPos7d: 0, page: "/", signal: null },
  { query: "espresso machine descaling", impressions: 410, clicks: 3, ctrPct: 0.7, position: 15.8, deltaPos7d: 0.6, page: "/blog/espresso-maintenance/", signal: "page2" },
];

export const searchPages: PagePerfRow[] = [
  { page: "/blog/espresso-tastes-sour-fixes/", impressions: 2140, clicks: 118, ctrPct: 5.5, position: 4.9 },
  { page: "/blog/best-espresso-tampers/", impressions: 1960, clicks: 23, ctrPct: 1.2, position: 6.4 },
  { page: "/blog/espresso-preinfusion-explained/", impressions: 1385, clicks: 61, ctrPct: 4.4, position: 7.0 },
  { page: "/blog/dial-in-espresso-grinder/", impressions: 1120, clicks: 47, ctrPct: 4.2, position: 6.8 },
  { page: "/blog/espresso-ratio-guide/", impressions: 690, clicks: 18, ctrPct: 2.6, position: 8.9 },
  { page: "/blog/espresso-grind-size/", impressions: 585, clicks: 13, ctrPct: 2.2, position: 10.1 },
  { page: "/blog/wdt-tools-comparison/", impressions: 310, clicks: 12, ctrPct: 3.9, position: 7.8 },
  { page: "/", impressions: 290, clicks: 71, ctrPct: 24.5, position: 2.3 },
];

export const positionBuckets: PositionBucket[] = [
  { bucket: "1-3", queries: 18 },
  { bucket: "4-10", queries: 96 },
  { bucket: "11-20", queries: 141 },
  { bucket: "21-50", queries: 122 },
  { bucket: "51+", queries: 35 },
];

const trackPts = (vals: (number | null)[]): { date: string; position: number | null }[] =>
  vals.map((position, i) => ({
    date: new Date(Date.UTC(2026, 6, 3 + i * 3)).toISOString().slice(0, 10),
    position,
  }));

export const trackedKeywords: TrackedKeyword[] = [
  { keyword: "espresso tastes sour", addedAt: "2026-07-15", source: "receipt", position: 4.1, bestPosition: 4.1, delta7d: -1.1, points: trackPts([12.8, 12.1, 12.6, 12.4, 10.8, 8.9, 6.7, 5.2, 4.3, 4.1]) },
  { keyword: "what is preinfusion espresso", addedAt: "2026-07-08", source: "receipt", position: 6.8, bestPosition: 6.8, delta7d: -0.3, points: trackPts([null, null, 34.0, 21.5, 14.2, 11.0, 9.4, 7.9, 7.1, 6.8]) },
  { keyword: "best espresso grinder under 300", addedAt: "2026-07-02", source: "manual", position: 23.4, bestPosition: 21.0, delta7d: 1.2, points: trackPts([28.1, 26.0, 24.4, 22.9, 21.0, 21.8, 22.5, 23.0, 23.1, 23.4]) },
  { keyword: "how to dial in espresso", addedAt: "2026-07-02", source: "manual", position: 5.2, bestPosition: 4.8, delta7d: -0.2, points: trackPts([6.8, 6.5, 6.1, 5.9, 5.6, 5.4, 5.5, 5.3, 5.2, 5.2]) },
  { keyword: "espresso grind size chart", addedAt: "2026-07-10", source: "manual", position: 9.6, bestPosition: 9.2, delta7d: 0.4, points: trackPts([13.2, 12.4, 11.8, 11.0, 10.4, 9.9, 9.2, 9.4, 9.5, 9.6]) },
  { keyword: "58mm vs 54mm portafilter", addedAt: "2026-07-22", source: "receipt", position: 31.0, bestPosition: 31.0, delta7d: -4.0, points: trackPts([null, null, null, null, null, null, 48.0, 39.0, 35.0, 31.0]) },
];

export const domainLookup: DomainLookup = {
  domain: "espressotoolbox.example",
  domainRank: 46,
  organicKeywords: 1830,
  estMonthlyTraffic: 24600,
  topKeywords: [
    { keyword: "breville bambino vs gaggia classic", position: 3, volume: 2900, difficulty: 34, url: "/compare/bambino-vs-gaggia", intent: "commercial" },
    { keyword: "bottomless portafilter spraying", position: 2, volume: 880, difficulty: 16, url: "/guides/bottomless-portafilter", intent: "informational" },
    { keyword: "best espresso machine under 500", position: 5, volume: 6600, difficulty: 41, url: "/lists/best-machines-500", intent: "commercial" },
    { keyword: "gaggia classic mods", position: 1, volume: 1900, difficulty: 22, url: "/guides/gaggia-mods", intent: "informational" },
    { keyword: "flow control gaggia worth it", position: 4, volume: 320, difficulty: 13, url: "/guides/flow-control", intent: "commercial" },
    { keyword: "espresso machine descaling guide", position: 6, volume: 1600, difficulty: 22, url: "/guides/descaling", intent: "informational" },
    { keyword: "9 bar vs 15 bar espresso", position: 7, volume: 720, difficulty: 18, url: "/guides/pressure", intent: "informational" },
    { keyword: "espresso scale with timer", position: 8, volume: 1300, difficulty: 29, url: "/lists/scales", intent: "commercial" },
  ],
};

export const siteHealth: SiteHealth = {
  postsChecked: 34,
  lawsPassRate: 94,
  indexationRate: 88,
  indexedCohort: "28/32",
  quotaThrottled: false,
  brokenInternalLinks: 2,
  medianWordCount: 1340,
  issues: [
    { severity: "error", kind: "laws", detail: "internal link resolves nowhere: /blog/gaggia-mods/", page: "/blog/bambino-vs-gaggia-classic/", action: "fix in review queue" },
    { severity: "error", kind: "laws", detail: "banned phrase \"game-changer\" in section 3", page: "/blog/bambino-vs-gaggia-classic/", action: "fix in review queue" },
    { severity: "warn", kind: "indexation", detail: "Crawled — currently not indexed (12 days)", page: "/blog/espresso-water-hardness/", action: "watching · throttles quota below 65%" },
    { severity: "warn", kind: "indexation", detail: "Discovered — currently not indexed", page: "/blog/dosing-funnel-review/", action: "watching" },
    { severity: "warn", kind: "content", detail: "readability drifting (FK 12.1, ease 48.2)", page: "/blog/espresso-extraction-science/", action: null },
    { severity: "info", kind: "prune", detail: "3 impressions in 8 months since publish", page: "/blog/espresso-cup-preheating/", action: "PRUNE candidate (human review)" },
    { severity: "info", kind: "schema", detail: "FAQ present but not mirrored in FAQPage JSON-LD", page: "/blog/wdt-tools-comparison/", action: null },
  ],
};

export const aiVisibility: AiVisibility = {
  llmsTxt: true,
  llmsFullTxt: true,
  agentHits28d: 4830,
  topAgents: [
    { agent: "GPTBot", hits28d: 1920 },
    { agent: "ClaudeBot", hits28d: 1410 },
    { agent: "PerplexityBot", hits28d: 860 },
    { agent: "Google-Extended", hits28d: 640 },
  ],
  mentions: [
    { prompt: "why does my espresso taste sour", engine: "Perplexity", mentioned: true, cited: true, snippet: "According to Crema Notes, sourness has four causes checked in order…" },
    { prompt: "best espresso tamper", engine: "ChatGPT", mentioned: true, cited: false, snippet: "Sources include roundups from Crema Notes and others…" },
    { prompt: "what is preinfusion", engine: "Google AI Overview", mentioned: true, cited: true, snippet: "Pre-infusion wets the puck at low pressure (Crema Notes)…" },
    { prompt: "bambino vs gaggia classic", engine: "Perplexity", mentioned: false, cited: false, snippet: null },
    { prompt: "espresso grind size guide", engine: "ChatGPT", mentioned: false, cited: false, snippet: null },
  ],
};

export const mcpTools: McpTool[] = [
  { name: "rankloop_status", description: "Backlog, spend and GSC pulse for a site" },
  { name: "rankloop_pick", description: "Top-scored proposals + the fresh-question pool slot" },
  { name: "rankloop_brief", description: "Grounded writer brief for a keyword (SERP, PAA, laws, links)" },
  { name: "rankloop_check", description: "Run the publish laws over the corpus; violations as data" },
  { name: "rankloop_approve", description: "Approve or decline a proposal by id" },
  { name: "rankloop_quota", description: "Posts owed today (catch-up semantics)" },
  { name: "rankloop_receipts", description: "Position deltas for published articles" },
  { name: "rankloop_wire", description: "Regenerate sitemap, RSS, llms.txt, llms-full.txt" },
];

export const chatThreads: ChatThread[] = [
  { id: "t1", title: "Why did impressions drop this week?", active: true },
  { id: "t2", title: "Plan the accessories cluster", active: false },
  { id: "t3", title: "Which posts should I prune?", active: false },
];

export const chatMessages: ChatMessage[] = [
  { role: "user", text: "Why did impressions drop this week?" },
  { role: "assistant", text: "They didn't drop overall — impressions are +9% week over week (2,940 → 3,210). What you're seeing is one page: /blog/best-espresso-tampers/ lost ~180 impressions after slipping 6.1 → 6.8 on \"best espresso tampers\". Two things worth knowing:\n\n1. That page is already in your Opportunities queue as a RETITLE (CTR 1.1% vs 3.0% expected at its position) — approving it addresses the click side.\n2. The slip coincides with a fresher competitor page (published Jul 24). Your post's modified date is 4 months old; a REFRESH proposal would fire if the decline holds 3 weeks (decay guard).\n\nNothing else moved beyond noise. The receipts for your two July articles are both still climbing." },
  { role: "user", text: "ok, approve the retitle" },
  { role: "assistant", text: "Done — RETITLE for /blog/best-espresso-tampers/ is approved and queued. It only touches the <title> and meta description (body and publish date stay), and its receipt will measure CTR delta at the same position band, evaluation window days 14–42. I'll surface it in Receipts once measured." },
];

/** tiny helpers the screens share */
export function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}
export function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}
