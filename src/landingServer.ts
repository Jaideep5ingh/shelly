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

const PORT = Number(process.env.LANDING_PORT ?? "8787");
const SUBSCRIBER_CAP = Number(process.env.SUBSCRIBER_CAP ?? "50");
const SUBSCRIBER_COUNT_SALT = process.env.SUBSCRIBER_COUNT_SALT ?? "shelly-subscriber-cap-v1";
const SUBSCRIBERS_FILE = path.resolve(process.cwd(), process.env.DIGEST_SUBSCRIBERS_FILE ?? "data/subscribers.json");
const FEEDBACK_FILE = path.resolve(process.cwd(), "data/feedback.jsonl");
const ASSETS_DIR = path.resolve(process.cwd(), "src/assets");
const VPS_SUBSCRIBE_URL = process.env.VPS_SUBSCRIBE_URL?.trim() ?? "";
const VPS_FEEDBACK_URL = process.env.VPS_FEEDBACK_URL?.trim() ?? "";
const INTAKE_AUTH_HEADER = (process.env.INTAKE_AUTH_HEADER ?? "x-forward-secret").toLowerCase();
const INTAKE_FORWARD_SECRET = process.env.INTAKE_FORWARD_SECRET?.trim() ?? "";
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL?.trim() ?? "";
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN?.trim() ?? "";
const USE_UPSTASH_RATE_LIMIT = UPSTASH_REDIS_REST_URL !== "" && UPSTASH_REDIS_REST_TOKEN !== "";

const rateByKey = new Map<string, RateState>();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS_GLOBAL = 40;
const RATE_MAX_REQUESTS_SUBSCRIBE = 8;
const RATE_MAX_REQUESTS_FEEDBACK = 8;
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

