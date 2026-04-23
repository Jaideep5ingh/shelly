import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { AgentmailClient } from "./agentmailClient.js";
import { applyAiSummaries } from "./aiSummarizer.js";
import { loadConfig } from "./config.js";
import { buildDigest } from "./digestBuilder.js";
import { dateForTimezone, normalizeDateInput } from "./dateUtils.js";
import { sendDigestEmail } from "./emailSender.js";
import type { AppConfig } from "./config.js";
import { sendEndToEndSuccessAlert, sendFailureAlert, type DigestJobName } from "./jobNotifications.js";
import { appendUnsubscribeFooter } from "./unsubscribe.js";

interface Args {
  date?: string;
  send: boolean;
  cleanupOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    send: false,
    cleanupOnly: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--date" && argv[i + 1]) {
      args.date = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--send") {
      args.send = true;
      continue;
    }
    if (token === "--cleanup-only") {
      args.cleanupOnly = true;
    }
  }
  return args;
}

interface StoredDigestPaths {
  outputDir: string;
  htmlPath: string;
  textPath: string;
  jsonPath: string;
}

interface StoredDigestContent {
  dateLabel: string;
  htmlBody: string;
  textBody: string;
  totalItems: number;
}

interface DigestJobState {
  dateLabel: string;
  generatedAt?: string;
  sentAt?: string;
  lastUpdatedAt: string;
}

interface SubscribersFileShape {
  recipients?: unknown;
}

function digestArtifactPath(outputDir: string, dateLabel: string, extension: "html" | "txt" | "json"): string {
  return path.join(outputDir, `${dateLabel}.${extension}`);
}

function digestStatusPath(outputDir: string, dateLabel: string): string {
  return path.join(outputDir, `${dateLabel}.status.json`);
}

async function storeDigestArtifacts(
  outputDir: string,
  dateLabel: string,
  digest: { htmlBody: string; textBody: string; totalItems: number }
): Promise<StoredDigestPaths> {
  const htmlPath = digestArtifactPath(outputDir, dateLabel, "html");
  const textPath = digestArtifactPath(outputDir, dateLabel, "txt");
  const jsonPath = digestArtifactPath(outputDir, dateLabel, "json");

  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(htmlPath, digest.htmlBody, "utf8"),
    writeFile(textPath, digest.textBody, "utf8"),
    writeFile(
      jsonPath,
      JSON.stringify(
        {
          dateLabel,
          totalItems: digest.totalItems,
          createdAt: new Date().toISOString(),
          htmlFile: path.basename(htmlPath),
          textFile: path.basename(textPath)
        },
        null,
        2
      ),
      "utf8"
    )
  ]);

  return {
    outputDir,
    htmlPath,
    textPath,
    jsonPath
  };
}

async function cleanupOldDigestArtifacts(outputDir: string, retentionDays: number): Promise<number> {
  if (retentionDays <= 0) {
    return 0;
  }

  await mkdir(outputDir, { recursive: true });
  const entries = await readdir(outputDir, { withFileTypes: true });
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let deletedCount = 0;

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const entryPath = path.join(outputDir, entry.name);
    const info = await stat(entryPath);
    if (info.mtimeMs < cutoffMs) {
      await unlink(entryPath);
      deletedCount += 1;
    }
  }

  return deletedCount;
}

