import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_PREFIX = "sha256=";
const DIGEST_LENGTH = 32;

/**
 * Verify the GitHub signature against the exact bytes received over the wire.
 * Parsing JSON or normalizing text before this check would weaken the boundary.
 */
export function verifyGitHubWebhookSignature(
  rawBody: Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!signatureHeader?.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }

  const suppliedHex = signatureHeader.slice(SIGNATURE_PREFIX.length);
  if (!/^[a-f0-9]{64}$/iu.test(suppliedHex)) {
    return false;
  }

  const supplied = Buffer.from(suppliedHex, "hex");
  if (supplied.length !== DIGEST_LENGTH) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(expected, supplied);
}
