import { createStep, createWorkflow } from "@mastra/core/workflows";
import {
  buildDigestTool,
  deliverDigestTool,
  fetchMessagesTool,
  resolveDigestInputTool,
  summarizeMessagesTool,
  workflowInputSchema,
  workflowOutputSchema
} from "../tools/digestTools.js";

const resolveInputStep = createStep(resolveDigestInputTool);
const fetchMessagesStep = createStep(fetchMessagesTool);
const summarizeStep = createStep(summarizeMessagesTool);
const buildDigestStep = createStep(buildDigestTool);
const deliverStep = createStep(deliverDigestTool);

export const digestWorkflow = createWorkflow({
  id: "digest-workflow",
  inputSchema: workflowInputSchema,
  outputSchema: workflowOutputSchema
})
  .then(resolveInputStep)
  .then(fetchMessagesStep)
  .then(summarizeStep)
  .then(buildDigestStep)
  .then(deliverStep)
  .commit();
