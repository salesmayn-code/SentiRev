import { describe, expect, it } from "vitest";

import {
  createInstallState,
  createOAuthState,
  readInstallState,
  readOAuthState,
  safeReturnTo,
} from "../../../src/lib/auth/state";

const secret = "phase-001-test-auth-secret-that-is-long-enough";

describe("OAuth and installation state", () => {
  it("round-trips an OAuth state and local return path", () => {
    const created = createOAuthState("/connect?from=landing", secret, 1_000);
    const read = readOAuthState(created.value, created.state, secret, 1_001);

    expect(read?.returnTo).toBe("/connect?from=landing");
    expect(read?.state).toBe(created.state);
  });

  it("rejects wrong, expired, and external state", () => {
    const created = createOAuthState("https://attacker.example", secret, 1_000);

    expect(safeReturnTo("https://attacker.example")).toBe("/dashboard");
    expect(readOAuthState(created.value, "0".repeat(64), secret, 1_001)).toBeNull();
    expect(readOAuthState(created.value, created.state, secret, 601_001)).toBeNull();
  });

  it("binds installation state to the authenticated user", () => {
    const created = createInstallState("user-1", "/connect", secret, 1_000);

    expect(
      readInstallState(created.value, created.state, "user-1", secret, 1_001)?.userId,
    ).toBe("user-1");
    expect(
      readInstallState(created.value, created.state, "user-2", secret, 1_001),
    ).toBeNull();
  });
});
