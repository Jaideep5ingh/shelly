import { Mastra } from "@mastra/core";

import { digestCoordinatorAgent, newsletterSummarizerAgent } from "./agents/digestAgents.js";
import {
  buildDigestTool,
  deliverDigestTool,
  fetchMessagesTool,
  resolveDigestInputTool,
  summarizeMessagesTool
} from "./tools/digestTools.js";
import { digestWorkflow } from "./workflows/digestWorkflow.js";

export const mastra = new Mastra({
  agents: {
    digestCoordinatorAgent,
    newsletterSummarizerAgent
  },
  tools: {
    resolveDigestInputTool,
    fetchMessagesTool,
    summarizeMessagesTool,
    buildDigestTool,
    deliverDigestTool
  },
  workflows: {
    digestWorkflow
  }
});
