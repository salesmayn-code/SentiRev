import { ConnectionStatus, ConsentMode } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getSession } from "@/lib/auth/session";
import {
  RepositoryAuthorizationError,
  requireRepositoryAdmin,
} from "@/lib/auth/authorization";
import { prisma } from "@/lib/db/client";
import { getInstallationRepositories, type GitHubRepository } from "@/lib/github/client";

export const runtime = "nodejs";

const completeSchema = z.object({
  installationId: z.union([
    z.number().int().positive(),
    z.string().regex(/^\d+$/u),
  ]),
  repositoryIds: z
    .array(z.union([z.number().int().positive(), z.string().regex(/^\d+$/u)]))
    .min(1)
    .max(100),
  consentMode: z.enum(["AI_ALLOWED", "STATIC_ONLY"]),
});

function asStringId(value: number | string): string {
  return String(value);
}

export async function POST(request: Request): Promise<NextResponse> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = completeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_installation_selection" }, { status: 400 });
  }

  const installationId = asStringId(parsed.data.installationId);
  const repositoryIds = [...new Set(parsed.data.repositoryIds.map(asStringId))];
  if (repositoryIds.length === 0) {
    return NextResponse.json({ error: "no_repositories_selected" }, { status: 400 });
  }

  const installation = await prisma.installation.findUnique({
    where: { githubInstallationId: installationId },
    select: { id: true, ownerUserId: true },
  });
  if (!installation || installation.ownerUserId !== session.userId) {
    return NextResponse.json({ error: "installation_not_allowed" }, { status: 403 });
  }

  try {
    const availableRepositories = await getInstallationRepositories(
      Number(installationId),
    );
    const selected = availableRepositories.filter((repository) =>
      repositoryIds.includes(String(repository.id)),
    );
    if (selected.length !== repositoryIds.length) {
      return NextResponse.json(
        { error: "repository_selection_not_available" },
        { status: 403 },
      );
    }

    const authorizedRepositories: GitHubRepository[] = [];
    for (const repository of selected) {
      try {
        authorizedRepositories.push(
          await requireRepositoryAdmin(session, repository.full_name),
        );
      } catch (authorizationError) {
        if (!(authorizationError instanceof RepositoryAuthorizationError)) {
          throw authorizationError;
        }
        return NextResponse.json(
          { error: "repository_admin_required", repository: repository.full_name },
          { status: 403 },
        );
      }
    }

    const persisted = await prisma.$transaction(async (tx) => {
      const output = [];
      for (const repository of authorizedRepositories) {
        const existing = await tx.repository.findUnique({
          where: { githubRepositoryId: String(repository.id) },
          select: { installation: { select: { ownerUserId: true } } },
        });
        if (existing && existing.installation.ownerUserId !== session.userId) {
          throw new Error("repository_not_allowed");
        }

        const persistedRepository = await tx.repository.upsert({
          where: { githubRepositoryId: String(repository.id) },
          update: {
            ownerLogin: repository.owner.login,
            name: repository.name,
            fullName: repository.full_name,
            installationId: installation.id,
            connectionStatus: ConnectionStatus.CONNECTED,
          },
          create: {
            githubRepositoryId: String(repository.id),
            ownerLogin: repository.owner.login,
            name: repository.name,
            fullName: repository.full_name,
            installationId: installation.id,
            connectionStatus: ConnectionStatus.CONNECTED,
          },
          select: { id: true, fullName: true, name: true, ownerLogin: true },
        });
        await tx.repositoryConsent.upsert({
          where: { repositoryId: persistedRepository.id },
          update: {
            mode: parsed.data.consentMode as ConsentMode,
            recordedAt: new Date(),
            recordedById: session.userId,
          },
          create: {
            repositoryId: persistedRepository.id,
            mode: parsed.data.consentMode as ConsentMode,
            recordedById: session.userId,
          },
        });
        output.push(persistedRepository);
      }
      return output;
    });

    return NextResponse.json({ repositories: persisted });
  } catch (error) {
    if (error instanceof Error && error.message === "repository_not_allowed") {
      return NextResponse.json({ error: "repository_not_allowed" }, { status: 403 });
    }
    return NextResponse.json({ error: "installation_failed" }, { status: 502 });
  }
}
