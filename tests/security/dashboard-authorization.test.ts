import { ConsentMode } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Session } from "@/lib/auth/session";
import {
  RepositoryAuthorizationError,
} from "@/lib/auth/authorization";
import {
  deleteRepositoryHistoryForSession,
  dismissFindingForSession,
  disconnectRepositoryForSession,
  requestReviewRetryForSession,
  setRepositoryConsentForSession,
} from "@/lib/dashboard/actions";
import {
  DashboardAccessError,
  getDashboardData,
  getDashboardRepositories,
} from "@/lib/dashboard/data";
import { prisma } from "@/lib/db/client";

const runId = `phase-004-dashboard-auth-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const fullName = `phase-004-auth/${runId}`;
const session: Session = {
  userId: "",
  githubUserId: runId,
  githubLogin: runId,
  accessToken: "test-session-token",
  expiresAt: Date.now() + 60_000,
};
let repositoryId = "";
let installationId = "";

const deniedAuthorization = vi.fn(async () => {
  throw new RepositoryAuthorizationError();
});

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { githubUserId: runId, login: runId },
  });
  session.userId = user.id;
  const installation = await prisma.installation.create({
    data: {
      githubInstallationId: `${Date.now()}${Math.floor(Math.random() * 99)}`,
      ownerUserId: user.id,
    },
  });
  installationId = installation.id;
  const repository = await prisma.repository.create({
    data: {
      githubRepositoryId: `${Date.now()}${Math.floor(Math.random() * 99)}`,
      ownerLogin: fullName.split("/")[0]!,
      name: fullName.split("/")[1]!,
      fullName,
      installationId,
      consent: {
        create: { mode: ConsentMode.STATIC_ONLY, recordedById: user.id },
      },
    },
  });
  repositoryId = repository.id;
});

afterAll(async () => {
  if (repositoryId) {
    await prisma.repositoryConsent.deleteMany({ where: { repositoryId } });
    await prisma.repository.delete({ where: { id: repositoryId } });
  }
  if (installationId) await prisma.installation.delete({ where: { id: installationId } });
  if (session.userId) await prisma.user.delete({ where: { id: session.userId } });
  await prisma.$disconnect();
});

describe.sequential("dashboard authorization boundary", () => {
  it("reveals nothing to an unauthenticated read", async () => {
    await expect(getDashboardRepositories(null)).rejects.toMatchObject({
      name: "DashboardAccessError",
      code: "authentication_required",
    });
    await expect(getDashboardData(null, repositoryId)).rejects.toBeInstanceOf(
      DashboardAccessError,
    );
  });

  it("omits a stored repository when GitHub no longer confirms admin access", async () => {
    deniedAuthorization.mockClear();
    await expect(
      getDashboardRepositories(session, { authorize: deniedAuthorization }),
    ).resolves.toEqual([]);
    expect(deniedAuthorization).toHaveBeenCalledWith(session, fullName);
    await expect(
      getDashboardData(session, repositoryId, { authorize: deniedAuthorization }),
    ).rejects.toMatchObject({ code: "repository_access_denied" });
  });

  it("rechecks admin access before every mutation and changes no data when denied", async () => {
    const before = await prisma.repository.findUniqueOrThrow({
      where: { id: repositoryId },
      select: { connectionStatus: true, consent: { select: { mode: true } } },
    });
    const dependencies = { authorize: deniedAuthorization };

    await expect(setRepositoryConsentForSession(
      session,
      { repositoryId, mode: ConsentMode.AI_ALLOWED },
      dependencies,
    )).resolves.toEqual({ ok: false, error: "repository_access_denied", retryable: false });
    await expect(disconnectRepositoryForSession(session, { repositoryId }, dependencies))
      .resolves.toEqual({ ok: false, error: "repository_access_denied", retryable: false });
    await expect(deleteRepositoryHistoryForSession(
      session,
      { repositoryId, expectedRepositoryName: fullName },
      dependencies,
    )).resolves.toEqual({ ok: false, error: "repository_access_denied", retryable: false });
    await expect(requestReviewRetryForSession(
      session,
      { repositoryId, foundationJobId: "not-a-job" },
      dependencies,
    )).resolves.toEqual({ ok: false, error: "repository_access_denied", retryable: false });
    await expect(dismissFindingForSession(
      session,
      { findingId: "not-a-finding", note: "not authorized" },
      dependencies,
    )).resolves.toEqual({ ok: false, error: "finding_not_found", retryable: false });

    expect(await prisma.repository.findUniqueOrThrow({
      where: { id: repositoryId },
      select: { connectionStatus: true, consent: { select: { mode: true } } },
    })).toEqual(before);
  });

  it("rejects malformed mutations before authorization or persistence", async () => {
    deniedAuthorization.mockClear();
    await expect(setRepositoryConsentForSession(
      session,
      { repositoryId, mode: "invalid" },
      { authorize: deniedAuthorization },
    )).resolves.toEqual({ ok: false, error: "invalid_input", retryable: false });
    await expect(dismissFindingForSession(
      session,
      { findingId: "finding", note: " " },
      { authorize: deniedAuthorization },
    )).resolves.toEqual({ ok: false, error: "invalid_input", retryable: false });
    expect(deniedAuthorization).not.toHaveBeenCalled();
  });
});
