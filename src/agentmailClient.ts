import { load } from "cheerio";

import type { AppConfig } from "./config.js";
import type { NewsletterItem } from "./types.js";

function pickFirstString(input: Record<string, unknown>, keys: string[], fallback = ""): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return fallback;
}

function parseDate(input: Record<string, unknown>): Date | null {
  for (const key of ["received_at", "receivedAt", "date", "created_at", "createdAt", "timestamp"]) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return new Date(value < 1_000_000_000_000 ? value * 1000 : value);
    }
    if (typeof value === "string" && value.trim()) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) {
        return date;
      }
    }
  }
  return null;
}

function flattenStrings(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }
  if (Array.isArray(input)) {
    return input.map(flattenStrings).filter(Boolean).join("\n");
  }
  if (input && typeof input === "object") {
    return Object.values(input).map(flattenStrings).filter(Boolean).join("\n");
  }
  return "";
}

function extractText(input: Record<string, unknown>): string {
  const direct = pickFirstString(input, [
    "extracted_text",
    "extractedText",
    "text",
    "text_body",
    "textBody",
    "body_text",
    "bodyText",
    "snippet",
    "preview"
  ]);
  if (direct) {
    return direct;
  }

  for (const parentKey of ["content", "payload"]) {
    const parent = input[parentKey];
    if (!parent || typeof parent !== "object" || Array.isArray(parent)) {
      continue;
    }
    const nested = pickFirstString(parent as Record<string, unknown>, [
      "extracted_text",
      "extractedText",
      "text",
      "text_body",
      "body_text",
      "snippet"
    ]);
    if (nested) {
      return nested;
    }
  }

  return flattenStrings(input.body).trim();
}

function extractHtml(input: Record<string, unknown>): string {
  const direct = pickFirstString(input, ["extracted_html", "extractedHtml", "html", "html_body", "htmlBody", "body_html", "bodyHtml"]);
  if (direct) {
    return direct;
  }

  for (const parentKey of ["content", "payload"]) {
    const parent = input[parentKey];
    if (!parent || typeof parent !== "object" || Array.isArray(parent)) {
      continue;
    }
    const nested = pickFirstString(parent as Record<string, unknown>, [
      "extracted_html",
      "extractedHtml",
      "html",
      "html_body",
      "body_html",
      "bodyHtml"
    ]);
    if (nested) {
      return nested;
    }
  }

  return "";
}

function extractAttachmentImages(input: Record<string, unknown>): string[] {
  const attachments = input.attachments;
  if (!Array.isArray(attachments)) {
    return [];
  }

  const images: string[] = [];
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
      continue;
    }

    const record = attachment as Record<string, unknown>;
    const contentType = String(record.content_type ?? record.contentType ?? "").toLowerCase();
    if (!contentType.startsWith("image/")) {
      continue;
    }

    const url = pickFirstString(record, ["url", "download_url", "downloadUrl", "href"]);
    if (url) {
      images.push(url);
    }
  }

  return dedupe(images);
}

function extractLinksAndImagesFromHtml(htmlContent: string): { links: string[]; imageUrls: string[] } {
  if (!htmlContent.trim()) {
    return { links: [], imageUrls: [] };
  }

  const $ = load(htmlContent);
  const links = dedupe(
    $("a[href]")
      .map((_, el) => $(el).attr("href")?.trim() ?? "")
      .get()
      .filter((url) => /^https?:\/\//i.test(url))
  );

  const imageUrls = dedupe(
    $("img[src]")
      .map((_, el) => $(el).attr("src")?.trim() ?? "")
      .get()
      .filter((url) => /^https?:\/\//i.test(url))
  );

  return { links, imageUrls };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))];
}

function asRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  return input as Record<string, unknown>;
}

function parseYmd(date: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    throw new Error(`Invalid date '${date}'. Expected YYYY-MM-DD`);
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  };
}

function timezoneOffsetMinutes(timezone: string, at: Date): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "shortOffset",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const token = formatter.formatToParts(at).find((part) => part.type === "timeZoneName")?.value ?? "GMT+0";
  const match = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(token);
  if (!match) {
    return 0;
  }
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? "0");
  return sign * (hours * 60 + minutes);
}

function zonedMidnightUtc(date: string, timezone: string): Date {
  const { year, month, day } = parseYmd(date);
  const localMidnightAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);

  let guess = localMidnightAsUtc;
  for (let i = 0; i < 2; i += 1) {
    const offsetMinutes = timezoneOffsetMinutes(timezone, new Date(guess));
    guess = localMidnightAsUtc - offsetMinutes * 60_000;
  }

  return new Date(guess);
}

function plusOneDay(date: string): string {
  const { year, month, day } = parseYmd(date);
  return new Date(Date.UTC(year, month - 1, day + 1, 0, 0, 0, 0)).toISOString().slice(0, 10);
}

