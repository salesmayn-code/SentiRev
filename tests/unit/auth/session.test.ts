import { describe, expect, it } from "vitest";

import {
  createSessionValue,
  readSessionValue,
  SESSION_MAX_AGE_SECONDS,
} from "../../../src/lib/auth/session";

const secret = "phase-001-test-auth-secret-that-is-long-enough";

describe("authenticated session values", () => {
  it("round-trips an encrypted session and expires it", () => {
    const createdAt = 10_000;
    const value = createSessionValue(
      {
        userId: "user-1",
        githubUserId: "42",
        githubLogin: "octocat",
        accessToken: "oauth-token-for-test-only",
      },
      secret,
      createdAt,
    );

    expect(readSessionValue(value, secret, createdAt + 1)?.githubLogin).toBe("octocat");
    expect(
      readSessionValue(value, secret, createdAt + SESSION_MAX_AGE_SECONDS * 1_000 + 1),
    ).toBeNull();
  });

  it("rejects a tampered or differently keyed value", () => {
    const value = createSessionValue(
      {
        userId: "user-1",
        githubUserId: "42",
        githubLogin: "octocat",
        accessToken: "oauth-token-for-test-only",
      },
      secret,
      10_000,
    );

    const segments = value.split(".");
    const ciphertext = Buffer.from(segments[2], "base64url");
    ciphertext[0] ^= 1;
    segments[2] = ciphertext.toString("base64url");
    const tampered = segments.join(".");
    expect(readSessionValue(tampered, secret, 10_001)).toBeNull();
    expect(readSessionValue(value, `${secret}-different`, 10_001)).toBeNull();
  });
});
