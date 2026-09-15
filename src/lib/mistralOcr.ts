const MISTRAL_OCR_ENDPOINT = "https://api.mistral.ai/v1/ocr";
const OCR_REQUEST_TIMEOUT_MS = 30_000;

function getOcrModel(): string {
  return process.env.MISTRAL_OCR_MODEL ?? "mistral-ocr-2512";
}

function getApiKey(): string | undefined {
  return process.env.MISTRAL_API_KEY;
}

interface OcrPage {
  markdown?: string;
}

interface OcrResponse {
  pages?: OcrPage[];
}

function isImage(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

/** Extracts text from a single Jira attachment (image or PDF) via Mistral OCR. Never throws - returns null on any failure, matching this codebase's "never break the page" fallback philosophy. */
export async function ocrAttachment(
  fileBuffer: Buffer,
  mimeType: string,
): Promise<string | null> {
  const apiKey = getApiKey();

  if (!apiKey) {
    return null;
  }

  const dataUrl = `data:${mimeType};base64,${fileBuffer.toString("base64")}`;
  const document = isImage(mimeType)
    ? { image_url: dataUrl, type: "image_url" }
    : { document_url: dataUrl, type: "document_url" };

  try {
    const response = await fetch(MISTRAL_OCR_ENDPOINT, {
      body: JSON.stringify({
        document,
        model: getOcrModel(),
      }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(OCR_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.warn(`Mistral OCR returned status ${response.status}; skipping this attachment.`);
      return null;
    }

    const data = (await response.json()) as OcrResponse;
    const text = (data.pages ?? [])
      .map((page) => page.markdown ?? "")
      .join("\n\n")
      .trim();

    return text || null;
  } catch (error) {
    console.warn("Mistral OCR request failed; skipping this attachment.", error);
    return null;
  }
}