function apiDateParamValue(paramName: string, date: string, timezone: string): string {
  const normalized = paramName.trim().toLowerCase();
  const usesTimestamps = ["after", "before", "start", "end", "from", "to"].some((token) => normalized.includes(token));
  if (!usesTimestamps) {
    return date;
  }

  if (normalized.includes("before") || normalized.includes("end") || normalized.includes("to")) {
    return zonedMidnightUtc(plusOneDay(date), timezone).toISOString();
  }

  return zonedMidnightUtc(date, timezone).toISOString();
}

export class AgentmailClient {
  constructor(private readonly config: AppConfig) {}

  private buildMessagesCollectionUrl(): { url: string; hasInboxPlaceholder: boolean } {
    const hasInboxPlaceholder = this.config.agentmailMessagesPath.includes("{inbox_id}");
    const resolvedPath = this.config.agentmailMessagesPath.replace(
      /\{inbox_id\}/g,
      encodeURIComponent(this.config.agentmailInboxId)
    );
    return {
      url: `${this.config.agentmailApiBaseUrl}${resolvedPath}`,
      hasInboxPlaceholder
    };
  }

  private async fetchMessageDetails(messageId: string): Promise<Record<string, unknown> | null> {
    if (!messageId.trim()) {
      return null;
    }

    const detailsUrl = `${this.config.agentmailApiBaseUrl}/inboxes/${encodeURIComponent(this.config.agentmailInboxId)}/messages/${encodeURIComponent(messageId)}`;
    const authValue = `${this.config.agentmailAuthPrefix} ${this.config.agentmailApiKey}`.trim();

    const response = await fetch(detailsUrl, {
      method: "GET",
      headers: {
        [this.config.agentmailAuthHeader]: authValue
      }
    });

    if (!response.ok) {
      return null;
    }

    const json = (await response.json()) as unknown;
    return asRecord(json);
  }

  async fetchMessagesForDate(date: string): Promise<NewsletterItem[]> {
    const { url, hasInboxPlaceholder } = this.buildMessagesCollectionUrl();
    const query = new URLSearchParams();
    if (!hasInboxPlaceholder && this.config.agentmailInboxParam.trim() !== "") {
      query.set(this.config.agentmailInboxParam, this.config.agentmailInboxId);
    }
    if (this.config.agentmailDateFromParam.trim() !== "") {
      query.set(this.config.agentmailDateFromParam, apiDateParamValue(this.config.agentmailDateFromParam, date, this.config.digestTimezone));
    }
    if (this.config.agentmailDateToParam.trim() !== "") {
      query.set(this.config.agentmailDateToParam, apiDateParamValue(this.config.agentmailDateToParam, date, this.config.digestTimezone));
    }

    for (const [key, value] of Object.entries(this.config.agentmailExtraQuery)) {
      query.set(key, String(value));
    }

    const authValue = `${this.config.agentmailAuthPrefix} ${this.config.agentmailApiKey}`.trim();
    const requestUrl = query.size > 0 ? `${url}?${query.toString()}` : url;
    const response = await fetch(requestUrl, {
      method: "GET",
      headers: {
        [this.config.agentmailAuthHeader]: authValue
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`AgentMail API request failed: ${response.status} ${response.statusText} | ${body}`);
    }

    const json = (await response.json()) as unknown;
    const rows = this.extractRows(json);

    const enrichedRows = await Promise.all(
      rows.map(async (row) => {
        const messageId = pickFirstString(row, ["id", "message_id", "messageId", "uuid"]);
        const details = await this.fetchMessageDetails(messageId);
        return {
          ...row,
          ...(details ?? {})
        };
      })
    );

    return enrichedRows
      .map((row) => this.toNewsletterItem(row))
      .filter((item) => item.messageId !== "" && item.source !== "");
  }

  private extractRows(input: unknown): Record<string, unknown>[] {
    if (Array.isArray(input)) {
      return input.map(asRecord);
    }

    const root = asRecord(input);
    for (const key of ["messages", "items", "data", "results"]) {
      const candidate = root[key];
      if (Array.isArray(candidate)) {
        return candidate.map(asRecord);
      }
    }

    return [];
  }

  private toNewsletterItem(row: Record<string, unknown>): NewsletterItem {
    const messageId = pickFirstString(row, ["id", "message_id", "messageId", "uuid"]);
    const source = pickFirstString(row, ["from", "sender", "sender_email", "from_email", "fromEmail"]);
    const subject = pickFirstString(row, ["subject", "title"], "(No subject)");
    const textContent = extractText(row);
    const htmlContent = extractHtml(row);

    const htmlExtract = extractLinksAndImagesFromHtml(htmlContent);
    const attachmentImages = extractAttachmentImages(row);

    return {
      messageId,
      source,
      subject,
      receivedAt: parseDate(row),
      textContent,
      htmlContent,
      aiSummary: "",
      links: htmlExtract.links,
      imageUrls: dedupe([...htmlExtract.imageUrls, ...attachmentImages]),
      raw: row
    };
  }
}
