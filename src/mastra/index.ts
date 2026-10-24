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
import { imageGenAgent } from './agents/imageGenAgent';
import { icpJudgeAgent } from './agents/icpJudgeAgent';
import { rasDesignAgent } from './agents/rasDesignAgent';
import { rankScoringAgent } from './agents/rankScoringAgent';

import { fluxOutputRoute } from './lib/flux-output-route';
import { postAssetRoute } from './routes/post-assets';
import { rasAssetRoute } from './routes/ras-assets';
import { rasPublishRoute } from './routes/ras-publish';

import {
  extractArticleContentTool,
  fetchGitHubReleasesTool,
  fetchRSSTool,
  fetchWebPageTool,
} from './tools/fetch-tools';
import { exaScrapeTool, exaSearchTool } from './tools/exa-tools';
import {
  searchNewsAndCreatePostTool,
  createPostFromContentTool,
  renderPostFromApprovedStoryTool,
} from './tools/design-tools';
import { generateCoverPromptTool } from './tools/cover-tools';
import { generateAnglePackTool } from './tools/angle-tools';
import {
  listPendingNewsTool,
  approveNewsStoryTool,
  rejectNewsStoryTool,
} from './tools/editorial-tools';
import {
  checkInstagramConnectionTool,
  publishToInstagramTool,
  publishDesignJobToInstagramTool,
  publishStoryToInstagramTool,
} from './tools/instagram-tools';
import {
  checkXSessionTool,
  launchXBrowserTool,
  measureXLimitTool,
  publishToXTool,
  directNewsToXTool,
  publishApprovedStoryToXTool,
  scrapeXPostsTool,
} from './tools/x-tools';
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
  saveStoriesTool,
} from './tools/industry-tools';
import { renderRasStoryTool, renderRasCarouselTool } from './tools/ras-render-tools';
import { publishRasToInstagramTool } from './tools/ras-instagram-tool';

import { industryAggregationWorkflow } from './workflows/industryAggregationWorkflow';
import { autoNewsToRasWorkflow } from './workflows/autoNewsToRasWorkflow';
import { newsToPostWorkflow } from './workflows/newsToPostWorkflow';
import { newsToXWorkflow } from './workflows/newsToXWorkflow';
import { companyResearchWorkflow } from './workflows/companyResearchWorkflow';
import { leadQualificationWorkflow } from './workflows/leadQualificationWorkflow';

export const mastra = new Mastra({
  bundler: {
    externals: ['@duckdb/node-bindings'],
  },
  server: {
    // postAssetRoute: Design Agent slides; fluxOutputRoute: Flux.2 renders.
    // Both let images display inline in Studio chat.
    apiRoutes: [postAssetRoute, fluxOutputRoute, rasAssetRoute, rasPublishRoute],
  },
  agents: { aggregatorAgent, imageGenAgent, icpJudgeAgent, rasDesignAgent, rankScoringAgent },
  workflows: {
    industryAggregationWorkflow,
    autoNewsToRasWorkflow,
    newsToPostWorkflow,
    newsToXWorkflow,
    leadQualificationWorkflow,
    companyResearchWorkflow,
  },
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
    searchNewsAndCreatePostTool,
    createPostFromContentTool,
    generateCoverPromptTool,
    generateAnglePackTool,
    checkInstagramConnectionTool,
    publishToInstagramTool,
    publishDesignJobToInstagramTool,
    publishStoryToInstagramTool,
    checkXSessionTool,
    launchXBrowserTool,
    measureXLimitTool,
    publishToXTool,
    directNewsToXTool,
    publishApprovedStoryToXTool,
    scrapeXPostsTool,
    fetchRSSTool,
    fetchWebPageTool,
    fetchGitHubReleasesTool,
    extractArticleContentTool,
    savePastedImageTool,
    useInboxReferencesTool,
    fetchReferenceImageTool,
    generateFluxImageTool,
    renderRasStoryTool,
    renderRasCarouselTool,
    publishRasToInstagramTool,
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
