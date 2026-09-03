import { NextResponse } from "next/server";

import { getServerEnvironment } from "@/lib/env";
import {
  OAUTH_STATE_COOKIE_NAME,
  createOAuthState,
  safeReturnTo,
  stateCookieOptions,
} from "@/lib/auth/state";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<NextResponse> {
  const environment = getServerEnvironment();
  const requestUrl = new URL(request.url);
  const returnTo = safeReturnTo(requestUrl.searchParams.get("returnTo"));
  const { state, value } = createOAuthState(
    returnTo,
    environment.SENTIREV_AUTH_SECRET,
  );
  const callbackUrl = new URL(
    "/api/auth/callback/github",
    environment.SENTIREV_APP_URL,
  );
  const githubUrl = new URL("https://github.com/login/oauth/authorize");
  githubUrl.searchParams.set(
    "client_id",
    environment.SENTIREV_GITHUB_CLIENT_ID,
  );
  githubUrl.searchParams.set("redirect_uri", callbackUrl.toString());
  githubUrl.searchParams.set("state", state);

  const response = NextResponse.redirect(githubUrl);
  response.cookies.set(OAUTH_STATE_COOKIE_NAME, value, stateCookieOptions());
  return response;
}
