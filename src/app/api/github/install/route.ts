import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth/session";
import {
  createInstallState,
  INSTALL_STATE_COOKIE_NAME,
  stateCookieOptions,
} from "@/lib/auth/state";
import { getServerEnvironment } from "@/lib/env";
import { getGitHubAppInstallUrl } from "@/lib/github/client";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<NextResponse> {
  const environment = getServerEnvironment();
  const requestedMode = new URL(request.url).searchParams.get("consentMode");
  const consentMode = requestedMode === "static" ? "static" : "ai";
  const session = await getSession();
  if (!session) {
    const loginUrl = new URL(
      "/api/auth/github",
      environment.SENTIREV_APP_URL,
    );
    loginUrl.searchParams.set(
      "returnTo",
      `/api/github/install?consentMode=${consentMode}`,
    );
    return NextResponse.redirect(loginUrl);
  }

  const state = createInstallState(
    session.userId,
    `/connect?consentMode=${consentMode}`,
    environment.SENTIREV_AUTH_SECRET,
  );
  const response = NextResponse.redirect(
    getGitHubAppInstallUrl(state.state, environment.SENTIREV_GITHUB_APP_SLUG),
  );
  response.cookies.set(
    INSTALL_STATE_COOKIE_NAME,
    state.value,
    stateCookieOptions(),
  );
  return response;
}
