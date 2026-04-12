import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { AgentmailClient } from "../../agentmailClient.js";
import { applyAiSummaries } from "../../aiSummarizer.js";
import { loadConfig } from "../../config.js";
import { dateForTimezone, normalizeDateInput } from "../../dateUtils.js";
import { buildDigest } from "../../digestBuilder.js";
import { sendDigestEmail } from "../../emailSender.js";
import type { Digest, NewsletterItem } from "../../types.js";

interface DigestPipelineState {
  dateLabel: string;
  dryRun: boolean;
  messages: NewsletterItem[];
  digest?: Digest;
}

const pipelineStateStore = new Map<string, DigestPipelineState>();

function getPipelineState(stateId: string): DigestPipelineState {
  const state = pipelineStateStore.get(stateId);
  if (!state) {
    throw new Error(`Pipeline state not found for stateId: ${stateId}`);
  }
  return state;
}

export const workflowInputSchema = z.object({
  date: z.string().optional(),
  dryRun: z.boolean().optional()
});

export const resolvedInputSchema = z.object({
  stateId: z.string(),
  dateLabel: z.string(),
  dryRun: z.boolean()
});

export const messagesSchema = z.object({
  stateId: z.string(),
  dateLabel: z.string(),
  dryRun: z.boolean(),
  totalMessages: z.number().int().nonnegative()
});

export const digestSchema = z.object({
  stateId: z.string(),
  dateLabel: z.string(),
  dryRun: z.boolean(),
  totalItems: z.number().int().nonnegative()
});

export const workflowOutputSchema = z.object({
  status: z.enum(["sent", "dry-run"]),
  target: z.string(),
  totalItems: z.number(),
  dateLabel: z.string()
});

export const resolveDigestInputTool = createTool({
  id: "resolve-digest-input",
  description: "Resolve digest date and dry-run mode from input and config.",
  inputSchema: workflowInputSchema,
  outputSchema: resolvedInputSchema,
  execute: async (inputData) => {
    const config = loadConfig();
    const dateLabel = inputData.date ? normalizeDateInput(inputData.date) : dateForTimezone(config.digestTimezone);
    const dryRun = inputData.dryRun ?? config.digestDryRun;
    const stateId = randomUUID();

    pipelineStateStore.set(stateId, {
      dateLabel,
      dryRun,
      messages: []
    });

    return {
      stateId,
      dateLabel,
      dryRun
    };
  }
});

export const fetchMessagesTool = createTool({
  id: "fetch-messages",
  description: "Fetch received newsletter messages from AgentMail for a specific date.",
  inputSchema: resolvedInputSchema,
  outputSchema: messagesSchema,
  execute: async (inputData) => {
    const config = loadConfig();
    const client = new AgentmailClient(config);
    const messages = await client.fetchMessagesForDate(inputData.dateLabel);
    const state = getPipelineState(inputData.stateId);
    state.messages = messages;

    return {
      stateId: inputData.stateId,
      dateLabel: inputData.dateLabel,
      dryRun: inputData.dryRun,
      totalMessages: messages.length
    };
  }
});

export const summarizeMessagesTool = createTool({
  id: "summarize-messages",
  description: "Summarize all fetched newsletter messages using the local Ollama model.",
  inputSchema: messagesSchema,
  outputSchema: messagesSchema,
  execute: async (inputData) => {
    const state = getPipelineState(inputData.stateId);
    const config = loadConfig();
    state.messages = await applyAiSummaries(config, state.messages);

    return {
      stateId: inputData.stateId,
      dateLabel: inputData.dateLabel,
      dryRun: inputData.dryRun,
      totalMessages: state.messages.length
    };
  }
});

export const buildDigestTool = createTool({
  id: "build-digest",
  description: "Build HTML and text digest from summarized newsletter messages.",
  inputSchema: messagesSchema,
  outputSchema: digestSchema,
  execute: async (inputData) => {
    const state = getPipelineState(inputData.stateId);
    const config = loadConfig();
    const digest = buildDigest(inputData.dateLabel, state.messages, config.digestMaxItems);
    state.digest = digest;

    return {
      stateId: inputData.stateId,
      dateLabel: inputData.dateLabel,
      dryRun: inputData.dryRun,
      totalItems: digest.totalItems
    };
  }
});

export const deliverDigestTool = createTool({
  id: "deliver-digest",
  description: "Send digest email through AgentMail endpoint or write local file in dry-run mode.",
  inputSchema: digestSchema,
  outputSchema: workflowOutputSchema,
  execute: async (inputData) => {
    const state = getPipelineState(inputData.stateId);
    if (!state.digest) {
      throw new Error(`Digest not available for stateId: ${inputData.stateId}`);
    }

    const config = loadConfig();

    if (inputData.dryRun) {
      const fileName = `digest-${inputData.dateLabel}.txt`;
      const filePath = path.join(process.cwd(), fileName);
      await writeFile(filePath, state.digest.textBody, "utf8");

      pipelineStateStore.delete(inputData.stateId);

      return {
        status: "dry-run" as const,
        target: filePath,
        totalItems: inputData.totalItems,
        dateLabel: inputData.dateLabel
      };
    }

    await sendDigestEmail(config, {
      to: config.digestRecipientEmail,
      subject: `Shelly Digest - ${inputData.dateLabel}`,
      htmlBody: state.digest.htmlBody,
      textBody: state.digest.textBody
    });

    pipelineStateStore.delete(inputData.stateId);

    return {
      status: "sent" as const,
      target: config.digestRecipientEmail,
      totalItems: inputData.totalItems,
      dateLabel: inputData.dateLabel
    };
  }
});
