import type { AppConfig } from "./config.js";

interface SendDigestInput {
  to: string;
  subject: string;
  htmlBody: string;
  textBody: string;
}

export async function sendDigestEmail(config: AppConfig, input: SendDigestInput): Promise<void> {
  const url = `${config.agentmailApiBaseUrl}/inboxes/${encodeURIComponent(config.agentmailInboxId)}/messages/send`;
  const authValue = `${config.agentmailAuthPrefix} ${config.agentmailApiKey}`.trim();

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [config.agentmailAuthHeader]: authValue
    },
    body: JSON.stringify({
      to: [input.to],
      subject: input.subject,
      text: input.textBody,
      html: input.htmlBody
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`AgentMail send failed: ${response.status} ${response.statusText} | ${body}`);
  }
}
