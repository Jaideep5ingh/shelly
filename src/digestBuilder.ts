import type { Digest, DigestSection, NewsletterItem } from "./types.js";

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeUrl(raw: string): string {
  try {
    const url = new URL(raw.trim());
    if (!["http:", "https:"].includes(url.protocol)) {
      return "";
    }
    return url.toString();
  } catch {
    return "";
  }
}

function isLikelyRenderableImageUrl(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (!value) {
    return false;
  }

  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"].some((ext) => value.includes(ext))) {
    return true;
  }

  return ["media.beehiiv.com", "images", "img", "chart.ashx", "cdn-cgi/image"].some((token) => value.includes(token));
}

function normalizeImageUrls(imageUrls: string[]): string[] {
  const normalized = imageUrls
    .map(safeUrl)
    .filter((url) => url !== "" && isLikelyRenderableImageUrl(url));
  return [...new Set(normalized)].slice(0, 8);
}

function isLikelyUsefulImageUrl(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (!value) {
    return false;
  }

  if (value.includes("images.tldr.tech")) {
    return false;
  }

  let pathname = value;
  try {
    pathname = new URL(value).pathname.toLowerCase();
  } catch {
    pathname = value;
  }

  if (["logo", "wordmark", "avatar", "avatar", "icon", "badge", "lockup", "signature", "footer"].some((token) => pathname.includes(token))) {
    return false;
  }

  if (["chart", "graph", "diagram", "screenshot", "screen", "mockup", "product", "ui", "dashboard", "report", "photo", "hero"].some((token) => pathname.includes(token))) {
    return true;
  }

  const filename = pathname.split("/").pop() ?? "";
  const baseName = filename.replace(/\.(png|jpe?g|gif|webp|svg|avif)(\?.*)?$/, "");
  if (baseName.length <= 10 && !/[._-]/.test(baseName)) {
    return false;
  }

  return true;
}

function removeUrls(input: string): string {
  return input.replace(/https?:\/\/\S+/gi, "").trim();
}

function renderSummaryHtml(summary: string, imageUrls: string[]): string {
  const lines = summary
    .split("\n")
    .map((line) => removeUrls(line.trim()))
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return `<p style="margin:0;color:#1e293b;line-height:1.6;">No summary available.</p>`;
  }

  const parts: string[] = [];
  const hasBullets = lines.some((l) => l.startsWith("- "));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = /^-?\s*\[IMAGE_(\d+)\]\s*$/i.exec(line);
    if (marker) {
      const imageIndex = Number(marker[1]) - 1;
      const imageUrl = imageUrls[imageIndex];
      if (imageUrl && isLikelyUsefulImageUrl(imageUrl)) {
        parts.push(
          `<div style="margin:10px 0 12px 0;"><img src="${escapeHtml(imageUrl)}" alt="newsletter image ${imageIndex + 1}" style="display:block;max-width:100%;height:auto;border-radius:10px;border:1px solid #d6deea;background:#f8fafc;" onerror="this.style.display='none'"/></div>`
        );
      }
      continue;
    }

    const isBullet = line.startsWith("- ");
    // If the summary contains bullets but the first line is an intro (not prefixed with '- '),
    // treat that first line as a bullet so it displays consistently.
    const shouldBeBullet = isBullet || (i === 0 && hasBullets && !isBullet);
    const text = shouldBeBullet ? (isBullet ? line.slice(2) : line) : line;
    parts.push(
      `<p style="margin:0 0 8px 0;color:#1e293b;line-height:1.6;">${shouldBeBullet ? "&bull; " : ""}${escapeHtml(text)}</p>`
    );
  }

  return parts.join("\n");
}

function sectionToHtml(section: DigestSection): string {
  const cleanImages = normalizeImageUrls(section.imageUrls);

  return `
    <article style="padding:20px 20px 18px 20px;border:1px solid #d9e2ef;border-radius:18px;margin-bottom:16px;background:linear-gradient(180deg,#ffffff 0%,#fbfdff 100%);box-shadow:0 10px 30px rgba(15,23,42,0.06);">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:10px;">
        <div style="min-width:0;">
          <h3 style="margin:0;color:#0f172a;font-size:27px;line-height:1.15;font-family:'Iowan Old Style',Georgia,serif;letter-spacing:-0.02em;">${escapeHtml(section.subject)}</h3>
        </div>
      </div>
      ${renderSummaryHtml(section.summary, cleanImages)}
    </article>
  `;
}

export function buildDigest(dateLabel: string, items: NewsletterItem[], maxItems: number): Digest {
  const sections: DigestSection[] = items.slice(0, maxItems).map((item) => {
    if (!item.aiSummary.trim()) {
      throw new Error(`Missing AI summary for item '${item.subject}' from '${item.source}'`);
    }

    return {
      source: item.source,
      subject: item.subject,
      receivedAt: item.receivedAt ? item.receivedAt.toISOString() : "unknown",
      summary: item.aiSummary.trim(),
      links: item.links,
      imageUrls: item.imageUrls
    };
  });

  const textLines: string[] = [`Shelly Digest for ${dateLabel}`, "", `Total items: ${sections.length}`, ""];
  sections.forEach((section, index) => {
    textLines.push(`${index + 1}. ${section.subject}`);
    textLines.push(`   From: ${section.source}`);
    textLines.push(`   Received: ${section.receivedAt}`);
    textLines.push(`   Summary: ${removeUrls(section.summary)}`);
    if (section.imageUrls.length) {
      textLines.push(`   Images: ${section.imageUrls.slice(0, 4).join(" | ")}`);
    }
    textLines.push("");
  });

  const htmlBody = `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body style="margin:0 !important;padding:0 !important;background:linear-gradient(180deg,#eef4fb 0%,#f7f9fc 28%,#f8fafc 100%);font-family:'Avenir Next',Avenir,'Segoe UI',sans-serif;">
        <div style="margin:0;padding:0 14px 22px 14px;">
          <div style="max-width:860px;margin:0 auto;">
            <div style="padding:4px 2px 10px 2px;">
              <p style="margin:0 0 6px 0;color:#64748b;font-size:11px;line-height:1.4;text-transform:uppercase;letter-spacing:0.16em;font-weight:700;">Daily newsletter digest</p>
              <h1 style="margin:0;color:#0f172a;font-size:38px;line-height:1.05;letter-spacing:-0.8px;">Shelly Digest</h1>
              <p style="margin:6px 0 0 0;color:#475569;font-size:14px;line-height:1.5;">Date: ${escapeHtml(dateLabel)} · Items: ${sections.length}</p>
            </div>
            ${sections.map(sectionToHtml).join("\n")}
          </div>
        </div>
      </body>
    </html>
  `;

  return {
    dateLabel,
    totalItems: sections.length,
    sections,
    htmlBody,
    textBody: textLines.join("\n")
  };
}
