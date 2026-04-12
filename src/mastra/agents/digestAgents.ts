import { Agent } from "@mastra/core/agent";
import { createOllama } from "ollama-ai-provider-v2";

import {
  buildDigestTool,
  deliverDigestTool,
  fetchMessagesTool,
  resolveDigestInputTool,
  summarizeMessagesTool
} from "../tools/digestTools.js";

function normalizeOllamaBaseUrl(rawBaseUrl?: string): string {
  const base = rawBaseUrl ?? "http://localhost:11434";
  return base.endsWith("/api") ? base : `${base}/api`;
}

const ollamaProvider = createOllama({
  baseURL: normalizeOllamaBaseUrl(process.env.OLLAMA_BASE_URL),
  compatibility: "strict"
});

const localOllamaModel = ollamaProvider.chat(process.env.OLLAMA_MODEL ?? "gemma4:31b-cloud");

export const digestCoordinatorAgent = new Agent({
  id: "digest-coordinator-agent",
  name: "Digest Coordinator Agent",
  instructions:
    "You coordinate the daily newsletter digest pipeline. Resolve inputs, fetch messages, summarize content, build digest output, and deliver final results.",
  model: localOllamaModel,
  tools: {
    resolveDigestInputTool,
    fetchMessagesTool,
    summarizeMessagesTool,
    buildDigestTool,
    deliverDigestTool
  }
});

export const newsletterSummarizerAgent = new Agent({
  id: "newsletter-summarizer-agent",
  name: "Newsletter Summarizer Agent",
  instructions:
    "You specialize in transforming newsletter emails into high-signal summaries with useful structure and relevant image markers.",
  model: localOllamaModel,
  tools: {
    summarizeMessagesTool
  }
});
