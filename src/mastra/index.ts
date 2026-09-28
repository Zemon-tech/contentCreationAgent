import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { DuckDBStore } from '@mastra/duckdb';
import { MastraCompositeStore } from '@mastra/core/storage';
import {
  MastraStorageExporter,
  MastraPlatformExporter,
  Observability,
  SensitiveDataFilter,
} from '@mastra/observability';

import { aggregatorAgent } from './agents/aggregatorAgent';
import {
  extractArticleContentTool,
  fetchGitHubReleasesTool,
  fetchRSSTool,
  fetchWebPageTool,
} from './tools/fetch-tools';
import { exaScrapeTool, exaSearchTool } from './tools/exa-tools';
import {
  createPostFromContentTool,
  renderPostFromApprovedStoryTool,
} from './tools/design-tools';
import {
  listPendingNewsTool,
  approveNewsStoryTool,
  rejectNewsStoryTool,
} from './tools/editorial-tools';
import { getCurrentTimeTool } from './tools/time-tools';
import { sweepSourcesTool } from './tools/sweep-tools';
import {
  getIndustryConfigTool,
  getSourceRegistryTool,
  saveContentOpportunityTool,
  saveStoriesTool,
} from './tools/industry-tools';
import { industryAggregationWorkflow } from './workflows/industryAggregationWorkflow';
import { postAssetRoute } from './routes/post-assets';

export const mastra = new Mastra({
  bundler: {
    externals: ['@duckdb/node-bindings'],
  },
  server: {
    apiRoutes: [postAssetRoute],
  },
  agents: { aggregatorAgent },
  workflows: { industryAggregationWorkflow },
  tools: {
    sweepSourcesTool,
    exaSearchTool,
    exaScrapeTool,
    getCurrentTimeTool,
    getIndustryConfigTool,
    getSourceRegistryTool,
    saveStoriesTool,
    saveContentOpportunityTool,
    listPendingNewsTool,
    approveNewsStoryTool,
    rejectNewsStoryTool,
    renderPostFromApprovedStoryTool,
    createPostFromContentTool,
    fetchRSSTool,
    fetchWebPageTool,
    fetchGitHubReleasesTool,
    extractArticleContentTool,
  },
  storage: new MastraCompositeStore({
    id: 'composite-storage',
    default: new LibSQLStore({
      id: 'mastra-storage',
      url: process.env.TURSO_DATABASE_URL || 'file:./mastra.db',
      authToken: process.env.TURSO_AUTH_TOKEN || undefined,
    }),
    domains: {
      observability: await new DuckDBStore().getStore('observability'),
    },
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [new MastraStorageExporter(), new MastraPlatformExporter()],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
});
