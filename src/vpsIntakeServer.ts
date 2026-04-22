import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

interface SubscribeRequestBody {
  email?: unknown;
  website?: unknown;
}

interface FeedbackRequestBody {
  email?: unknown;
  feedback?: unknown;
  website?: unknown;
}

interface SubscribersData {
  recipients: string[];
  countHash: string;
  updatedAt: string;
}

interface RateState {
  windowStartMs: number;
  count: number;
}

const PORT = Number(process.env.INTAKE_PORT ?? "8788");
const INTAKE_AUTH_HEADER = (process.env.INTAKE_AUTH_HEADER ?? "x-forward-secret").toLowerCase();
const INTAKE_FORWARD_SECRET = process.env.INTAKE_FORWARD_SECRET?.trim() ?? "";
const SUBSCRIBER_CAP = Number(process.env.SUBSCRIBER_CAP ?? "50");
const SUBSCRIBER_COUNT_SALT = process.env.SUBSCRIBER_COUNT_SALT ?? "shelly-subscriber-cap-v1";
const SUBSCRIBERS_FILE = path.resolve(process.cwd(), process.env.DIGEST_SUBSCRIBERS_FILE ?? "data/subscribers.json");
const FEEDBACK_FILE = path.resolve(process.cwd(), "data/feedback.jsonl");
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL?.trim() ?? "";
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN?.trim() ?? "";
const USE_UPSTASH_RATE_LIMIT = UPSTASH_REDIS_REST_URL !== "" && UPSTASH_REDIS_REST_TOKEN !== "";

const rateByKey = new Map<string, RateState>();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS_GLOBAL = 60;
const RATE_MAX_REQUESTS_SUBSCRIBE = 12;
const RATE_MAX_REQUESTS_FEEDBACK = 10;
const SUBSCRIBE_EMAIL_WINDOW_SEC = 60 * 60;
const SUBSCRIBE_EMAIL_MAX_REQUESTS = 4;
const FEEDBACK_EMAIL_WINDOW_SEC = 30 * 60;
const FEEDBACK_EMAIL_MAX_REQUESTS = 3;
const BODY_MAX_BYTES = 4 * 1024;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
const INJECTION_PATTERNS = [
  "ignore previous instructions",
  "system prompt",
  "assistant:",
  "<script",
  "javascript:",
  "drop table",
  "union select",
  "```"
];

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none';");
}

function sendJson(res: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  setSecurityHeaders(res);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function getHeaderValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
    return value[0];
  }
  return null;
}

function isAuthorized(req: IncomingMessage): boolean {
  if (INTAKE_FORWARD_SECRET.length < 20) {
    return false;
  }
  const provided = getHeaderValue(req, INTAKE_AUTH_HEADER);
  return provided === INTAKE_FORWARD_SECRET;
}

