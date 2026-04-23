import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import type { AppConfig } from "./config.js";

function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

function secretKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function encodePayload(email: string): string {
  const payload = {
    email: normalizeEmail(email),
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30
  };
  return JSON.stringify(payload);
}

function encryptToken(email: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(encodePayload(email), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${authTag.toString("base64url")}`;
}

function decryptToken(token: string, secret: string): { email: string; exp: number } | null {
  const parts = token.trim().split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    return null;
  }

  let iv: Buffer;
  let ciphertext: Buffer;
  let authTag: Buffer;
  try {
    iv = Buffer.from(parts[1], "base64url");
    ciphertext = Buffer.from(parts[2], "base64url");
    authTag = Buffer.from(parts[3], "base64url");
  } catch {
    return null;
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", secretKey(secret), iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(plaintext) as { email?: unknown; exp?: unknown };
    if (typeof parsed.email !== "string" || typeof parsed.exp !== "number") {
      return null;
    }
    return { email: normalizeEmail(parsed.email), exp: parsed.exp };
  } catch {
    return null;
  }
}

export function buildUnsubscribeUrl(
  config: Pick<AppConfig, "publicAppBaseUrl" | "unsubscribeSigningSecret">,
  email: string
): string {
  const token = encryptToken(email, config.unsubscribeSigningSecret);
  return `${config.publicAppBaseUrl}/unsubscribe?token=${encodeURIComponent(token)}`;
}

export function appendUnsubscribeFooter(
  config: Pick<AppConfig, "publicAppBaseUrl" | "unsubscribeSigningSecret">,
  email: string,
  htmlBody: string,
  textBody: string
): { htmlBody: string; textBody: string } {
  const url = buildUnsubscribeUrl(config, email);
  const footerHtml = `
    <hr style="border:0;border-top:1px solid #d6deea;margin:24px 0 18px 0;" />
    <p style="margin:0;color:#475569;font-size:14px;line-height:1.6;">
      Want fewer emails from Shelly?
      <a href="${url}" style="color:#0f5f5f;font-weight:700;text-decoration:underline;">Unsubscribe here</a>.
    </p>
  `;
  const footerText = [
    "",
    "---",
    "Want fewer emails from Shelly?",
    `Unsubscribe: ${url}`
  ].join("\n");

  return {
    htmlBody: `${htmlBody}\n${footerHtml}`,
    textBody: `${textBody}${footerText}`
  };
}

export function verifyUnsubscribeToken(email: string, token: string, secret: string): boolean {
  const decoded = decryptToken(token, secret);
  if (!decoded) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (decoded.exp < now) {
    return false;
  }

  return decoded.email === normalizeEmail(email);
}

export function extractEmailFromUnsubscribeToken(token: string, secret: string): string | null {
  const decoded = decryptToken(token, secret);
  if (!decoded) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (decoded.exp < now) {
    return null;
  }

  return decoded.email;
}