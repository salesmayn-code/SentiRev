import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { getServerEnvironment } from "../env";
import { seal, unseal } from "../security/seal";

export const OAUTH_STATE_COOKIE_NAME = "sentirev_oauth_state";
export const INSTALL_STATE_COOKIE_NAME = "sentirev_install_state";
export const STATE_MAX_AGE_SECONDS = 10 * 60;

const oauthStateSchema = z.object({
  state: z.string().regex(/^[a-f0-9]{64}$/u),
  returnTo: z.string().startsWith("/"),
  expiresAt: z.number().int().positive(),
});

const installStateSchema = oauthStateSchema.extend({
  userId: z.string().min(1),
});

export type OAuthState = z.infer<typeof oauthStateSchema>;
export type InstallState = z.infer<typeof installStateSchema>;

export function safeReturnTo(value: string | null | undefined, fallback = "/dashboard") {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return fallback;
  }

  try {
    const parsed = new URL(value, "https://sentirev.invalid");
    if (parsed.origin !== "https://sentirev.invalid") {
      return fallback;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export function createOAuthState(
  returnTo: string,
  secret = getServerEnvironment().SENTIREV_AUTH_SECRET,
  now = Date.now(),
): { state: string; value: string } {
  const payload: OAuthState = {
    state: randomBytes(32).toString("hex"),
    returnTo: safeReturnTo(returnTo),
    expiresAt: now + STATE_MAX_AGE_SECONDS * 1_000,
  };
  return { state: payload.state, value: seal(payload, secret) };
}

export function readOAuthState(
  value: string | undefined,
  expectedState: string | null | undefined,
  secret = getServerEnvironment().SENTIREV_AUTH_SECRET,
  now = Date.now(),
): OAuthState | null {
  const parsed = oauthStateSchema.safeParse(unseal<unknown>(value ?? "", secret));
  if (!parsed.success || parsed.data.expiresAt <= now || !expectedState) {
    return null;
  }

  if (Buffer.byteLength(parsed.data.state) !== Buffer.byteLength(expectedState)) {
    return null;
  }

  const expected = Buffer.from(parsed.data.state, "utf8");
  const actual = Buffer.from(expectedState, "utf8");
  return timingSafeEqual(expected, actual) ? parsed.data : null;
}

export function createInstallState(
  userId: string,
  returnTo = "/connect",
  secret = getServerEnvironment().SENTIREV_AUTH_SECRET,
  now = Date.now(),
): { state: string; value: string } {
  const payload: InstallState = {
    state: randomBytes(32).toString("hex"),
    userId,
    returnTo: safeReturnTo(returnTo, "/connect"),
    expiresAt: now + STATE_MAX_AGE_SECONDS * 1_000,
  };
  return { state: payload.state, value: seal(payload, secret) };
}

export function readInstallState(
  value: string | undefined,
  expectedState: string | null | undefined,
  userId: string,
  secret = getServerEnvironment().SENTIREV_AUTH_SECRET,
  now = Date.now(),
): InstallState | null {
  const parsed = installStateSchema.safeParse(unseal<unknown>(value ?? "", secret));
  if (
    !parsed.success ||
    parsed.data.expiresAt <= now ||
    parsed.data.userId !== userId ||
    !expectedState
  ) {
    return null;
  }

  if (Buffer.byteLength(parsed.data.state) !== Buffer.byteLength(expectedState)) {
    return null;
  }

  const expected = Buffer.from(parsed.data.state, "utf8");
  const actual = Buffer.from(expectedState, "utf8");
  return timingSafeEqual(expected, actual) ? parsed.data : null;
}

export function stateCookieOptions(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: STATE_MAX_AGE_SECONDS,
  };
}
