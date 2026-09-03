import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { GET as finishOAuth } from "@/app/api/auth/github/callback/route";
import { GET as startOAuth } from "@/app/api/auth/github/route";
import { GET as logout } from "@/app/api/auth/logout/route";
import { prisma } from "@/lib/db/client";
import {
  SESSION_COOKIE_NAME,
  readSessionValue,
} from "@/lib/auth/session";
import {
  OAUTH_STATE_COOKIE_NAME,
  createOAuthState,
} from "@/lib/auth/state";

const githubUserId = `phase-001-oauth-${Date.now()}`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { githubUserId } });
  await prisma.$disconnect();
});

describe("GitHub OAuth route boundary", () => {
  it("starts OAuth with the configured callback and a safe local return path", async () => {
    const response = await startOAuth(
      new Request(
        `${process.env.SENTIREV_APP_URL}/api/auth/github?returnTo=https://attacker.example`,
      ),
    );
    const location = new URL(response.headers.get("location")!);

    expect(location.origin).toBe("https://github.com");
    expect(location.pathname).toBe("/login/oauth/authorize");
    expect(location.searchParams.get("scope")).toBeNull();
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${process.env.SENTIREV_APP_URL}/api/auth/callback/github`,
    );
    expect(response.cookies.get(OAUTH_STATE_COOKIE_NAME)?.value).toBeTruthy();
  });

  it("completes a state-bound callback and issues an encrypted expiring session", async () => {
    const oauthState = createOAuthState("/dashboard");
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(
          Response.json({ access_token: "phase-001-oauth-access-token" }),
        )
        .mockResolvedValueOnce(
          Response.json({ id: githubUserId, login: "phase-001-oauth-user" }),
        ),
    );
    const response = await finishOAuth(
      new Request(
        `${process.env.SENTIREV_APP_URL}/api/auth/callback/github?code=one-time-code&state=${oauthState.state}`,
        {
          headers: {
            cookie: `${OAUTH_STATE_COOKIE_NAME}=${oauthState.value}`,
          },
        },
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${process.env.SENTIREV_APP_URL}/dashboard`);
    const sessionCookie = response.cookies.get(SESSION_COOKIE_NAME)?.value;
    const session = readSessionValue(sessionCookie);
    expect(session).toMatchObject({
      githubUserId,
      githubLogin: "phase-001-oauth-user",
      accessToken: "phase-001-oauth-access-token",
    });
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=lax");
    expect(
      await prisma.user.findUnique({ where: { githubUserId } }),
    ).toMatchObject({ login: "phase-001-oauth-user" });
  });

  it("rejects a callback without matching state before any token request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await finishOAuth(
      new Request(
        `${process.env.SENTIREV_APP_URL}/api/auth/callback/github?code=untrusted&state=wrong`,
      ),
    );

    expect(response.headers.get("location")).toBe(
      `${process.env.SENTIREV_APP_URL}/login?error=invalid_oauth_state`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears the application session on logout", async () => {
    const response = await logout(
      new Request(`${process.env.SENTIREV_APP_URL}/api/auth/logout`),
    );

    expect(response.headers.get("location")).toBe(`${process.env.SENTIREV_APP_URL}/`);
    expect(response.headers.get("set-cookie")).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
