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
  for (const line of lines) {
    const marker = /^-?\s*\[IMAGE_(\d+)\]\s*$/i.exec(line);
    if (marker) {
      const imageIndex = Number(marker[1]) - 1;
      const imageUrl = imageUrls[imageIndex];
      if (imageUrl) {
        parts.push(
          `<div style="margin:10px 0 12px 0;"><img src="${escapeHtml(imageUrl)}" alt="newsletter image ${imageIndex + 1}" style="display:block;max-width:100%;height:auto;border-radius:10px;border:1px solid #d6deea;background:#f8fafc;" onerror="this.style.display='none'"/></div>`
        );
      }
      continue;
    }

    const isBullet = line.startsWith("- ");
    const text = isBullet ? line.slice(2) : line;
    parts.push(
      `<p style="margin:0 0 8px 0;color:#1e293b;line-height:1.6;">${isBullet ? "&bull; " : ""}${escapeHtml(text)}</p>`
    );
  }

  return parts.join("\n");
}

function sectionToHtml(section: DigestSection): string {
  const cleanImages = normalizeImageUrls(section.imageUrls);

  const imagesBlock = cleanImages.length
    ? `<div style="margin-top:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;">${cleanImages
        .slice(0, 6)
        .map(
          (url) =>
            `<div><img src="${escapeHtml(url)}" alt="newsletter image" style="display:block;width:100%;height:auto;border-radius:10px;border:1px solid #d6deea;background:#f8fafc;" onerror="this.style.display='none'"/></div>`
        )
        .join("")}</div>`
    : "";

  const hasInlineImageMarkers = /\[IMAGE_\d+\]/i.test(section.summary);

  return `
    <article style="padding:18px 18px 16px 18px;border:1px solid #d6deea;border-radius:14px;margin-bottom:14px;background:#ffffff;box-shadow:0 2px 10px rgba(15,23,42,0.04);">
      <h3 style="margin:0 0 8px 0;color:#0f172a;font-size:28px;line-height:1.25;font-family:Georgia,serif;">${escapeHtml(section.subject)}</h3>
      ${renderSummaryHtml(section.summary, cleanImages)}
      ${hasInlineImageMarkers ? "" : imagesBlock}
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
    <main style="font-family:'Avenir Next',Avenir,'Segoe UI',sans-serif;background:#f1f5f9;padding:28px;">
      <section style="max-width:920px;margin:0 auto;">
        <header style="padding:12px 2px 14px 2px;">
          <h1 style="margin:0;color:#0f172a;font-size:42px;line-height:1.05;letter-spacing:-0.5px;">Shelly Digest</h1>
          <p style="margin:10px 0 0 0;color:#475569;font-size:14px;">Date: ${escapeHtml(dateLabel)} | Items: ${sections.length}</p>
        </header>
        ${sections.map(sectionToHtml).join("\n")}
      </section>
    </main>
  `;

  return {
    dateLabel,
    totalItems: sections.length,
    sections,
    htmlBody,
    textBody: textLines.join("\n")
  };
}
