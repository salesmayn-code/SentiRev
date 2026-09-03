import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth/session";
import {
  INSTALL_STATE_COOKIE_NAME,
  readInstallState,
  stateCookieOptions,
} from "@/lib/auth/state";
import { prisma } from "@/lib/db/client";
import { getServerEnvironment } from "@/lib/env";
import { getInstallation } from "@/lib/github/client";

export const runtime = "nodejs";

function redirectTo(
  environment: ReturnType<typeof getServerEnvironment>,
  path: string,
): NextResponse {
  return NextResponse.redirect(new URL(path, environment.SENTIREV_APP_URL));
}

function errorPath(code: string): string {
  const url = new URL("/connect", "https://sentirev.invalid");
  url.searchParams.set("error", code);
  return `${url.pathname}${url.search}`;
}

function clearInstallStateCookie(response: NextResponse): void {
  response.cookies.set(INSTALL_STATE_COOKIE_NAME, "", {
    ...stateCookieOptions(),
    maxAge: 0,
  });
}

export async function GET(request: Request): Promise<NextResponse> {
  const environment = getServerEnvironment();
  const requestUrl = new URL(request.url);
  const session = await getSession();
  const installState = readInstallState(
    request.headers.get("cookie")?.match(
      new RegExp(`${INSTALL_STATE_COOKIE_NAME}=([^;]+)`),
    )?.[1],
    requestUrl.searchParams.get("state"),
    session?.userId ?? "",
    environment.SENTIREV_AUTH_SECRET,
  );

  if (!session || !installState) {
    const response = redirectTo(environment, errorPath("invalid_install_state"));
    clearInstallStateCookie(response);
    return response;
  }

  const setupAction = requestUrl.searchParams.get("setup_action");
  if (setupAction !== "install" && setupAction !== "update") {
    const response = redirectTo(environment, errorPath("installation_cancelled"));
    clearInstallStateCookie(response);
    return response;
  }

  const installationIdValue = requestUrl.searchParams.get("installation_id");
  const installationId = Number(installationIdValue);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    const response = redirectTo(environment, errorPath("missing_installation"));
    clearInstallStateCookie(response);
    return response;
  }

  try {
    const installation = await getInstallation(installationId);
    if (installation.id !== installationId) {
      throw new Error("GitHub returned a mismatched installation");
    }

    const existing = await prisma.installation.findUnique({
      where: { githubInstallationId: String(installationId) },
      select: { ownerUserId: true },
    });
    if (existing && existing.ownerUserId !== session.userId) {
      const response = redirectTo(environment, errorPath("installation_not_allowed"));
      clearInstallStateCookie(response);
      return response;
    }

    await prisma.installation.upsert({
      where: { githubInstallationId: String(installationId) },
      update: { ownerUserId: session.userId },
      create: {
        githubInstallationId: String(installationId),
        ownerUserId: session.userId,
      },
    });

    const returnUrl = new URL(installState.returnTo, "https://sentirev.invalid");
    returnUrl.searchParams.set("installation_id", String(installationId));
    const response = redirectTo(
      environment,
      `${returnUrl.pathname}${returnUrl.search}${returnUrl.hash}`,
    );
    clearInstallStateCookie(response);
    return response;
  } catch {
    const response = redirectTo(environment, errorPath("installation_failed"));
    clearInstallStateCookie(response);
    return response;
  }
}