function getClientIp(req: IncomingMessage): string {
  const forwarded = getHeaderValue(req, "x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }

  const realIp = getHeaderValue(req, "x-real-ip");
  if (realIp && realIp.trim()) {
    return realIp.trim();
  }

  return req.socket.remoteAddress ?? "unknown";
}

function hashIdentifier(value: string): string {
  return createHash("sha256").update(`${SUBSCRIBER_COUNT_SALT}:${value}`).digest("hex").slice(0, 24);
}

function isRateLimitedLocal(ip: string, channel: "subscribe" | "feedback"): boolean {
  const now = Date.now();

  const keys = [
    `global:${ip}`,
    `${channel}:${ip}`
  ] as const;

  const limits: Record<(typeof keys)[number], number> = {
    [`global:${ip}`]: RATE_MAX_REQUESTS_GLOBAL,
    [`${channel}:${ip}`]: channel === "subscribe" ? RATE_MAX_REQUESTS_SUBSCRIBE : RATE_MAX_REQUESTS_FEEDBACK
  };

  for (const key of keys) {
    const existing = rateByKey.get(key);
    if (!existing || now - existing.windowStartMs > RATE_WINDOW_MS) {
      rateByKey.set(key, { windowStartMs: now, count: 1 });
      continue;
    }

    existing.count += 1;
    if (existing.count > limits[key]) {
      return true;
    }
  }

  return false;
}

async function incrementRemoteWindowCounter(key: string, windowSeconds: number): Promise<number> {
  const response = await fetch(`${UPSTASH_REDIS_REST_URL}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify([
      ["INCR", key],
      ["EXPIRE", key, String(windowSeconds), "NX"]
    ])
  });

  if (!response.ok) {
    throw new Error(`Upstash rate-limit request failed: ${response.status}`);
  }

  const payload = (await response.json()) as Array<{ result?: unknown }>;
  const value = payload?.[0]?.result;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error("Upstash rate-limit returned invalid counter value");
  }
  return parsed;
}

async function isRateLimited(ip: string, channel: "subscribe" | "feedback"): Promise<boolean> {
  if (!USE_UPSTASH_RATE_LIMIT) {
    return isRateLimitedLocal(ip, channel);
  }

  const ipHash = hashIdentifier(ip);
  const globalKey = `rl:global:${ipHash}`;
  const routeKey = `rl:${channel}:${ipHash}`;

  const [globalCount, routeCount] = await Promise.all([
    incrementRemoteWindowCounter(globalKey, Math.floor(RATE_WINDOW_MS / 1000)),
    incrementRemoteWindowCounter(routeKey, Math.floor(RATE_WINDOW_MS / 1000))
  ]);

  const routeLimit = channel === "subscribe" ? RATE_MAX_REQUESTS_SUBSCRIBE : RATE_MAX_REQUESTS_FEEDBACK;
  return globalCount > RATE_MAX_REQUESTS_GLOBAL || routeCount > routeLimit;
}

async function isEmailFlooded(channel: "subscribe" | "feedback", email: string): Promise<boolean> {
  const windowSec = channel === "subscribe" ? SUBSCRIBE_EMAIL_WINDOW_SEC : FEEDBACK_EMAIL_WINDOW_SEC;
  const limit = channel === "subscribe" ? SUBSCRIBE_EMAIL_MAX_REQUESTS : FEEDBACK_EMAIL_MAX_REQUESTS;

  if (!USE_UPSTASH_RATE_LIMIT) {
    return false;
  }

  const emailHash = hashIdentifier(`${channel}:${normalizeEmail(email)}`);
  const key = `rl:email:${channel}:${emailHash}`;
  const count = await incrementRemoteWindowCounter(key, windowSec);
  return count > limit;
}

function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

function hasInjectionPattern(input: string): boolean {
  const normalized = input.toLowerCase();
  return INJECTION_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function countHashFor(size: number): string {
  return createHash("sha256").update(`${SUBSCRIBER_COUNT_SALT}:${size}`).digest("hex");
}

function dedupe(values: string[]): string[] {
  const normalized = values.map(normalizeEmail).filter((email) => email.length > 0);
  return Array.from(new Set(normalized));
}

function parseSubscribers(raw: string): string[] {
  const parsed = JSON.parse(raw) as unknown;
  if (Array.isArray(parsed)) {
    return dedupe(parsed.filter((entry): entry is string => typeof entry === "string"));
  }

  if (parsed && typeof parsed === "object") {
    const objectData = parsed as Partial<SubscribersData>;
    if (!Array.isArray(objectData.recipients)) {
      throw new Error("Invalid subscribers payload");
    }

    const recipients = dedupe(objectData.recipients.filter((entry): entry is string => typeof entry === "string"));
    if (typeof objectData.countHash === "string" && objectData.countHash.length > 0) {
      const expected = countHashFor(recipients.length);
      if (objectData.countHash !== expected) {
        throw new Error("Subscriber metadata failed integrity check");
      }
    }
    return recipients;
  }

  throw new Error("Unsupported subscribers format");
}

async function readSubscribers(): Promise<string[]> {
  try {
    const raw = await readFile(SUBSCRIBERS_FILE, "utf8");
    return parseSubscribers(raw);
  } catch (error) {
    const isMissing = error instanceof Error && /ENOENT/.test(error.message);
    if (isMissing) {
      return [];
    }
    throw error;
  }
}

async function writeSubscribers(recipients: string[]): Promise<void> {
  const deduped = dedupe(recipients);
  const payload: SubscribersData = {
    recipients: deduped,
    countHash: countHashFor(deduped.length),
    updatedAt: new Date().toISOString()
  };

  await mkdir(path.dirname(SUBSCRIBERS_FILE), { recursive: true });
  const tempPath = `${SUBSCRIBERS_FILE}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tempPath, SUBSCRIBERS_FILE);
}

async function readJsonBody<T>(req: IncomingMessage, maxBytes: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        const parsed = JSON.parse(raw) as T;
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", (error) => reject(error));
  });
}

