import { writeFile } from "node:fs/promises";
import path from "node:path";

import { AgentmailClient } from "./agentmailClient.js";
import { applyAiSummaries } from "./aiSummarizer.js";
import { loadConfig } from "./config.js";
import { buildDigest } from "./digestBuilder.js";
import { dateForTimezone, normalizeDateInput } from "./dateUtils.js";
import { sendDigestEmail } from "./emailSender.js";

interface Args {
  date?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--date" && argv[i + 1]) {
      args.date = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const args = parseArgs(process.argv.slice(2));
  const dateLabel = args.date ? normalizeDateInput(args.date) : dateForTimezone(config.digestTimezone);

  const client = new AgentmailClient(config);
  const messages = await client.fetchMessagesForDate(dateLabel);
  const summarizedMessages = await applyAiSummaries(config, messages);
  const digest = buildDigest(dateLabel, summarizedMessages, config.digestMaxItems);

  if (config.digestDryRun) {
    const fileName = `digest-${dateLabel}.txt`;
    const filePath = path.join(process.cwd(), fileName);
    await writeFile(filePath, digest.textBody, "utf8");
    process.stdout.write(`Dry run enabled. Digest written to ${filePath}\n`);
    process.stdout.write(`Collected ${digest.totalItems} newsletter items.\n`);
    return;
  }

  await sendDigestEmail(config, {
    to: config.digestRecipientEmail,
    subject: `Shelly Digest - ${dateLabel}`,
    htmlBody: digest.htmlBody,
    textBody: digest.textBody
  });

  process.stdout.write(`Sent digest with ${digest.totalItems} items to ${config.digestRecipientEmail}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
