import { downloadAttachment, mapWithConcurrency } from "@/lib/jiraClient";
import type { FormattedIssue, OcrEligibleAttachment } from "@/lib/jiraClient";
import { ocrAttachment } from "@/lib/mistralOcr";
import { getRedis, isRedisConfigured } from "@/lib/redis";

const OCR_CACHE_PREFIX = "ocr:attachment:";
const OCR_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const OCR_CONCURRENCY = 3;

function ocrCacheKey(attachmentId: string): string {
  return `${OCR_CACHE_PREFIX}${attachmentId}`;
}

async function getCachedAttachmentText(attachmentId: string): Promise<string | null> {
  if (!isRedisConfigured()) {
    return null;
  }

  try {
    return await getRedis().get<string>(ocrCacheKey(attachmentId));
  } catch (error) {
    console.warn(`OCR cache read failed for attachment ${attachmentId}; treating as uncached.`, error);
    return null;
  }
}

async function setCachedAttachmentText(attachmentId: string, text: string): Promise<void> {
  if (!isRedisConfigured()) {
    return;
  }

  try {
    await getRedis().set(ocrCacheKey(attachmentId), text, { ex: OCR_CACHE_TTL_SECONDS });
  } catch (error) {
    console.warn(`OCR cache write failed for attachment ${attachmentId}; will be recomputed next time.`, error);
  }
}

/**
 * Fast, Redis-read-only. Returns already-OCR'd text for this issue's
 * attachments, or "" if none are cached yet (or Redis is unavailable).
 * Safe to call in the render path - never triggers a fresh OCR/download call,
 * so it can't add attachment-processing latency to a page load.
 */
export async function getCachedOcrTextForIssue(issue: FormattedIssue): Promise<string> {
  if (!isRedisConfigured() || issue.attachments.length === 0) {
    return "";
  }

  const texts = await Promise.all(
    issue.attachments.map(async (attachment) => {
      const cached = await getCachedAttachmentText(attachment.id);
      return cached ? `[${attachment.filename}]\n${cached}` : null;
    }),
  );

  return texts.filter((text): text is string => text !== null).join("\n\n");
}

async function ocrAndCacheAttachment(attachment: OcrEligibleAttachment): Promise<void> {
  const cached = await getCachedAttachmentText(attachment.id);

  if (cached !== null) {
    return;
  }

  try {
    const fileBuffer = await downloadAttachment(attachment.contentUrl);
    const text = await ocrAttachment(fileBuffer, attachment.mimeType);

    if (text) {
      await setCachedAttachmentText(attachment.id, text);
    }
  } catch (error) {
    console.warn(`Failed to OCR attachment ${attachment.filename} (${attachment.id}); skipping.`, error);
  }
}

/**
 * Best-effort background enrichment: OCRs any not-yet-cached eligible
 * attachments across the given issues. Meant to be invoked via next/server's
 * after() so it never delays the response that triggers it - results only
 * become visible (via getCachedOcrTextForIssue) on a LATER request, once
 * the analysis cache has also expired and a fresh analysis runs.
 */
export async function enqueueOcrForIssues(issues: FormattedIssue[]): Promise<void> {
  if (!isRedisConfigured()) {
    return;
  }

  const attachments = issues.flatMap((issue) => issue.attachments);

  if (attachments.length === 0) {
    return;
  }

  await mapWithConcurrency(attachments, OCR_CONCURRENCY, ocrAndCacheAttachment);
}
