import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { instrumentMcpToolHandler } from "@/server/mcp/instrumentation";
import { getBacklinksOverviewTool } from "@/server/mcp/tools/get-backlinks-overview";
import { getBacklinksProfileTool } from "@/server/mcp/tools/get-backlinks-profile";
import { getDomainKeywordSuggestionsTool } from "@/server/mcp/tools/get-domain-keyword-suggestions";
import { getDomainOverviewTool } from "@/server/mcp/tools/get-domain-overview";
import { getRankTrackerTool } from "@/server/mcp/tools/get-rank-tracker";
import { getSerpResultsTool } from "@/server/mcp/tools/get-serp-results";
import { createProjectTool } from "@/server/mcp/tools/create-project";
import { listProjectsTool } from "@/server/mcp/tools/list-projects";
import { listSavedKeywordsTool } from "@/server/mcp/tools/list-saved-keywords";
import {
  findSerpCompetitorsTool,
  getGoogleBusinessQuestionsTool,
  getKeywordMetricsTool,
  getLocalSerpResultsTool,
  getRankedKeywordsTool,
  searchLocalBusinessesTool,
} from "@/server/mcp/tools/dataforseo-research-tools";
import {
  rankloopProposalsTool,
  rankloopReceiptsTool,
  rankloopStatusTool,
} from "@/server/mcp/tools/rankloop-tools";
import {
  rankloopBriefTool,
  rankloopCheckTool,
  rankloopPublishReportTool,
} from "@/server/mcp/tools/rankloop-writer-tools";
import { researchKeywordsTool } from "@/server/mcp/tools/research-keywords";
import { saveKeywordsTool } from "@/server/mcp/tools/save-keywords";
import {
  getSearchConsolePerformanceTool,
  inspectUrlsTool,
} from "@/server/mcp/tools/search-console-tools";
import {
  getAuditIssuesTool,
  getAuditPagesTool,
  getAuditStatusTool,
  runSiteAuditTool,
} from "@/server/mcp/tools/site-audit-tools";
import { whoamiTool } from "@/server/mcp/tools/whoami";

