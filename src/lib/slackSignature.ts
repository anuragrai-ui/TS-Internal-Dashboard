import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_TIMESTAMP_SKEW_SECONDS = 300;

export interface VerifySlackSignatureOptions {
  rawBody: string;
  signature: string;
  signingSecret: string;
  timestamp: string;
}

export function verifySlackSignature(opts: VerifySlackSignatureOptions): boolean {
  const { rawBody, signature, signingSecret, timestamp } = opts;
  const timestampSeconds = Number(timestamp);
  const nowSeconds = Math.floor(Date.now() / 1000);

  /* Number("not-a-number") is NaN, and NaN > 300 is false - guard explicitly
     so a malformed timestamp fails closed instead of skipping the replay check. */
  if (
    !Number.isFinite(timestampSeconds) ||
    Math.abs(nowSeconds - timestampSeconds) > MAX_TIMESTAMP_SKEW_SECONDS
  ) {
    return false;
  }

  const computedSignature = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;

  const computedBuffer = Buffer.from(computedSignature);
  const signatureBuffer = Buffer.from(signature);

  if (computedBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return timingSafeEqual(computedBuffer, signatureBuffer);
}
