export interface NewsletterItem {
  messageId: string;
  source: string;
  subject: string;
  receivedAt: Date | null;
  textContent: string;
  htmlContent: string;
  aiSummary: string;
  links: string[];
  imageUrls: string[];
  raw: Record<string, unknown>;
}

export interface DigestSection {
  source: string;
  subject: string;
  receivedAt: string;
  summary: string;
  links: string[];
  imageUrls: string[];
}

export interface Digest {
  dateLabel: string;
  totalItems: number;
  sections: DigestSection[];
  htmlBody: string;
  textBody: string;
}
