import type { AppConfig } from "./config.js";
import type { NewsletterItem } from "./types.js";

function clamp(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  return `${input.slice(0, maxChars - 1)}...`;
}

function stripHtml(input: string): string {
  return input.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function buildPrompt(item: NewsletterItem, maxChars: number): string {
  const sourceText = item.textContent.trim() || stripHtml(item.htmlContent);
  const content = clamp(sourceText, maxChars);
  const imageHints = item.imageUrls.length
    ? item.imageUrls.map((url, index) => `- [IMAGE_${index + 1}] ${url}`).join("\n")
    : "- none";

  return [
    "You are summarizing one newsletter email for a daily digest.",
    "Return plain text only.",
    "Do not ask for more content. Work only with the provided input.",
    "Do not mention that content may be missing unless it is truly too short to summarize.",
    "",
    "Output requirements:",
    "- First line: one clear headline sentence.",
    "- Then provide as many bullet points as needed to fully cover key points (typically 4-10).",
    "- Each bullet must start with '- '.",
    "- Keep bullets factual and specific; avoid generic filler.",
    "- Include important numbers, companies, products, and outcomes when available.",
    "- Do not include links or URLs in the output.",
    "",
    "Image placement requirement:",
    "- If the newsletter references visuals/charts/products and image markers are available, place the relevant marker on its own line right after the related bullet.",
    "- Use only markers from the provided list, exactly as written (example: [IMAGE_1]).",
    "- You may use zero, one, or multiple markers.",
    "",
    "If content is too short, still output:",
    "- A useful headline based on subject/sender.",
    "- Up to 2 concise bullets with whatever concrete signal exists.",
    "",
    `Subject: ${item.subject}`,
    `Sender: ${item.source}`,
    "",
    "Available image markers:",
    imageHints,
    "",
    "Newsletter content:",
    content
  ].join("\n");
}

async function summarizeWithOllama(config: AppConfig, item: NewsletterItem): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.ollamaTimeoutMs);

  try {
    const response = await fetch(`${config.ollamaBaseUrl}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.ollamaModel,
        prompt: buildPrompt(item, config.aiMaxCharsPerItem),
        stream: false,
        options: {
          temperature: 0.2
        }
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama request failed (${response.status}): ${body}`);
    }

    const data = (await response.json()) as { response?: unknown };
    if (typeof data.response !== "string" || !data.response.trim()) {
      throw new Error("Ollama returned an empty summary");
    }
    return data.response.trim();
  } catch (error) {
    throw new Error(`Failed to summarize '${item.subject}' from '${item.source}': ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function applyAiSummaries(config: AppConfig, items: NewsletterItem[]): Promise<NewsletterItem[]> {
  if (config.aiProvider !== "ollama") {
    throw new Error("AI summaries are required. Set AI_PROVIDER=ollama.");
  }

  const updated: NewsletterItem[] = [];
  for (const item of items) {
    const summary = await summarizeWithOllama(config, item);

    updated.push({
      ...item,
      aiSummary: summary
    });
  }

  return updated;
}