// Each handler is wrapped with instrumentMcpToolHandler so failures reach
// PostHog — the MCP route has no error middleware of its own. Tools are
// registered one explicit call at a time (not via a loop/helper) so each one's
// input/output schema types stay concrete, which the SDK's registerTool
// generics require to type the handler callback.
export function registerOpenSeoMcpTools(server: McpServer) {
  server.registerTool(
    whoamiTool.name,
    whoamiTool.config,
    instrumentMcpToolHandler(
      whoamiTool.name,
      whoamiTool.config.outputSchema,
      whoamiTool.handler,
    ),
  );
  server.registerTool(
    listProjectsTool.name,
    listProjectsTool.config,
    instrumentMcpToolHandler(
      listProjectsTool.name,
      listProjectsTool.config.outputSchema,
      listProjectsTool.handler,
    ),
  );
  server.registerTool(
    createProjectTool.name,
    createProjectTool.config,
    instrumentMcpToolHandler(
      createProjectTool.name,
      createProjectTool.config.outputSchema,
      createProjectTool.handler,
    ),
  );
  server.registerTool(
    listSavedKeywordsTool.name,
    listSavedKeywordsTool.config,
    instrumentMcpToolHandler(
      listSavedKeywordsTool.name,
      listSavedKeywordsTool.config.outputSchema,
      listSavedKeywordsTool.handler,
    ),
  );
  server.registerTool(
    researchKeywordsTool.name,
    researchKeywordsTool.config,
    instrumentMcpToolHandler(
      researchKeywordsTool.name,
      researchKeywordsTool.config.outputSchema,
      researchKeywordsTool.handler,
    ),
  );
  server.registerTool(
    saveKeywordsTool.name,
    saveKeywordsTool.config,
    instrumentMcpToolHandler(
      saveKeywordsTool.name,
      saveKeywordsTool.config.outputSchema,
      saveKeywordsTool.handler,
    ),
  );
  server.registerTool(
    getDomainOverviewTool.name,
    getDomainOverviewTool.config,
    instrumentMcpToolHandler(
      getDomainOverviewTool.name,
      getDomainOverviewTool.config.outputSchema,
      getDomainOverviewTool.handler,
    ),
  );
  server.registerTool(
    getDomainKeywordSuggestionsTool.name,
    getDomainKeywordSuggestionsTool.config,
    instrumentMcpToolHandler(
      getDomainKeywordSuggestionsTool.name,
      getDomainKeywordSuggestionsTool.config.outputSchema,
      getDomainKeywordSuggestionsTool.handler,
    ),
  );
  server.registerTool(
    getBacklinksOverviewTool.name,
    getBacklinksOverviewTool.config,
    instrumentMcpToolHandler(
      getBacklinksOverviewTool.name,
      getBacklinksOverviewTool.config.outputSchema,
      getBacklinksOverviewTool.handler,
    ),
  );
  server.registerTool(
    getBacklinksProfileTool.name,
    getBacklinksProfileTool.config,
    instrumentMcpToolHandler(
      getBacklinksProfileTool.name,
      getBacklinksProfileTool.config.outputSchema,
      getBacklinksProfileTool.handler,
    ),
  );
  server.registerTool(
    getSerpResultsTool.name,
    getSerpResultsTool.config,
    instrumentMcpToolHandler(
      getSerpResultsTool.name,
      getSerpResultsTool.config.outputSchema,
      getSerpResultsTool.handler,
    ),
  );
  server.registerTool(
    getRankTrackerTool.name,
    getRankTrackerTool.config,
    instrumentMcpToolHandler(
      getRankTrackerTool.name,
      getRankTrackerTool.config.outputSchema,
      getRankTrackerTool.handler,
    ),
  );
  server.registerTool(
    getRankedKeywordsTool.name,
    getRankedKeywordsTool.config,
    instrumentMcpToolHandler(
      getRankedKeywordsTool.name,
      getRankedKeywordsTool.config.outputSchema,
      getRankedKeywordsTool.handler,
    ),
  );
  server.registerTool(
    findSerpCompetitorsTool.name,
    findSerpCompetitorsTool.config,
    instrumentMcpToolHandler(
      findSerpCompetitorsTool.name,
      findSerpCompetitorsTool.config.outputSchema,
      findSerpCompetitorsTool.handler,
    ),
  );
  server.registerTool(
    searchLocalBusinessesTool.name,
    searchLocalBusinessesTool.config,
    instrumentMcpToolHandler(
      searchLocalBusinessesTool.name,
      searchLocalBusinessesTool.config.outputSchema,
      searchLocalBusinessesTool.handler,
    ),
  );
  server.registerTool(
    getLocalSerpResultsTool.name,
    getLocalSerpResultsTool.config,
    instrumentMcpToolHandler(
      getLocalSerpResultsTool.name,
      getLocalSerpResultsTool.config.outputSchema,
      getLocalSerpResultsTool.handler,
    ),
  );
  server.registerTool(
    getGoogleBusinessQuestionsTool.name,
    getGoogleBusinessQuestionsTool.config,
    instrumentMcpToolHandler(
      getGoogleBusinessQuestionsTool.name,
      getGoogleBusinessQuestionsTool.config.outputSchema,
      getGoogleBusinessQuestionsTool.handler,
    ),
  );
  server.registerTool(
    getKeywordMetricsTool.name,
    getKeywordMetricsTool.config,
    instrumentMcpToolHandler(
      getKeywordMetricsTool.name,
      getKeywordMetricsTool.config.outputSchema,
      getKeywordMetricsTool.handler,
    ),
  );
  server.registerTool(
    getSearchConsolePerformanceTool.name,
    getSearchConsolePerformanceTool.config,
    instrumentMcpToolHandler(
      getSearchConsolePerformanceTool.name,
      getSearchConsolePerformanceTool.config.outputSchema,
      getSearchConsolePerformanceTool.handler,
    ),
  );
  server.registerTool(
    inspectUrlsTool.name,
    inspectUrlsTool.config,
    instrumentMcpToolHandler(
      inspectUrlsTool.name,
      inspectUrlsTool.config.outputSchema,
      inspectUrlsTool.handler,
    ),
  );
  server.registerTool(
    runSiteAuditTool.name,
    runSiteAuditTool.config,
    instrumentMcpToolHandler(
      runSiteAuditTool.name,
      runSiteAuditTool.config.outputSchema,
      runSiteAuditTool.handler,
    ),
  );
  server.registerTool(
    getAuditStatusTool.name,
    getAuditStatusTool.config,
    instrumentMcpToolHandler(
      getAuditStatusTool.name,
      getAuditStatusTool.config.outputSchema,
      getAuditStatusTool.handler,
    ),
  );
  server.registerTool(
    getAuditIssuesTool.name,
    getAuditIssuesTool.config,
    instrumentMcpToolHandler(
      getAuditIssuesTool.name,
      getAuditIssuesTool.config.outputSchema,
      getAuditIssuesTool.handler,
    ),
  );
  server.registerTool(
    getAuditPagesTool.name,
    getAuditPagesTool.config,
    instrumentMcpToolHandler(
      getAuditPagesTool.name,
      getAuditPagesTool.config.outputSchema,
      getAuditPagesTool.handler,
    ),
  );
  // The rankloop agent path (spec 0023), in the order an agent walks it:
  // status → proposals → brief → check → publish report, with receipts as the
  // answer to "did any of that work".
  server.registerTool(
    rankloopStatusTool.name,
    rankloopStatusTool.config,
    instrumentMcpToolHandler(
      rankloopStatusTool.name,
      rankloopStatusTool.config.outputSchema,
      rankloopStatusTool.handler,
    ),
  );
  server.registerTool(
    rankloopProposalsTool.name,
    rankloopProposalsTool.config,
    instrumentMcpToolHandler(
      rankloopProposalsTool.name,
      rankloopProposalsTool.config.outputSchema,
      rankloopProposalsTool.handler,
    ),
  );
  server.registerTool(
    rankloopBriefTool.name,
    rankloopBriefTool.config,
    instrumentMcpToolHandler(
      rankloopBriefTool.name,
      rankloopBriefTool.config.outputSchema,
      rankloopBriefTool.handler,
    ),
  );
  server.registerTool(
    rankloopCheckTool.name,
    rankloopCheckTool.config,
    instrumentMcpToolHandler(
      rankloopCheckTool.name,
      rankloopCheckTool.config.outputSchema,
      rankloopCheckTool.handler,
    ),
  );
  server.registerTool(
    rankloopPublishReportTool.name,
    rankloopPublishReportTool.config,
    instrumentMcpToolHandler(
      rankloopPublishReportTool.name,
      rankloopPublishReportTool.config.outputSchema,
      rankloopPublishReportTool.handler,
    ),
  );
  server.registerTool(
    rankloopReceiptsTool.name,
    rankloopReceiptsTool.config,
    instrumentMcpToolHandler(
      rankloopReceiptsTool.name,
      rankloopReceiptsTool.config.outputSchema,
      rankloopReceiptsTool.handler,
    ),
  );
}