async function handleSubscribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ip = getClientIp(req);
  if (await isRateLimited(ip, "subscribe")) {
    sendJson(res, 429, { message: "Too many requests. Try again shortly." });
    return;
  }

  const contentType = req.headers["content-type"] ?? "";
  if (typeof contentType !== "string" || !contentType.toLowerCase().includes("application/json")) {
    sendJson(res, 415, { message: "Content-Type must be application/json" });
    return;
  }

  let body: SubscribeRequestBody;
  try {
    body = await readJsonBody<SubscribeRequestBody>(req, BODY_MAX_BYTES);
  } catch {
    sendJson(res, 400, { message: "Invalid request body" });
    return;
  }

  const website = typeof body.website === "string" ? body.website.trim() : "";
  if (website.length > 0) {
    sendJson(res, 200, { status: "accepted" });
    return;
  }

  if (typeof body.email !== "string") {
    sendJson(res, 400, { message: "Email is required" });
    return;
  }

  const email = normalizeEmail(body.email);
  if (email.length > 254 || !EMAIL_REGEX.test(email)) {
    sendJson(res, 400, { message: "Invalid email format" });
    return;
  }

  if (hasInjectionPattern(email)) {
    sendJson(res, 400, { message: "Input rejected by security checks" });
    return;
  }

  if (await isEmailFlooded("subscribe", email)) {
    sendJson(res, 429, { message: "Too many subscribe attempts for this email. Try again later." });
    return;
  }

  let recipients: string[];
  try {
    recipients = await readSubscribers();
  } catch {
    sendJson(res, 500, { message: "Subscriber storage unavailable" });
    return;
  }

  if (recipients.includes(email)) {
    sendJson(res, 200, {
      status: "already_subscribed",
      message: "You are already on the list.",
      currentCount: recipients.length,
      cap: SUBSCRIBER_CAP
    });
    return;
  }

  if (recipients.length >= SUBSCRIBER_CAP) {
    sendJson(res, 409, {
      status: "cap_reached",
      message: "Subscriber limit reached for this beta.",
      currentCount: recipients.length,
      cap: SUBSCRIBER_CAP
    });
    return;
  }

  recipients.push(email);
  try {
    await writeSubscribers(recipients);
  } catch {
    sendJson(res, 500, { message: "Failed to save subscriber" });
    return;
  }

  sendJson(res, 201, {
    status: "subscribed",
    message: "Subscribed successfully",
    currentCount: recipients.length,
    cap: SUBSCRIBER_CAP
  });
}

async function handleFeedback(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ip = getClientIp(req);
  if (await isRateLimited(ip, "feedback")) {
    sendJson(res, 429, { message: "Too many requests. Try again shortly." });
    return;
  }

  const contentType = req.headers["content-type"] ?? "";
  if (typeof contentType !== "string" || !contentType.toLowerCase().includes("application/json")) {
    sendJson(res, 415, { message: "Content-Type must be application/json" });
    return;
  }

  let body: FeedbackRequestBody;
  try {
    body = await readJsonBody<FeedbackRequestBody>(req, BODY_MAX_BYTES);
  } catch {
    sendJson(res, 400, { message: "Invalid request body" });
    return;
  }

  const website = typeof body.website === "string" ? body.website.trim() : "";
  if (website.length > 0) {
    sendJson(res, 200, { status: "accepted" });
    return;
  }

  if (typeof body.email !== "string") {
    sendJson(res, 400, { message: "Email is required" });
    return;
  }
  if (typeof body.feedback !== "string") {
    sendJson(res, 400, { message: "Feedback is required" });
    return;
  }

  const email = normalizeEmail(body.email);
  const feedback = body.feedback.trim();

  if (email.length > 254 || !EMAIL_REGEX.test(email)) {
    sendJson(res, 400, { message: "Invalid email format" });
    return;
  }

  if (feedback.length < 8 || feedback.length > 2000) {
    sendJson(res, 400, { message: "Feedback must be between 8 and 2000 characters." });
    return;
  }

  if (hasInjectionPattern(email) || hasInjectionPattern(feedback)) {
    sendJson(res, 400, { message: "Input rejected by security checks" });
    return;
  }

  if (await isEmailFlooded("feedback", email)) {
    sendJson(res, 429, { message: "Too many feedback submissions for this email. Try again later." });
    return;
  }

  const record = {
    email,
    feedback,
    ipHash: createHash("sha256").update(`${SUBSCRIBER_COUNT_SALT}:${ip}`).digest("hex"),
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 256) : "",
    createdAt: new Date().toISOString()
  };

  try {
    await mkdir(path.dirname(FEEDBACK_FILE), { recursive: true });
    await appendFile(FEEDBACK_FILE, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    sendJson(res, 500, { message: "Failed to save feedback" });
    return;
  }

  sendJson(res, 201, {
    status: "received",
    message: "Feedback received"
  });
}

const server = createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";

  if (method === "OPTIONS") {
    setSecurityHeaders(res);
    res.statusCode = 204;
    res.setHeader("Allow", "GET,POST,OPTIONS");
    res.end();
    return;
  }

  if (method === "GET" && url === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!isAuthorized(req)) {
    sendJson(res, 401, { message: "Unauthorized" });
    return;
  }

  if (method === "POST" && url === "/intake/subscribe") {
    await handleSubscribe(req, res);
    return;
  }

  if (method === "POST" && url === "/intake/feedback") {
    await handleFeedback(req, res);
    return;
  }

  sendJson(res, 404, { message: "Not found" });
});

if (INTAKE_FORWARD_SECRET.length < 20) {
  throw new Error("INTAKE_FORWARD_SECRET is missing or too short. Set a strong secret before starting the intake server.");
}

server.listen(PORT, () => {
  process.stdout.write(`VPS intake server listening on http://localhost:${PORT}\n`);
  process.stdout.write(`Auth header: ${INTAKE_AUTH_HEADER}\n`);
  process.stdout.write(`Subscriber file: ${SUBSCRIBERS_FILE}\n`);
  process.stdout.write(`Feedback file: ${FEEDBACK_FILE}\n`);
});