const LANDING_CSS = `
:root {
  --bg: #f6f3ee;
  --ink: #172026;
  --ink-soft: #445660;
  --accent: #117a7a;
  --accent-2: #de7f3f;
  --card: rgba(255, 255, 255, 0.78);
  --line: rgba(23, 32, 38, 0.12);
}

* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  min-height: 100%;
  font-family: "Space Grotesk", "Avenir Next", "Segoe UI", sans-serif;
  color: var(--ink);
  background: radial-gradient(circle at 8% 10%, rgba(17, 122, 122, 0.18), transparent 35%),
    radial-gradient(circle at 92% 14%, rgba(222, 127, 63, 0.2), transparent 36%),
    linear-gradient(135deg, #f7f4ef 0%, #f2efe8 100%);
}

body::before {
  content: "";
  position: fixed;
  inset: 0;
  background-image: linear-gradient(to right, rgba(23, 32, 38, 0.06) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(23, 32, 38, 0.06) 1px, transparent 1px);
  background-size: 44px 44px;
  pointer-events: none;
  mask-image: radial-gradient(circle at 50% 40%, #000 40%, transparent 82%);
}

.shell {
  position: relative;
  max-width: 1080px;
  margin: 0 auto;
  padding: 40px 24px 64px;
}

.brand {
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--ink-soft);
}

.hero {
  margin-top: 28px;
  display: grid;
  grid-template-columns: 1.1fr 0.9fr;
  align-items: center;
  gap: 20px;
}

.hero-copy {
  display: grid;
  gap: 16px;
}

.hero-image-wrap {
  position: relative;
  border-radius: 20px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.76);
  overflow: hidden;
  box-shadow: 0 14px 40px rgba(23, 32, 38, 0.08);
  aspect-ratio: 16 / 10;
}

.hero-image-wrap::before {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.08), rgba(23, 32, 38, 0));
  pointer-events: none;
}

.hero-image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center top;
  transform: translateY(0);
  animation: heroFloat 8s ease-in-out infinite;
}

@keyframes heroFloat {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-4px); }
}

h1 {
  margin: 0;
  font-size: clamp(2rem, 7.6vw, 5rem);
  line-height: 0.95;
  max-width: 13ch;
  text-wrap: balance;
}

.lead {
  margin: 0;
  max-width: 60ch;
  color: var(--ink-soft);
  font-size: clamp(1rem, 2.2vw, 1.2rem);
  line-height: 1.55;
}

.grid {
  margin-top: 30px;
  display: grid;
  grid-template-columns: 1.2fr 0.8fr;
  gap: 18px;
}

.panel {
  border: 1px solid var(--line);
  background: var(--card);
  backdrop-filter: blur(8px);
  border-radius: 18px;
  padding: 20px;
  position: relative;
  overflow: hidden;
}

.panel::after {
  content: "";
  position: absolute;
  width: 200px;
  height: 200px;
  right: -70px;
  top: -90px;
  background: radial-gradient(circle, rgba(17, 122, 122, 0.2), transparent 68%);
}

.motion {
  position: relative;
  height: 160px;
  border-radius: 14px;
  border: 1px dashed rgba(23, 32, 38, 0.25);
  overflow: hidden;
  margin-bottom: 14px;
  background: linear-gradient(120deg, rgba(255, 255, 255, 0.65), rgba(247, 246, 244, 0.8));
}

.merge-scene .merge-line {
  position: absolute;
  left: 18%;
  right: 24%;
  top: 50%;
  height: 2px;
  transform: translateY(-50%);
  background: linear-gradient(90deg, rgba(23, 32, 38, 0.12), rgba(17, 122, 122, 0.26), rgba(23, 32, 38, 0.1));
}

.source-card {
  position: absolute;
  left: 8%;
  width: 128px;
  height: 46px;
  border-radius: 11px;
  border: 1px solid rgba(23, 32, 38, 0.14);
  background: rgba(255, 255, 255, 0.92);
  display: grid;
  place-items: center;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--ink-soft);
  box-shadow: 0 8px 20px rgba(23, 32, 38, 0.08);
  transform-origin: center;
}

.source-card.s1 {
  top: 20px;
  animation: mergeS1 5.4s ease-in-out infinite;
}

.source-card.s2 {
  top: 57px;
  animation: mergeS2 5.4s ease-in-out infinite;
  animation-delay: 0.22s;
}

.source-card.s3 {
  top: 94px;
  animation: mergeS3 5.4s ease-in-out infinite;
  animation-delay: 0.44s;
}

.digest-node {
  position: absolute;
  right: 9%;
  top: 50%;
  transform: translateY(-50%);
  width: 138px;
  height: 66px;
  border-radius: 14px;
  border: 1px solid rgba(17, 122, 122, 0.34);
  background: linear-gradient(135deg, rgba(17, 122, 122, 0.16), rgba(15, 95, 95, 0.28));
  color: #0e4e4e;
  display: grid;
  place-items: center;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  box-shadow: 0 10px 28px rgba(17, 122, 122, 0.18);
  animation: digestPulse 5.4s ease-in-out infinite;
}

.digest-glow {
  position: absolute;
  right: calc(9% + 58px);
  top: 50%;
  width: 20px;
  height: 20px;
  border-radius: 999px;
  transform: translate(50%, -50%);
  background: radial-gradient(circle, rgba(17, 122, 122, 0.48), rgba(17, 122, 122, 0));
  animation: glowPulse 5.4s ease-in-out infinite;
}

@keyframes mergeS1 {
  0%, 16% { transform: translate3d(0, 0, 0) scale(1); opacity: 0.96; }
  45%, 60% { transform: translate3d(220px, 37px, 0) scale(0.72); opacity: 0.15; }
  100% { transform: translate3d(0, 0, 0) scale(1); opacity: 0.96; }
}

@keyframes mergeS2 {
  0%, 16% { transform: translate3d(0, 0, 0) scale(1); opacity: 0.96; }
  45%, 60% { transform: translate3d(220px, 0, 0) scale(0.72); opacity: 0.15; }
  100% { transform: translate3d(0, 0, 0) scale(1); opacity: 0.96; }
}

@keyframes mergeS3 {
  0%, 16% { transform: translate3d(0, 0, 0) scale(1); opacity: 0.96; }
  45%, 60% { transform: translate3d(220px, -37px, 0) scale(0.72); opacity: 0.15; }
  100% { transform: translate3d(0, 0, 0) scale(1); opacity: 0.96; }
}

@keyframes digestPulse {
  0%, 34%, 100% { transform: translateY(-50%) scale(1); }
  50% { transform: translateY(-50%) scale(1.06); }
}

@keyframes glowPulse {
  0%, 34%, 100% { transform: translate(50%, -50%) scale(0.8); opacity: 0.28; }
  50% { transform: translate(50%, -50%) scale(1.6); opacity: 0.76; }
}

.list {
  margin: 0;
  padding-left: 18px;
  color: var(--ink-soft);
  line-height: 1.6;
}

.subscribe-box {
  display: grid;
  gap: 10px;
}

label {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--ink-soft);
}

input[type="email"] {
  width: 100%;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.92);
  padding: 13px 14px;
  color: var(--ink);
  font-size: 15px;
  outline: none;
}

input[type="email"]:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(17, 122, 122, 0.16);
}

button {
  border: 0;
  border-radius: 12px;
  padding: 12px 14px;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
  background: linear-gradient(120deg, var(--accent), #0f5f5f);
  color: #f6fbfb;
  transition: transform 0.16s ease, filter 0.16s ease;
}

button:hover {
  transform: translateY(-1px);
  filter: saturate(1.08);
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.72;
  transform: none;
  filter: grayscale(0.15);
}

button.is-loading {
  background: linear-gradient(120deg, #7c8a91, #6f7d84);
  color: #eef4f6;
}

.btn-inner {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.35);
  border-top-color: rgba(255, 255, 255, 0.95);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.status {
  min-height: 22px;
  margin: 0;
  font-size: 14px;
  color: var(--ink-soft);
}

.status.ok { color: #1f7a44; }
.status.err { color: #962b3f; }

textarea {
  width: 100%;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.92);
  padding: 13px 14px;
  color: var(--ink);
  font-size: 15px;
  outline: none;
  resize: vertical;
  min-height: 110px;
}

textarea:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(17, 122, 122, 0.16);
}

.feedback-row {
  margin-top: 18px;
}

.feedback-panel {
  max-width: 820px;
  margin: 0 auto;
}

.small {
  font-size: 12px;
  color: var(--ink-soft);
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(10, 16, 20, 0.42);
  display: none;
  align-items: center;
  justify-content: center;
  padding: 20px;
  z-index: 30;
}

.modal-backdrop.open {
  display: flex;
}

.modal-card {
  width: min(460px, 100%);
  border-radius: 16px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.96);
  padding: 20px;
  box-shadow: 0 24px 54px rgba(15, 26, 34, 0.24);
}

.modal-card h3 {
  margin: 0 0 8px;
  font-size: 1.2rem;
}

.modal-card p {
  margin: 0;
  color: var(--ink-soft);
  line-height: 1.5;
}

.modal-actions {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}

@media (max-width: 860px) {
  .hero {
    grid-template-columns: 1fr;
  }

  .grid {
    grid-template-columns: 1fr;
  }

  .hero-image-wrap {
    aspect-ratio: 16 / 11;
  }
}
`;

