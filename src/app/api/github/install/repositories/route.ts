import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth/session";
import {
  RepositoryAuthorizationError,
  requireRepositoryAdmin,
} from "@/lib/auth/authorization";
import { prisma } from "@/lib/db/client";
import {
  getInstallationRepositories,
  type GitHubRepository,
} from "@/lib/github/client";

export const runtime = "nodejs";

function installationIdFromRequest(request: Request): number | null {
  const value = new URL(request.url).searchParams.get("installation_id");
  const installationId = Number(value);
  return Number.isSafeInteger(installationId) && installationId > 0
    ? installationId
    : null;
}

export async function GET(request: Request): Promise<NextResponse> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  }

  const installationId = installationIdFromRequest(request);
  if (!installationId) {
    return NextResponse.json({ error: "invalid_installation" }, { status: 400 });
  }

  const installation = await prisma.installation.findUnique({
    where: { githubInstallationId: String(installationId) },
    select: { id: true, ownerUserId: true },
  });
  if (!installation || installation.ownerUserId !== session.userId) {
    return NextResponse.json({ error: "installation_not_allowed" }, { status: 403 });
  }

  try {
    const repositories = await getInstallationRepositories(installationId);
    const adminRepositories: GitHubRepository[] = [];
    for (const repository of repositories) {
      try {
        await requireRepositoryAdmin(session, repository.full_name);
        adminRepositories.push(repository);
      } catch (authorizationError) {
        if (!(authorizationError instanceof RepositoryAuthorizationError)) {
          throw authorizationError;
        }
        // A user may be able to see an installation but not administer every
        // repository selected by that installation. Do not expose those rows.
      }
    }
    return NextResponse.json({
      repositories: adminRepositories.map((repository) => ({
        id: String(repository.id),
        name: repository.name,
        fullName: repository.full_name,
        ownerLogin: repository.owner.login,
      })),
    });
  } catch {
    return NextResponse.json({ error: "repositories_unavailable" }, { status: 502 });
  }
}
