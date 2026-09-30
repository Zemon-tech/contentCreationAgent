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
import { agent } from './agents/agent';
import { aggregatorAgent } from './agents/aggregatorAgent';
import { imageGenAgent } from './agents/imageGenAgent';
import { fluxOutputRoute } from './lib/flux-output-route';
import { startScheduleTool, stopScheduleTool } from './tools/schedule-tools';
import { findSimilarContentTool, generateEmbeddingTool } from './tools/analysis-tools';
import {
  extractArticleContentTool,
  fetchGitHubReleasesTool,
  fetchRSSTool,
  fetchWebPageTool,
} from './tools/fetch-tools';
import { exaScrapeTool, exaSearchTool } from './tools/exa-tools';
import { searchNewsAndCreatePostTool,
    createPostFromContentTool } from './tools/design-tools';
import { generateCoverPromptTool } from './tools/cover-tools';
import { generateAnglePackTool } from './tools/angle-tools';
import { getCurrentTimeTool } from './tools/time-tools';
import { sweepSourcesTool } from './tools/sweep-tools';
import {
  fetchReferenceImageTool,
  generateFluxImageTool,
  savePastedImageTool,
  useInboxReferencesTool,
} from './tools/flux-tools';
import {
  getIndustryConfigTool,
  getSourceRegistryTool,
  saveContentOpportunityTool,
  saveNormalizedContentTool,
  saveRawContentTool,
  saveSourcesTool,
  saveStoriesTool,
  saveStoryTool,
} from './tools/industry-tools';
import { industryAggregationWorkflow } from './workflows/industryAggregationWorkflow';
import { newsToPostWorkflow } from './workflows/newsToPostWorkflow';

export const mastra = new Mastra({
  bundler: {
    externals: ['@duckdb/node-bindings'],
  },
  server: {
    // Serves rendered Flux images so they display inline in Studio chat.
    apiRoutes: [fluxOutputRoute],
  },
  agents: { agent, aggregatorAgent, imageGenAgent },
  workflows: { industryAggregationWorkflow, newsToPostWorkflow },
  tools: {
    startScheduleTool,
    stopScheduleTool,
    fetchRSSTool,
    fetchWebPageTool,
    fetchGitHubReleasesTool,
    extractArticleContentTool,
    exaSearchTool,
    exaScrapeTool,
    searchNewsAndCreatePostTool,
    createPostFromContentTool,
    generateCoverPromptTool,
    generateAnglePackTool,
    getCurrentTimeTool,
    sweepSourcesTool,
    generateEmbeddingTool,
    findSimilarContentTool,
    getIndustryConfigTool,
    getSourceRegistryTool,
    saveRawContentTool,
    saveNormalizedContentTool,
    saveSourcesTool,
    saveStoryTool,
    saveStoriesTool,
    saveContentOpportunityTool,
    savePastedImageTool,
    useInboxReferencesTool,
    fetchReferenceImageTool,
    generateFluxImageTool,
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
