import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: ".env.local" });

export interface AppConfig {
  agentmailAdminApiKey: string;
  agentmailSendingApiKey: string;
  agentmailApiBaseUrl: string;
  agentmailMessagesPath: string;
  agentmailAuthHeader: string;
  agentmailAuthPrefix: string;
  agentmailAdminInboxId: string;
  agentmailSendingInboxId: string;
  agentmailInboxParam: string;
  agentmailDateFromParam: string;
  agentmailDateToParam: string;
  agentmailDateFormat: string;
  agentmailExtraQuery: Record<string, string | number | boolean>;
  digestRecipientEmail: string;
  digestRecipientEmails: string[];
  digestSubscribersFile: string;
  digestSendBatchSize: number;
  digestSendParallelBatches: number;
  digestAlertRecipientEmail: string;
  digestAlertsEnabled: boolean;
  digestTimezone: string;
  digestMaxItems: number;
  digestDryRun: boolean;
  digestOutputDir: string;
  digestOutputRetentionDays: number;
  aiProvider: "ollama";
  aiMaxCharsPerItem: number;
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaTimeoutMs: number;
  ollamaMaxRetries: number;
  ollamaRetryBackoffMs: number;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseExtraQuery(raw: string | undefined): Record<string, string | number | boolean> {
  if (!raw || raw.trim() === "") {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AGENTMAIL_EXTRA_QUERY_JSON must be valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("AGENTMAIL_EXTRA_QUERY_JSON must be a JSON object");
  }

  const output: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (["string", "number", "boolean"].includes(typeof value)) {
      output[key] = value as string | number | boolean;
    }
  }
  return output;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const rounded = Math.floor(parsed);
  return rounded > 0 ? rounded : fallback;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const rounded = Math.floor(parsed);
  return rounded >= 0 ? rounded : fallback;
}

function parseRecipients(singleRecipient: string, recipientsCsv: string | undefined): string[] {
  const parsed = (recipientsCsv ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const combined = parsed.length > 0 ? parsed : [singleRecipient];
  const deduped = Array.from(new Set(combined));
  return deduped;
}

export function loadConfig(): AppConfig {
  const aiProviderRaw = (process.env.AI_PROVIDER ?? "ollama").trim().toLowerCase();
  if (aiProviderRaw !== "ollama") {
    throw new Error("AI_PROVIDER must be set to 'ollama' for AI-only summaries.");
  }

  const extraQuery = parseExtraQuery(process.env.AGENTMAIL_EXTRA_QUERY_JSON);
  const digestRecipientEmail = required("DIGEST_RECIPIENT_EMAIL");
  const digestAlertRecipientEmail = (process.env.DIGEST_ALERT_RECIPIENT_EMAIL ?? digestRecipientEmail).trim();
  const agentmailAdminInboxId = required("AGENTMAIL_ADMIN_INBOX_ID");
  const agentmailAdminApiKey = required("AGENTMAIL_ADMIN_API_KEY");
  const agentmailSendingApiKey = (process.env.AGENTMAIL_SENDING_API_KEY ?? "").trim();
  const agentmailSendingInboxId = (process.env.AGENTMAIL_SENDING_INBOX_ID ?? "").trim();

  if (!agentmailSendingApiKey) {
    throw new Error("Missing required environment variable: AGENTMAIL_SENDING_API_KEY");
  }
  if (!agentmailSendingInboxId) {
    throw new Error("Missing required environment variable: AGENTMAIL_SENDING_INBOX_ID");
  }

  return {
    agentmailAdminApiKey,
    agentmailSendingApiKey,
    agentmailApiBaseUrl: (process.env.AGENTMAIL_API_BASE_URL ?? "https://api.agentmail.to/v0").replace(/\/$/, ""),
    agentmailMessagesPath: process.env.AGENTMAIL_MESSAGES_PATH ?? "/inboxes/{inbox_id}/messages",
    agentmailAuthHeader: process.env.AGENTMAIL_AUTH_HEADER ?? "Authorization",
    agentmailAuthPrefix: process.env.AGENTMAIL_AUTH_PREFIX ?? "Bearer",
    agentmailAdminInboxId,
    agentmailSendingInboxId,
    agentmailInboxParam: process.env.AGENTMAIL_INBOX_PARAM ?? "inbox",
    agentmailDateFromParam: process.env.AGENTMAIL_DATE_FROM_PARAM ?? "start_date",
    agentmailDateToParam: process.env.AGENTMAIL_DATE_TO_PARAM ?? "end_date",
    agentmailDateFormat: process.env.AGENTMAIL_DATE_FORMAT ?? "yyyy-mm-dd",
    agentmailExtraQuery:
      Object.keys(extraQuery).length > 0
        ? extraQuery
        : {
            labels: "received"
          },
    digestRecipientEmail,
    digestRecipientEmails: parseRecipients(digestRecipientEmail, process.env.DIGEST_RECIPIENT_EMAILS),
    digestSubscribersFile: process.env.DIGEST_SUBSCRIBERS_FILE ?? "data/subscribers.json",
    digestSendBatchSize: parsePositiveInt(process.env.DIGEST_SEND_BATCH_SIZE, 10),
    digestSendParallelBatches: parsePositiveInt(process.env.DIGEST_SEND_PARALLEL_BATCHES, 5),
    digestAlertRecipientEmail: digestAlertRecipientEmail.length > 0 ? digestAlertRecipientEmail : digestRecipientEmail,
    digestAlertsEnabled: parseBool(process.env.DIGEST_ALERTS_ENABLED, true),
    digestTimezone: process.env.DIGEST_TIMEZONE ?? "UTC",
    digestMaxItems: Number(process.env.DIGEST_MAX_ITEMS ?? "100"),
    digestDryRun: parseBool(process.env.DIGEST_DRY_RUN, false),
    digestOutputDir: process.env.DIGEST_OUTPUT_DIR ?? "output/digests",
    digestOutputRetentionDays: parseNonNegativeInt(process.env.DIGEST_OUTPUT_RETENTION_DAYS, 14),
    aiProvider: "ollama",
    aiMaxCharsPerItem: Number(process.env.AI_MAX_CHARS_PER_ITEM ?? "6000"),
    ollamaBaseUrl: (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, ""),
    ollamaModel: process.env.OLLAMA_MODEL ?? "gemma4:31b-cloud",
    ollamaTimeoutMs: parsePositiveInt(process.env.OLLAMA_TIMEOUT_MS, 90000),
    ollamaMaxRetries: parseNonNegativeInt(process.env.OLLAMA_MAX_RETRIES, 2),
    ollamaRetryBackoffMs: parsePositiveInt(process.env.OLLAMA_RETRY_BACKOFF_MS, 1500)
  };
}
