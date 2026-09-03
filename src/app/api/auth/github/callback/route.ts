import { NextResponse } from "next/server";

import { prisma } from "@/lib/db/client";
import { getServerEnvironment } from "@/lib/env";
import {
  exchangeOAuthCode,
  getGitHubUser,
} from "@/lib/github/client";
import {
  OAUTH_STATE_COOKIE_NAME,
  readOAuthState,
  stateCookieOptions,
} from "@/lib/auth/state";
import {
  createSessionValue,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from "@/lib/auth/session";

export const runtime = "nodejs";

function redirectTo(
  environment: ReturnType<typeof getServerEnvironment>,
  path: string,
): NextResponse {
  return NextResponse.redirect(new URL(path, environment.SENTIREV_APP_URL));
}

function addError(path: string, code: string): string {
  const url = new URL(path, "https://sentirev.invalid");
  url.searchParams.set("error", code);
  return `${url.pathname}${url.search}${url.hash}`;
}

function clearOAuthStateCookie(response: NextResponse): void {
  response.cookies.set(OAUTH_STATE_COOKIE_NAME, "", {
    ...stateCookieOptions(),
    maxAge: 0,
  });
}

export async function GET(request: Request): Promise<NextResponse> {
  const environment = getServerEnvironment();
  const requestUrl = new URL(request.url);
  const state = readOAuthState(
    request.headers.get("cookie")?.match(
      new RegExp(`${OAUTH_STATE_COOKIE_NAME}=([^;]+)`),
    )?.[1],
    requestUrl.searchParams.get("state"),
    environment.SENTIREV_AUTH_SECRET,
  );

  if (!state) {
    const response = redirectTo(environment, "/login?error=invalid_oauth_state");
    clearOAuthStateCookie(response);
    return response;
  }

  const oauthError = requestUrl.searchParams.get("error");
  if (oauthError) {
    const response = redirectTo(environment, addError(state.returnTo, "oauth_denied"));
    clearOAuthStateCookie(response);
    return response;
  }

  const code = requestUrl.searchParams.get("code");
  if (!code) {
    const response = redirectTo(environment, addError(state.returnTo, "missing_code"));
    clearOAuthStateCookie(response);
    return response;
  }

  try {
    const accessToken = await exchangeOAuthCode(code);
    const githubUser = await getGitHubUser(accessToken);
    const user = await prisma.user.upsert({
      where: { githubUserId: String(githubUser.id) },
      update: { login: githubUser.login },
      create: { githubUserId: String(githubUser.id), login: githubUser.login },
      select: { id: true, githubUserId: true, login: true },
    });
    const sessionValue = createSessionValue(
      {
        userId: user.id,
        githubUserId: user.githubUserId,
        githubLogin: user.login,
        accessToken,
      },
      environment.SENTIREV_AUTH_SECRET,
    );
    const response = redirectTo(environment, state.returnTo);
    response.cookies.set(
      SESSION_COOKIE_NAME,
      sessionValue,
      sessionCookieOptions(),
    );
    clearOAuthStateCookie(response);
    return response;
  } catch {
    const response = redirectTo(environment, addError(state.returnTo, "login_failed"));
    clearOAuthStateCookie(response);
    return response;
  }
}
