import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyGitHubWebhookSignature } from "../../src/lib/security/webhook";

const secret = "phase-001-test-webhook-secret";

function signatureFor(body: Uint8Array): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("GitHub webhook signature verification", () => {
  it("verifies the exact raw request bytes", () => {
    const rawBody = Buffer.from('{"action":"opened","value":"é"}', "utf8");

    expect(
      verifyGitHubWebhookSignature(rawBody, signatureFor(rawBody), secret),
    ).toBe(true);
    expect(
      verifyGitHubWebhookSignature(
        Buffer.from('{"action":"opened","value":"e"}', "utf8"),
        signatureFor(rawBody),
        secret,
      ),
    ).toBe(false);
  });

  it.each([undefined, "", "sha1=deadbeef", "sha256=not-hex", "sha256=00"]) (
    "rejects malformed signature %s",
    (signature) => {
      expect(
        verifyGitHubWebhookSignature(Buffer.from("{}", "utf8"), signature, secret),
      ).toBe(false);
    },
  );
});