const LANDING_JS = `
const form = document.getElementById("subscribe-form");
const emailInput = document.getElementById("email");
const websiteInput = document.getElementById("website");
const statusEl = document.getElementById("status");
const countEl = document.getElementById("count");
const submitBtn = document.getElementById("submit-btn");
const feedbackForm = document.getElementById("feedback-form");
const feedbackEmailInput = document.getElementById("feedback-email");
const feedbackTextInput = document.getElementById("feedback-text");
const feedbackWebsiteInput = document.getElementById("feedback-website");
const feedbackStatusEl = document.getElementById("feedback-status");
const feedbackSubmitBtn = document.getElementById("feedback-submit-btn");
const modal = document.getElementById("confirm-modal");
const modalTitle = document.getElementById("confirm-title");
const modalBody = document.getElementById("confirm-body");
const modalCloseBtn = document.getElementById("confirm-close");

const injectionHints = [
  "ignore previous instructions",
  "system prompt",
  "assistant:",
  "<script",
  "javascript:",
  "drop table",
  "union select",
  "\`\`\`"
];

function isLikelyValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(value);
}

function hasInjectionPattern(value) {
  const normalized = value.toLowerCase();
  return injectionHints.some((pattern) => normalized.includes(pattern));
}

function setStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = "status" + (type ? " " + type : "");
}

function setButtonLoading(button, loading, label) {
  if (loading) {
    button.disabled = true;
    button.classList.add("is-loading");
    button.innerHTML = '<span class="btn-inner"><span class="spinner" aria-hidden="true"></span><span>' + label + '</span></span>';
    return;
  }

  button.disabled = false;
  button.classList.remove("is-loading");
  button.textContent = button.dataset.defaultLabel || "Submit";
}

function openConfirmModal(title, message) {
  modalTitle.textContent = title;
  modalBody.textContent = message;
  modal.classList.add("open");
}

function closeConfirmModal() {
  modal.classList.remove("open");
}

submitBtn.dataset.defaultLabel = submitBtn.textContent;
feedbackSubmitBtn.dataset.defaultLabel = feedbackSubmitBtn.textContent;

modalCloseBtn.addEventListener("click", closeConfirmModal);
modal.addEventListener("click", (event) => {
  if (event.target === modal) {
    closeConfirmModal();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeConfirmModal();
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const email = emailInput.value.trim().toLowerCase();
  const website = websiteInput.value.trim();

  if (!isLikelyValidEmail(email)) {
    setStatus("Enter a valid email address.", "err");
    return;
  }

  if (hasInjectionPattern(email)) {
    setStatus("Input rejected by security checks.", "err");
    return;
  }

  setButtonLoading(submitBtn, true, "Reserving spot...");
  setStatus("Submitting...", "");

  try {
    const response = await fetch("/api/subscribe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email, website })
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      setStatus(payload.message || "Subscription failed.", "err");
      return;
    }

    if (typeof payload.currentCount === "number") {
      countEl.textContent = String(payload.currentCount);
    }

    if (payload.status === "already_subscribed") {
      setStatus("You are already on the list.", "ok");
      return;
    }

    setStatus("You are in. Welcome to Shelly.", "ok");
    openConfirmModal("Spot confirmed", "You are on the Shelly waitlist. We will keep you posted.");
    form.reset();
  } catch {
    setStatus("Network error. Please try again.", "err");
  } finally {
    setButtonLoading(submitBtn, false, "");
  }
});

function setFeedbackStatus(message, type) {
  feedbackStatusEl.textContent = message;
  feedbackStatusEl.className = "status" + (type ? " " + type : "");
}

feedbackForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const email = feedbackEmailInput.value.trim().toLowerCase();
  const feedback = feedbackTextInput.value.trim();
  const website = feedbackWebsiteInput.value.trim();

  if (!isLikelyValidEmail(email)) {
    setFeedbackStatus("Enter a valid email address.", "err");
    return;
  }

  if (feedback.length < 8) {
    setFeedbackStatus("Please add a bit more detail.", "err");
    return;
  }

  if (hasInjectionPattern(email) || hasInjectionPattern(feedback)) {
    setFeedbackStatus("Input rejected by security checks.", "err");
    return;
  }

  setButtonLoading(feedbackSubmitBtn, true, "Sending feedback...");
  setFeedbackStatus("Submitting feedback...", "");

  try {
    const response = await fetch("/api/feedback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email, feedback, website })
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      setFeedbackStatus(payload.message || "Feedback submission failed.", "err");
      return;
    }

    setFeedbackStatus("Thanks. Your feedback was received.", "ok");
    openConfirmModal("Feedback submitted", "Thanks for helping improve Shelly. We read every feedback note.");
    feedbackForm.reset();
  } catch {
    setFeedbackStatus("Network error. Please try again.", "err");
  } finally {
    setButtonLoading(feedbackSubmitBtn, false, "");
  }
});
`;

