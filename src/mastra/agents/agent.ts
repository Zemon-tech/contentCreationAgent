import { pathToFileURL } from 'node:url';
import { Agent } from '@mastra/core/agent';
import { TaskSignalProvider } from '@mastra/core/signals';
import { askUserTool, webFetchTool } from '@mastra/core/tools';
import { LocalFilesystem, LocalSandbox, WORKSPACE_TOOLS, Workspace } from '@mastra/core/workspace';
import { Memory } from '@mastra/memory';
import { startScheduleTool, stopScheduleTool } from '../tools/schedule-tools';
import { exaScrapeTool, exaSearchTool } from '../tools/exa-tools';
import { searchNewsAndCreatePostTool } from '../tools/design-tools';
import { resolveChatModel, resolveSmallChatModel } from '../config/model';

const workspacePath = 'workspace';

const workspace = new Workspace({
  id: 'agent-workspace',
  name: 'Agent Workspace',
  filesystem: new LocalFilesystem({
    basePath: workspacePath,
  }),
  sandbox: new LocalSandbox({
    workingDirectory: workspacePath,
  }),
  tools: {
    [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: {
      requireReadBeforeWrite: true,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: {
      requireReadBeforeWrite: true,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: {
      requireApproval: true,
    },
  },
});

export const agent = new Agent({
  id: 'agent',
  name: 'Agent',
  description:
    'A general-purpose assistant that can research, manage tasks, work with local files, run approved commands, create recurring schedules, and turn news stories into visual Instagram posts.',
  metadata: {
    suggestedPrompts: [
      "Search news about OpenAI and create an Instagram post",
      "What's the weather in Austin this weekend?",
      "What's the SPCX stock price right now?",
      'Build a Japanese sakura festival landing page.',
    ],
  },
  instructions: `You are a friendly starter agent for exploring what Mastra can do. Help the user try useful capabilities, build small projects, answer current questions, and shape this harness into a starting point for future work.

Suggested prompts: Search news about OpenAI and create an Instagram post; Get the weather forecast for your city; Create a Japanese Sakura festival page.

When the user asks you to search news and create an Instagram post:
1. ALWAYS check if they specified their preferred post format ('single' slide or 'carousel') and template.
2. If they have NOT explicitly specified whether they prefer a single slide or carousel (or template), ask them or use the ask_user tool before proceeding!
   - Formats: 'single' (1 high-impact slide) or 'carousel' (multi-slide story deck).
   - Templates: 'tech-announcement' (default for tech news), 'keilhq-editorial' (editorial reflections), 'keilhq-text' (clean typography), or 'entrepreneur-post'.
3. Once confirmed, invoke the search_news_and_create_post tool with the topic, format, and template.
4. When finished, present the headline, full caption, hashtags, and the file paths to the generated slides in the workspace.

When the user greets you or does not have a specific task, invite them to try the suggested prompts.

Ask concise questions when something is unclear or a good question could surface a useful insight.

For local file changes, end with a plain-text URL using ${pathToFileURL(`${workspacePath}/`).href}; avoid Markdown links, localhost, /workspace, relative paths, and static-file servers.
`,
  model: resolveChatModel(),
  defaultOptions: {
    maxSteps: 100,
    autoResumeSuspendedTools: true,
    // See aggregatorAgent: Sarvam reasoning shares the completion budget.
    modelSettings: { maxOutputTokens: 4000 },
  },
  memory: new Memory({
    options: {
      generateTitle: true,
      observationalMemory: {
        model: resolveSmallChatModel(),
      },
    },
  }),
  workspace,
  tools: {
    ask_user: askUserTool,
    start_schedule: startScheduleTool,
    stop_schedule: stopScheduleTool,
    web_fetch: webFetchTool,
    // NOTE: Mastra's built-in webSearchTool only resolves for
    // OpenAI/Anthropic/Google/xAI models — it throws for OpenAI-compatible
    // providers like local-vllm/Sarvam. Exa tools below are the
    // provider-independent replacement.
    exa_search: exaSearchTool,
    exa_scrape: exaScrapeTool,
    search_news_and_create_post: searchNewsAndCreatePostTool,
  },
  signals: [new TaskSignalProvider()],
});
