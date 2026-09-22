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
import { startScheduleTool, stopScheduleTool } from './tools/schedule-tools';
import { findSimilarContentTool, generateEmbeddingTool } from './tools/analysis-tools';
import {
  extractArticleContentTool,
  fetchGitHubReleasesTool,
  fetchRSSTool,
  fetchWebPageTool,
} from './tools/fetch-tools';
import { exaScrapeTool, exaSearchTool } from './tools/exa-tools';
import { getCurrentTimeTool } from './tools/time-tools';
import { sweepSourcesTool } from './tools/sweep-tools';
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

export const mastra = new Mastra({
  bundler: {
    externals: ['@duckdb/node-bindings'],
  },
  agents: { agent, aggregatorAgent },
  workflows: { industryAggregationWorkflow },
  tools: {
    startScheduleTool,
    stopScheduleTool,
    fetchRSSTool,
    fetchWebPageTool,
    fetchGitHubReleasesTool,
    extractArticleContentTool,
    exaSearchTool,
    exaScrapeTool,
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