const LANDING_HTML = `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Shelly | All your newsletters in a nutshell.</title>
    <meta
      name="description"
      content="Shelly turns inbox overload into one clean daily digest. Join the early access list."
    />
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main class="shell">
      <div class="brand">Shelly</div>
      <section class="hero">
        <div class="hero-copy">
          <h1>All your newsletters in a nutshell.</h1>
          <p class="lead">
            Shelly subscribes to your favorite newsletters and combines them into one calm, AI-curated morning brief.
            Pull signal from sources like TLDR Tech, The Rundown AI, AI Snacks, and more without inbox chaos.
          </p>
        </div>
        <div class="hero-image-wrap">
          <img
            class="hero-image"
            src="/assets/Gemini_Generated_Image_neuji2neuji2neuj.png"
            alt="Shelly merging multiple newsletters into one concise digest"
            loading="eager"
          />
        </div>
      </section>

      <section class="grid">
        <article class="panel">
          <div class="motion merge-scene" aria-hidden="true">
            <div class="merge-line"></div>
            <div class="source-card s1">TLDR</div>
            <div class="source-card s2">Lenny</div>
            <div class="source-card s3">The Rundown</div>
            <div class="digest-glow"></div>
            <div class="digest-node">One Digest</div>
          </div>
          <h2>Built for focus</h2>
          <ul class="list">
            <li>Absolutely free during beta.</li>
            <li>We only ask for your feedback to make Shelly better.</li>
            <li>Daily digest built once, then delivered safely.</li>
            <li>Security-first subscriber intake with strict validation.</li>
            <li>Agent-powered summarization with deterministic delivery.</li>
          </ul>
        </article>

        <aside class="panel">
          <h2>Join the waitlist</h2>
          <form id="subscribe-form" class="subscribe-box" novalidate>
            <label for="email">Email</label>
            <input id="email" name="email" type="email" autocomplete="email" maxlength="254" required />
            <input
              id="website"
              name="website"
              type="text"
              autocomplete="off"
              tabindex="-1"
              aria-hidden="true"
              style="display:none"
            />
            <button id="submit-btn" type="submit">Reserve my spot</button>
          </form>
          <p id="status" class="status" role="status" aria-live="polite"></p>
          <p class="small">Live seats: <span id="count">-</span> / ${SUBSCRIBER_CAP}</p>
        </aside>
      </section>

      <section class="feedback-row">
        <aside class="panel feedback-panel">
          <h2>Give quick feedback</h2>
          <p class="small">Shelly is free in beta. Your feedback shapes what ships next.</p>
          <form id="feedback-form" class="subscribe-box" novalidate>
            <label for="feedback-email">Email</label>
            <input id="feedback-email" name="feedback-email" type="email" autocomplete="email" maxlength="254" required />
            <label for="feedback-text">Feedback</label>
            <textarea id="feedback-text" name="feedback-text" maxlength="2000" required></textarea>
            <input
              id="feedback-website"
              name="feedback-website"
              type="text"
              autocomplete="off"
              tabindex="-1"
              aria-hidden="true"
              style="display:none"
            />
            <button id="feedback-submit-btn" type="submit">Send feedback</button>
          </form>
          <p id="feedback-status" class="status" role="status" aria-live="polite"></p>
        </aside>
      </section>

      <div id="confirm-modal" class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <div class="modal-card">
          <h3 id="confirm-title">Confirmed</h3>
          <p id="confirm-body"></p>
          <div class="modal-actions">
            <button id="confirm-close" type="button">Close</button>
          </div>
        </div>
      </div>
    </main>
    <script src="/app.js" defer></script>
  </body>
</html>
`;

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
}