async function loadStoredDigestArtifacts(outputDir: string, dateLabel: string): Promise<StoredDigestContent> {
  const htmlPath = digestArtifactPath(outputDir, dateLabel, "html");
  const textPath = digestArtifactPath(outputDir, dateLabel, "txt");
  const jsonPath = digestArtifactPath(outputDir, dateLabel, "json");

  try {
    const [htmlBody, textBody, jsonRaw] = await Promise.all([
      readFile(htmlPath, "utf8"),
      readFile(textPath, "utf8"),
      readFile(jsonPath, "utf8")
    ]);

    let totalItems = 0;
    try {
      const parsed = JSON.parse(jsonRaw) as { totalItems?: unknown };
      if (typeof parsed.totalItems === "number" && Number.isFinite(parsed.totalItems)) {
        totalItems = parsed.totalItems;
      }
    } catch {
      // Keep totalItems fallback as 0 if metadata is malformed.
    }

    return {
      dateLabel,
      htmlBody,
      textBody,
      totalItems
    };
  } catch (error) {
    throw new Error(
      `No stored digest artifacts found for ${dateLabel} in ${outputDir}. Run 'npm run digest -- --date ${dateLabel}' first. ` +
        `Original error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function loadDigestJobState(outputDir: string, dateLabel: string): Promise<DigestJobState | null> {
  const statusPath = digestStatusPath(outputDir, dateLabel);
  try {
    const raw = await readFile(statusPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<DigestJobState>;
    if (parsed.dateLabel !== dateLabel) {
      return null;
    }
    if (typeof parsed.lastUpdatedAt !== "string") {
      return null;
    }
    return {
      dateLabel,
      generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : undefined,
      sentAt: typeof parsed.sentAt === "string" ? parsed.sentAt : undefined,
      lastUpdatedAt: parsed.lastUpdatedAt
    };
  } catch {
    return null;
  }
}

async function writeDigestJobState(outputDir: string, state: DigestJobState): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await writeFile(digestStatusPath(outputDir, state.dateLabel), JSON.stringify(state, null, 2), "utf8");
}

async function markBuildComplete(outputDir: string, dateLabel: string): Promise<DigestJobState> {
  const now = new Date().toISOString();
  const state: DigestJobState = {
    dateLabel,
    generatedAt: now,
    sentAt: undefined,
    lastUpdatedAt: now
  };
  await writeDigestJobState(outputDir, state);
  return state;
}

async function markSendComplete(outputDir: string, dateLabel: string): Promise<DigestJobState> {
  const now = new Date().toISOString();
  const existing = await loadDigestJobState(outputDir, dateLabel);
  const state: DigestJobState = {
    dateLabel,
    generatedAt: existing?.generatedAt,
    sentAt: now,
    lastUpdatedAt: now
  };
  await writeDigestJobState(outputDir, state);
  return state;
}

function errorToReason(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function dedupeRecipients(values: string[]): string[] {
  const normalized = values.map((value) => value.trim()).filter((value) => value.length > 0);
  return Array.from(new Set(normalized));
}

function chunkRecipients(values: string[], size: number): string[][] {
  const output: string[][] = [];
  for (let i = 0; i < values.length; i += size) {
    output.push(values.slice(i, i + size));
  }
  return output;
}

function parseRecipientsFromFile(raw: string): string[] {
  const parsed = JSON.parse(raw) as unknown;
  if (Array.isArray(parsed)) {
    return dedupeRecipients(parsed.filter((entry): entry is string => typeof entry === "string"));
  }

  if (parsed && typeof parsed === "object") {
    const objectShape = parsed as SubscribersFileShape;
    if (Array.isArray(objectShape.recipients)) {
      return dedupeRecipients(objectShape.recipients.filter((entry): entry is string => typeof entry === "string"));
    }
  }

  throw new Error("Subscriber file must be a JSON string array or an object with a 'recipients' string array.");
}

async function loadRecipients(config: AppConfig): Promise<{ recipients: string[]; source: string }> {
  const subscribersPath = path.resolve(process.cwd(), config.digestSubscribersFile);
  try {
    const raw = await readFile(subscribersPath, "utf8");
    const recipients = parseRecipientsFromFile(raw);
    if (recipients.length === 0) {
      throw new Error(`Subscriber file ${subscribersPath} does not contain any recipients.`);
    }
    return {
      recipients,
      source: subscribersPath
    };
  } catch (error) {
    const isMissingFile = error instanceof Error && /ENOENT/.test(error.message);
    if (!isMissingFile) {
      throw error;
    }
  }

  if (config.digestRecipientEmails.length === 0) {
    throw new Error(
      `No recipients found in subscriber file (${subscribersPath}) and DIGEST_RECIPIENT_EMAILS is empty.`
    );
  }

  return {
    recipients: config.digestRecipientEmails,
    source: "DIGEST_RECIPIENT_EMAILS"
  };
}

async function sendRecipientsInParallelBatches(
  config: AppConfig,
  dateLabel: string,
  digest: StoredDigestContent,
  recipients: string[]
): Promise<void> {
  const batches = chunkRecipients(recipients, config.digestSendBatchSize);
  const workerCount = Math.min(config.digestSendParallelBatches, batches.length);
  let nextBatchIndex = 0;

  async function runWorker(workerId: number): Promise<void> {
    while (true) {
      const batchIndex = nextBatchIndex;
      nextBatchIndex += 1;
      if (batchIndex >= batches.length) {
        return;
      }

      const batch = batches[batchIndex];
      process.stdout.write(
        `Batch ${batchIndex + 1}/${batches.length} started by worker ${workerId} (${batch.length} recipient(s)).\n`
      );

      for (const recipient of batch) {
        const footerizedDigest = appendUnsubscribeFooter(config, recipient, digest.htmlBody, digest.textBody);
        await sendDigestEmail(config, {
          to: recipient,
          subject: `Shelly Digest - ${dateLabel}`,
          htmlBody: footerizedDigest.htmlBody,
          textBody: footerizedDigest.textBody
        });
      }

      process.stdout.write(`Batch ${batchIndex + 1}/${batches.length} finished by worker ${workerId}.\n`);
    }
  }

  const workers = Array.from({ length: workerCount }, (_, index) => runWorker(index + 1));
  await Promise.all(workers);
}

async function notifyFailure(config: AppConfig | undefined, jobName: DigestJobName, dateLabel: string | undefined, error: unknown): Promise<void> {
  if (!config) {
    return;
  }
  try {
    await sendFailureAlert(config, {
      jobName,
      dateLabel,
      reason: errorToReason(error)
    });
    process.stderr.write(
      `Failure alert sent to ${config.digestAlertRecipientEmail} for ${jobName}${dateLabel ? ` (${dateLabel})` : ""}.\n`
    );
  } catch (notifyError) {
    process.stderr.write(
      `Failed to send failure alert for ${jobName}${dateLabel ? ` (${dateLabel})` : ""}: ${errorToReason(notifyError)}\n`
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const jobName: DigestJobName = args.cleanupOnly ? "cleanup" : args.send ? "send" : "build";
  let config: AppConfig | undefined;
  let dateLabel: string | undefined;

  try {
    config = loadConfig();
    const outputDir = path.resolve(process.cwd(), config.digestOutputDir);

    if (args.cleanupOnly) {
      const cleaned = await cleanupOldDigestArtifacts(outputDir, config.digestOutputRetentionDays);
      process.stdout.write(`Cleanup-only run complete. Removed ${cleaned} old artifact file(s) from ${outputDir}.\n`);
      return;
    }

    dateLabel = args.date ? normalizeDateInput(args.date) : dateForTimezone(config.digestTimezone);

    if (args.send) {
      const storedDigest = await loadStoredDigestArtifacts(outputDir, dateLabel);
      const recipientResult = await loadRecipients(config);
      await sendRecipientsInParallelBatches(config, dateLabel, storedDigest, recipientResult.recipients);

      const state = await markSendComplete(outputDir, dateLabel);
      if (state.generatedAt && state.sentAt) {
        try {
          await sendEndToEndSuccessAlert(config, {
            dateLabel,
            generatedAt: state.generatedAt,
            sentAt: state.sentAt,
            recipientCount: recipientResult.recipients.length,
            totalItems: storedDigest.totalItems
          });
          process.stdout.write(`Success alert sent to ${config.digestAlertRecipientEmail}.\n`);
        } catch (notifyError) {
          process.stderr.write(`Failed to send success alert for ${dateLabel}: ${errorToReason(notifyError)}\n`);
        }
      }

      process.stdout.write(`Sent stored digest for ${dateLabel} to ${recipientResult.recipients.length} recipient(s).\n`);
      if (recipientResult.recipients.length > 0) {
        process.stdout.write(`Recipients: ${recipientResult.recipients.join(", ")}\n`);
      }
      process.stdout.write(
        `Send fanout config: batch_size=${config.digestSendBatchSize}, parallel_batches=${config.digestSendParallelBatches}\n`
      );
      process.stdout.write(`Recipient source: ${recipientResult.source}\n`);
      process.stdout.write(
        `Artifacts used: ${digestArtifactPath(outputDir, dateLabel, "html")}, ${digestArtifactPath(outputDir, dateLabel, "txt")}, ${digestArtifactPath(outputDir, dateLabel, "json")}\n`
      );
      process.stdout.write(`Digest item count (from metadata): ${storedDigest.totalItems}\n`);
      return;
    }

    const client = new AgentmailClient(config);
    const messages = await client.fetchMessagesForDate(dateLabel);
    const summarizedMessages = await applyAiSummaries(config, messages);
    const digest = buildDigest(dateLabel, summarizedMessages, config.digestMaxItems);

    const storedPaths = await storeDigestArtifacts(outputDir, dateLabel, digest);
    await markBuildComplete(outputDir, dateLabel);

    if (config.digestDryRun) {
      process.stdout.write(`Dry run enabled. Digest artifacts written to ${storedPaths.outputDir}\n`);
      process.stdout.write(`Stored files: ${storedPaths.htmlPath}, ${storedPaths.textPath}, ${storedPaths.jsonPath}\n`);
      process.stdout.write(`Collected ${digest.totalItems} newsletter items.\n`);
      return;
    }

    process.stdout.write(`Digest built and stored for ${dateLabel}.\n`);
    process.stdout.write(`Stored files: ${storedPaths.htmlPath}, ${storedPaths.textPath}, ${storedPaths.jsonPath}\n`);
    process.stdout.write(`Collected ${digest.totalItems} newsletter items.\n`);
    process.stdout.write("Email send skipped. Use --send to deliver stored artifacts.\n");
  } catch (error) {
    await notifyFailure(config, jobName, dateLabel, error);
    throw error;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
