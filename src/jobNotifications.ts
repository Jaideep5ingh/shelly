import type { AppConfig } from "./config.js";
import { sendDigestEmail } from "./emailSender.js";

export type DigestJobName = "build" | "send" | "cleanup";

interface FailureAlertInput {
  jobName: DigestJobName;
  dateLabel?: string;
  reason: string;
}

interface SuccessAlertInput {
  dateLabel: string;
  generatedAt: string;
  sentAt: string;
  recipientCount: number;
  totalItems: number;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeReason(reason: string): string {
  return reason.trim().length > 0 ? reason.trim() : "Unknown error";
}

function formatDateLine(dateLabel?: string): string {
  return dateLabel ? `Date: ${dateLabel}` : "Date: n/a";
}

export async function sendFailureAlert(
  config: AppConfig,
  input: FailureAlertInput
): Promise<void> {
  if (!config.digestAlertsEnabled) {
    return;
  }

  const safeReason = normalizeReason(input.reason);
  const subject = `Shelly Job Failed: ${input.jobName}${input.dateLabel ? ` (${input.dateLabel})` : ""}`;
  const textBody = [
    "Shelly job failure notification",
    `Job: ${input.jobName}`,
    formatDateLine(input.dateLabel),
    "Status: failed",
    "",
    "Reason:",
    safeReason
  ].join("\n");

  const htmlBody = [
    "<h2>Shelly Job Failure</h2>",
    `<p><strong>Job:</strong> ${escapeHtml(input.jobName)}</p>`,
    `<p><strong>${escapeHtml(formatDateLine(input.dateLabel))}</strong></p>`,
    "<p><strong>Status:</strong> failed</p>",
    `<pre style=\"white-space: pre-wrap; background: #f7f7f7; padding: 12px; border-radius: 8px;\">${escapeHtml(safeReason)}</pre>`
  ].join("\n");

  await sendDigestEmail(config, {
    to: config.digestAlertRecipientEmail,
    subject,
    htmlBody,
    textBody,
    channel: "admin"
  });
}

export async function sendEndToEndSuccessAlert(
  config: AppConfig,
  input: SuccessAlertInput
): Promise<void> {
  if (!config.digestAlertsEnabled) {
    return;
  }

  const subject = `Shelly Daily Pipeline Succeeded (${input.dateLabel})`;
  const textBody = [
    "Shelly end-to-end success notification",
    `Date: ${input.dateLabel}`,
    "Status: generation and send completed",
    `Generated at: ${input.generatedAt}`,
    `Sent at: ${input.sentAt}`,
    `Recipients: ${input.recipientCount}`,
    `Digest items: ${input.totalItems}`
  ].join("\n");

  const htmlBody = [
    "<h2>Shelly Daily Pipeline Succeeded</h2>",
    `<p><strong>Date:</strong> ${escapeHtml(input.dateLabel)}</p>`,
    "<p><strong>Status:</strong> generation and send completed</p>",
    `<p><strong>Generated at:</strong> ${escapeHtml(input.generatedAt)}</p>`,
    `<p><strong>Sent at:</strong> ${escapeHtml(input.sentAt)}</p>`,
    `<p><strong>Recipients:</strong> ${input.recipientCount}</p>`,
    `<p><strong>Digest items:</strong> ${input.totalItems}</p>`
  ].join("\n");

  await sendDigestEmail(config, {
    to: config.digestAlertRecipientEmail,
    subject,
    htmlBody,
    textBody,
    channel: "admin"
  });
}
