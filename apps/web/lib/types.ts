/** UI-facing types for the M2 demo shell. These mirror the shapes the real
 * API will serve from @rankloop/db + the intelligence layer — screens built
 * against them should survive the swap from mock to live data. */

export type ProposalType = "write_new" | "retitle" | "refresh" | "push" | "merge";
export type ProposalStatus = "proposed" | "approved" | "declined" | "executing" | "done" | "measured";
export type ArticleStatus = "writing" | "gate" | "review" | "published" | "failed";
export type TrustDial = "titles" | "drafts" | "autopilot";

export interface SiteSummary {
  id: string;
  name: string;
  domain: string;
  trustDial: TrustDial;
  postsPerDay: number;
  quotaOwedToday: number;
  poolSlotReserved: boolean;
}

export interface TrafficPoint {
  date: string; // ISO
  impressions: number;
  clicks: number;
}

export interface EvidenceChip {
  /** e.g. "GSC · pos 11", "620 impr/28d", "gap: rival.example #4", "SERP: 3 forums" */
  label: string;
  kind: "gsc" | "volume" | "gap" | "serp" | "pool" | "cluster" | "decay";
}

export interface ScoreFactor {
  name: string;   // "base", "proximity", "evidence", "gap", "weakness", "clusterNeed"
  value: number;  // the multiplier (base carries the raw base score)
  note: string;   // human explanation
}

export interface Proposal {
  id: string;
  type: ProposalType;
  /** keyword for write_new; page path for retitle/refresh/push/merge */
  target: string;
  title: string; // proposed article title or action summary
  score: number;
  factors: ScoreFactor[];
  evidence: EvidenceChip[];
  status: ProposalStatus;
  category: string;
  source: string; // "unserved" | "gap" | "page2" | "pool" | "cluster" | "decay" | "ctr-deficit" | "news"
  createdAt: string;
}

export interface LawCheck {
  law: string;
  ok: boolean;
  detail?: string;
}

export interface ArticleReceipts {
  targetQuery: string;
  positionBefore: number | null;
  positionAfter: number | null;
  impressionsDelta: number;
  clicksDelta: number;
}

export interface Article {
  id: string;
  slug: string;
  title: string;
  description: string;
  keyword: string;
  category: string;
  status: ArticleStatus;
  wordCount: number;
  attempts: number;
  lawReport: LawCheck[];
  excerpt: string; // first paragraphs, plain text
  publishedAt: string | null;
  publishedUrl: string | null;
  receipts: ArticleReceipts | null;
  costUsd: number; // llm + serp spend attributed to this article
}

export interface KeywordRow {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  intent: string | null;
  score: number;
  source: string; // dataforseo | autocomplete | stackexchange | reddit | gsc | manual
  status: string; // discovered | proposed | approved | queued | published | skipped
  category: string;
}

export interface Competitor {
  domain: string;
  intersections: number;
  avgPosition: number;
  keywordCount: number;
  tracked: boolean;
}

export interface GapKeyword {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  competitorDomain: string;
  competitorPosition: number;
  intent: string | null;
}

export interface BacklinksSummary {
  backlinks: number;
  referringDomains: number;
  rank: number;
  brokenBacklinks: number;
  newLast30d: number;
  lostLast30d: number;
}

export interface BacklinkItem {
  sourceUrl: string;
  targetUrl: string;
  anchor: string;
  dofollow: boolean;
  firstSeen: string;
  lost: boolean;
}

export interface PositionPoint {
  date: string;
  position: number | null;
}

export interface ReceiptSeries {
  articleId: string;
  articleTitle: string;
  targetQuery: string;
  publishedAt: string;
  points: PositionPoint[]; // spans pre-publish baseline through today
  impressionsDelta: number;
  clicksDelta: number;
}

export interface SpendEntry {
  provider: "dataforseo" | "llm" | "image";
  monthUsd: number;
  budgetUsd: number;
}

export interface SettingsModel {
  site: { name: string; url: string; mode: "html" | "markdown"; blogPath: string };
  taxonomy: Record<string, string>;
  trustDial: TrustDial;
  postsPerDay: number;
  catchupCap: number;
  laws: { name: string; value: string }[];
  integrations: {
    gscConnected: boolean;
    gscProperty: string;
    adapter: "wordpress" | "webhook" | "git" | "none";
    adapterDetail: string;
    dataforseoKeySet: boolean;
    aiProvider: "anthropic" | "openai" | "openrouter";
    aiKeySet: boolean;
  };
  budgets: { dataforseoUsd: number; llmUsd: number };
}

// ---------- read-side feature screens (OpenSEO parity) ----------

export interface QueryPerfRow {
  query: string;
  impressions: number;
  clicks: number;
  ctrPct: number;
  position: number;
  deltaPos7d: number; // negative = improved (moved toward #1)
  page: string;
  /** which pipeline signal this row would feed, if any */
  signal: "unserved" | "page2" | "ctr-deficit" | null;
}

export interface PagePerfRow {
  page: string;
  impressions: number;
  clicks: number;
  ctrPct: number;
  position: number;
}

export interface PositionBucket {
  bucket: "1-3" | "4-10" | "11-20" | "21-50" | "51+";
  queries: number;
}

export interface TrackedKeyword {
  keyword: string;
  addedAt: string;
  source: "receipt" | "manual";
  position: number;
  bestPosition: number;
  delta7d: number; // negative = improved
  points: PositionPoint[];
}

export interface DomainRankedKeyword {
  keyword: string;
  position: number;
  volume: number | null;
  difficulty: number | null;
  url: string;
  intent: string | null;
}

export interface DomainLookup {
  domain: string;
  domainRank: number;
  organicKeywords: number;
  estMonthlyTraffic: number;
  topKeywords: DomainRankedKeyword[];
}

export interface AuditIssue {
  severity: "error" | "warn" | "info";
  kind: string;
  detail: string;
  page: string;
  action: string | null; // proposal it maps to, e.g. "PRUNE candidate"
}

export interface SiteHealth {
  postsChecked: number;
  lawsPassRate: number; // %
  indexationRate: number; // %
  indexedCohort: string; // "28/32"
  quotaThrottled: boolean;
  brokenInternalLinks: number;
  medianWordCount: number;
  issues: AuditIssue[];
}

export interface AgentHits {
  agent: string;
  hits28d: number;
}

export interface AiMention {
  prompt: string;
  engine: string;
  mentioned: boolean;
  cited: boolean;
  snippet: string | null;
}

export interface AiVisibility {
  llmsTxt: boolean;
  llmsFullTxt: boolean;
  agentHits28d: number;
  topAgents: AgentHits[];
  mentions: AiMention[];
}

export interface McpTool {
  name: string;
  description: string;
}

export interface ChatThread {
  id: string;
  title: string;
  active: boolean;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

export interface ChecklistItem {
  label: string;
  done: boolean;
  href: string;
  detail: string;
}

export interface OnboardingLine {
  /** streamed study log line */
  text: string;
  kind: "info" | "finding" | "metric" | "warn";
}

export interface OnboardingPlan {
  voiceCard: string[];
  taxonomy: { category: string; hub: string; note: string }[];
  clusters: { name: string; seedCount: number; note: string }[];
  cadence: string;
  laws: { name: string; value: string; calibratedFrom: string }[];
}