function contentTypeForAsset(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lower.endsWith(".webp")) {
    return "image/webp";
  }
  if (lower.endsWith(".gif")) {
    return "image/gif";
  }
  if (lower.endsWith(".svg")) {
    return "image/svg+xml";
  }
  return "application/octet-stream";
}

function sendJson(res: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  setSecurityHeaders(res);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

function shouldForwardToVps(channel: "subscribe" | "feedback"): boolean {
  const target = channel === "subscribe" ? VPS_SUBSCRIBE_URL : VPS_FEEDBACK_URL;
  return target.length > 0;
}

function getVpsForwardTarget(channel: "subscribe" | "feedback"): string {
  return channel === "subscribe" ? VPS_SUBSCRIBE_URL : VPS_FEEDBACK_URL;
}

async function forwardToVps(
  channel: "subscribe" | "feedback",
  payload: Record<string, unknown>
): Promise<{ statusCode: number; payload: Record<string, unknown> }> {
  if (INTAKE_FORWARD_SECRET.length < 20) {
    throw new Error("INTAKE_FORWARD_SECRET is missing or too short");
  }

  const target = getVpsForwardTarget(channel);
  if (target.length === 0) {
    throw new Error(`VPS forward URL is missing for ${channel}`);
  }

  const response = await fetch(target, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [INTAKE_AUTH_HEADER]: INTAKE_FORWARD_SECRET
    },
    body: JSON.stringify(payload)
  });

  let parsedPayload: Record<string, unknown> = {};
  try {
    const raw = await response.json();
    if (raw && typeof raw === "object") {
      parsedPayload = raw as Record<string, unknown>;
    }
  } catch {
    // Keep empty object fallback when upstream payload is not JSON.
  }

  return {
    statusCode: response.status,
    payload: parsedPayload
  };
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

  throw new Error("Invalid subscribers file format");
}

async function readSubscribers(): Promise<string[]> {
  try {
    const raw = await readFile(SUBSCRIBERS_FILE, "utf8");
    return parseSubscribers(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOENT/.test(message)) {
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

function isAllowedOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }
  const host = req.headers.host;
  if (!host) {
    return false;
  }
  return origin === `http://${host}` || origin === `https://${host}`;
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
  if (!isAllowedOrigin(req)) {
    sendJson(res, 403, { message: "Origin not allowed" });
    return;
  }

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

  if (shouldForwardToVps("subscribe")) {
    try {
      const forwarded = await forwardToVps("subscribe", { email, website });
      sendJson(res, forwarded.statusCode, forwarded.payload);
    } catch {
      sendJson(res, 502, { message: "Upstream intake unavailable" });
    }
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
  if (!isAllowedOrigin(req)) {
    sendJson(res, 403, { message: "Origin not allowed" });
    return;
  }

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

  if (shouldForwardToVps("feedback")) {
    try {
      const forwarded = await forwardToVps("feedback", { email, feedback, website });
      sendJson(res, forwarded.statusCode, forwarded.payload);
    } catch {
      sendJson(res, 502, { message: "Upstream intake unavailable" });
    }
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

  if (method === "GET" && url === "/") {
    setSecurityHeaders(res);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(LANDING_HTML);
    return;
  }

  if (method === "GET" && url === "/styles.css") {
    setSecurityHeaders(res);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/css; charset=utf-8");
    res.end(LANDING_CSS);
    return;
  }

  if (method === "GET" && url === "/app.js") {
    setSecurityHeaders(res);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.end(LANDING_JS);
    return;
  }

  if (method === "GET" && url.startsWith("/assets/")) {
    const relative = decodeURIComponent(url.slice("/assets/".length));
    const normalized = path.normalize(relative);
    const assetPath = path.resolve(ASSETS_DIR, normalized);

    if (!assetPath.startsWith(`${ASSETS_DIR}${path.sep}`)) {
      sendJson(res, 400, { message: "Invalid asset path" });
      return;
    }

    try {
      const data = await readFile(assetPath);
      setSecurityHeaders(res);
      res.statusCode = 200;
      res.setHeader("Content-Type", contentTypeForAsset(assetPath));
      res.end(data);
    } catch {
      sendJson(res, 404, { message: "Asset not found" });
    }
    return;
  }

  if (method === "GET" && url === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && url === "/api/subscribe") {
    await handleSubscribe(req, res);
    return;
  }

  if (method === "POST" && url === "/api/feedback") {
    await handleFeedback(req, res);
    return;
  }

  sendJson(res, 404, { message: "Not found" });
});

server.listen(PORT, () => {
  process.stdout.write(`Landing page listening on http://localhost:${PORT}\n`);
  process.stdout.write(`Subscriber file: ${SUBSCRIBERS_FILE}\n`);
  process.stdout.write(`Subscriber cap: ${SUBSCRIBER_CAP}\n`);
  if (VPS_SUBSCRIBE_URL && VPS_FEEDBACK_URL) {
    process.stdout.write(`Forward mode enabled: subscribe -> ${VPS_SUBSCRIBE_URL}, feedback -> ${VPS_FEEDBACK_URL}\n`);
  }
});
