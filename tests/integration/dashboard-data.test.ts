import {
  ConsentMode,
  ConnectionStatus,
  EngineKind,
  EngineRunOutcome,
  FindingSeverity,
  JobStatus,
  ReviewRetryStatus,
} from "@prisma/client";
import type { Job } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Session } from "@/lib/auth/session";
import {
  deleteRepositoryHistoryForSession,
  dismissFindingForSession,
  disconnectRepositoryForSession,
  requestReviewRetryForSession,
  setRepositoryConsentForSession,
  undoFindingDismissalForSession,
} from "@/lib/dashboard/actions";
import { getDashboardData } from "@/lib/dashboard/data";
import { prisma } from "@/lib/db/client";
import type { FoundationQueuePayload } from "@/lib/queue/foundation";
import { processFoundationJob } from "@/lib/queue/worker";

const runId = `phase-004-dashboard-data-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const repositoryFullName = `phase-004/${runId}`;
const session: Session = {
  userId: "",
  githubUserId: runId,
  githubLogin: runId,
  accessToken: "test-session-token",
  expiresAt: Date.now() + 60_000,
};

let installationId = "";
let repositoryId = "";
let githubRepositoryId = "";
let findingId = "";
let completedJobId = "";
let failedJobId = "";
let partialJobId = "";

const authorize = async (_session: Session, fullName: string) => ({
  id: Number(githubRepositoryId),
  name: fullName.split("/")[1]!,
  full_name: fullName,
  owner: { login: fullName.split("/")[0]! },
  permissions: { admin: true },
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
      ownerLogin: repositoryFullName.split("/")[0]!,
      name: repositoryFullName.split("/")[1]!,
      fullName: repositoryFullName,
      installationId,
      consent: {
        create: { mode: ConsentMode.AI_ALLOWED, recordedById: user.id },
      },
    },
  });
  repositoryId = repository.id;
  githubRepositoryId = repository.githubRepositoryId;

  const pullRequest = await prisma.pullRequest.create({
    data: {
      repositoryId,
      githubNumber: 41,
      headSha: `${runId}-head`,
    },
  });
  const delivery = await prisma.webhookDelivery.create({
    data: {
      githubDeliveryId: `${runId}-delivery`,
      event: "pull_request",
      action: "opened",
      repositoryId,
      pullRequestId: pullRequest.id,
    },
  });
  const job = await prisma.foundationJob.create({
    data: {
      idempotencyKey: `${runId}-job`,
      webhookDeliveryId: delivery.id,
      pullRequestId: pullRequest.id,
      status: JobStatus.COMPLETED,
      changedLineCount: 3,
      reviewDurationMs: 120,
      completedAt: new Date("2026-09-07T10:00:00.000Z"),
    },
  });
  completedJobId = job.id;
  const finding = await prisma.finding.create({
    data: {
      foundationJobId: job.id,
      filePath: "src/auth.ts",
      startLine: 24,
      endLine: 24,
      severity: FindingSeverity.High,
      category: "authorization-bypass",
      fingerprint: `${runId}-finding-fingerprint`,
      summary: "Privileged export lacks an admin role check.",
      reasoning: "Authentication alone does not authorize an administrative export.",
      snippet: "if (user) return exportReport(user.id);",
      createdAt: new Date("2026-09-07T10:00:00.000Z"),
      provenance: {
        create: {
          engineKind: EngineKind.STATIC,
          engineIdentifier: "semgrep@1.176.0",
          staticRuleId: "sentirev.authorization-bypass",
        },
      },
    },
  });
  findingId = finding.id;
  await prisma.engineRun.create({
    data: {
      foundationJobId: job.id,
      engineKind: EngineKind.STATIC,
      engineIdentifier: "semgrep@1.176.0",
      outcome: EngineRunOutcome.SUCCEEDED,
      durationMs: 120,
      findingCount: 1,
    },
  });
  await prisma.reviewCommentDelivery.create({
    data: {
      foundationJobId: job.id,
      findingId,
      kind: "FINDING",
      idempotencyKey: `${runId}-feedback`,
      status: "POSTED",
      githubCommentId: "github-comment-test",
      postedAt: new Date("2026-09-07T10:01:00.000Z"),
    },
  });
  await prisma.reviewCommentDelivery.create({
    data: {
      foundationJobId: job.id,
      kind: "DELAYED",
      idempotencyKey: `${runId}-failed-feedback`,
      status: "FAILED",
      errorCode: "github_503",
    },
  });

  const failedPullRequest = await prisma.pullRequest.create({
    data: {
      repositoryId,
      githubNumber: 42,
      headSha: `${runId}-failed-head`,
    },
  });
  const failedDelivery = await prisma.webhookDelivery.create({
    data: {
      githubDeliveryId: `${runId}-failed-delivery`,
      event: "pull_request",
      action: "synchronize",
      repositoryId,
      pullRequestId: failedPullRequest.id,
    },
  });
  const failedJob = await prisma.foundationJob.create({
    data: {
      idempotencyKey: `${runId}-failed-job`,
      webhookDeliveryId: failedDelivery.id,
      pullRequestId: failedPullRequest.id,
      status: JobStatus.FAILED,
      failureReason: "provider_timeout",
    },
  });
  failedJobId = failedJob.id;

  const partialPullRequest = await prisma.pullRequest.create({
    data: {
      repositoryId,
      githubNumber: 43,
      headSha: `${runId}-partial-head`,
    },
  });
  const partialDelivery = await prisma.webhookDelivery.create({
    data: {
      githubDeliveryId: `${runId}-partial-delivery`,
      event: "pull_request",
      action: "synchronize",
      repositoryId,
      pullRequestId: partialPullRequest.id,
    },
  });
  const partialJob = await prisma.foundationJob.create({
    data: {
      idempotencyKey: `${runId}-partial-job`,
      webhookDeliveryId: partialDelivery.id,
      pullRequestId: partialPullRequest.id,
      status: JobStatus.PARTIAL,
      failureReason: "ai_delayed",
    },
  });
  partialJobId = partialJob.id;
});

afterAll(async () => {
  if (repositoryId) {
    await prisma.reviewCommentDelivery.deleteMany({
      where: { foundationJob: { pullRequest: { repositoryId } } },
    });
    await prisma.reviewRetryRequest.deleteMany({
      where: { foundationJob: { pullRequest: { repositoryId } } },
    });
    await prisma.findingProvenance.deleteMany({
      where: { finding: { foundationJob: { pullRequest: { repositoryId } } } },
    });
    await prisma.findingDismissal.deleteMany({
      where: { finding: { foundationJob: { pullRequest: { repositoryId } } } },
    });
    await prisma.finding.deleteMany({
      where: { foundationJob: { pullRequest: { repositoryId } } },
    });
    await prisma.engineRun.deleteMany({
      where: { foundationJob: { pullRequest: { repositoryId } } },
    });
    await prisma.foundationJob.deleteMany({
      where: { pullRequest: { repositoryId } },
    });
    await prisma.webhookDelivery.deleteMany({ where: { repositoryId } });
    await prisma.pullRequest.deleteMany({ where: { repositoryId } });
    await prisma.repositoryConsent.deleteMany({ where: { repositoryId } });
    await prisma.repository.delete({ where: { id: repositoryId } });
  }
  if (installationId) await prisma.installation.delete({ where: { id: installationId } });
  if (session.userId) await prisma.user.delete({ where: { id: session.userId } });
  await prisma.$disconnect();
});

describe.sequential("Phase 004 dashboard data boundary", () => {
  it("returns safe repository, job, finding, provenance, breakdown, and trend data", async () => {
    const result = await getDashboardData(session, repositoryId, { authorize });

    expect(result.repository).toMatchObject({
      id: repositoryId,
      fullName: repositoryFullName,
      connectionStatus: ConnectionStatus.CONNECTED,
      consentMode: ConsentMode.AI_ALLOWED,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.dismissedFindings).toHaveLength(0);
    expect(result.findings[0]).toMatchObject({
      id: findingId,
      severity: FindingSeverity.High,
      filePath: "src/auth.ts",
      startLine: 24,
      provenance: [{ engineIdentifier: "semgrep@1.176.0" }],
      dismissed: false,
    });
    expect(result.severityBreakdown).toEqual([
      { severity: FindingSeverity.Critical, count: 0 },
      { severity: FindingSeverity.High, count: 1 },
      { severity: FindingSeverity.Medium, count: 0 },
      { severity: FindingSeverity.Low, count: 0 },
    ]);
    expect(result.trend[0]).toMatchObject({ total: 1, date: "2026-09-07" });
    expect(result.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: JobStatus.COMPLETED,
        feedback: expect.arrayContaining([expect.objectContaining({ status: "POSTED", findingId })]),
      }),
      expect.objectContaining({ status: JobStatus.FAILED, failure: "review_failed" }),
    ]));
    expect(JSON.stringify(result)).not.toContain("failureReason");
  });

  it("requires a bounded note, supports dismissal and undo, and preserves the record", async () => {
    expect(
      await dismissFindingForSession(session, { findingId, note: "   " }, { authorize }),
    ).toEqual({ ok: false, error: "invalid_input", retryable: false });

    const dismissed = await dismissFindingForSession(
      session,
      { findingId, note: "Reviewed: this is an intentional admin-only path." },
      { authorize, now: () => new Date("2026-09-07T11:00:00.000Z") },
    );
    expect(dismissed).toMatchObject({ ok: true, data: { findingId, note: "Reviewed: this is an intentional admin-only path." } });

    expect(await getDashboardData(session, repositoryId, { authorize })).toMatchObject({
      findings: [],
      dismissedFindings: [expect.objectContaining({ id: findingId, dismissed: true })],
    });
    const dismissedRow = await prisma.findingDismissal.findFirstOrThrow({ where: { findingId } });
    expect(dismissedRow.undoneAt).toBeNull();

    const undone = await undoFindingDismissalForSession(
      session,
      { findingId, dismissalId: dismissedRow.id },
      { authorize, now: () => new Date("2026-09-07T11:05:00.000Z") },
    );
    expect(undone).toMatchObject({ ok: true, data: { findingId, dismissalId: dismissedRow.id } });
    expect((await prisma.findingDismissal.findUniqueOrThrow({ where: { id: dismissedRow.id } })).undoneAt)
      .toEqual(new Date("2026-09-07T11:05:00.000Z"));
    expect((await getDashboardData(session, repositoryId, { authorize })).findings).toHaveLength(1);
  });

  it("updates consent, disconnects without deleting history, and retries partial or failed review work", async () => {
    const consent = await setRepositoryConsentForSession(
      session,
      { repositoryId, mode: ConsentMode.STATIC_ONLY },
      { authorize, now: () => new Date("2026-09-07T12:00:00.000Z") },
    );
    expect(consent).toMatchObject({ ok: true, data: { mode: ConsentMode.STATIC_ONLY } });

    const disconnected = await disconnectRepositoryForSession(
      session,
      { repositoryId },
      { authorize },
    );
    expect(disconnected).toEqual({
      ok: true,
      data: { repositoryId, connectionStatus: ConnectionStatus.DISCONNECTED },
    });
    expect(await prisma.finding.count({ where: { id: findingId } })).toBe(1);

    const publishRetry = vi.fn().mockResolvedValue(undefined);
    const retry = await requestReviewRetryForSession(
      session,
      { repositoryId, foundationJobId: failedJobId },
      { authorize, now: () => new Date("2026-09-07T12:05:00.000Z"), publishRetry },
    );
    expect(retry).toMatchObject({ ok: true, data: { foundationJobId: failedJobId, status: "QUEUED" } });
    expect(publishRetry).toHaveBeenCalledTimes(1);
    expect(await prisma.foundationJob.findUniqueOrThrow({ where: { id: failedJobId } })).toMatchObject({
      status: JobStatus.QUEUED,
      completedAt: null,
      failureReason: null,
    });
    const secondRetry = await requestReviewRetryForSession(
      session,
      { repositoryId, foundationJobId: failedJobId },
      { authorize, publishRetry },
    );
    expect(secondRetry).toMatchObject({ ok: true, data: { retryRequestId: (retry as { ok: true; data: { retryRequestId: string } }).data.retryRequestId } });
    expect(await prisma.reviewRetryRequest.count({ where: { foundationJobId: failedJobId } })).toBe(1);
    expect(publishRetry).toHaveBeenCalledTimes(1);

    const partialRetry = await requestReviewRetryForSession(
      session,
      { repositoryId, foundationJobId: partialJobId },
      { authorize, publishRetry },
    );
    expect(partialRetry).toMatchObject({ ok: true, data: { foundationJobId: partialJobId, status: "QUEUED" } });
    expect(await prisma.foundationJob.findUniqueOrThrow({ where: { id: partialJobId } })).toMatchObject({
      status: JobStatus.QUEUED,
      completedAt: null,
      failureReason: null,
    });

    const feedbackRetry = await requestReviewRetryForSession(
      session,
      { repositoryId, foundationJobId: completedJobId },
      { authorize, publishRetry },
    );
    expect(feedbackRetry).toMatchObject({ ok: true, data: { foundationJobId: completedJobId, status: "QUEUED" } });
    expect(await prisma.foundationJob.findUniqueOrThrow({ where: { id: completedJobId } })).toMatchObject({
      status: JobStatus.QUEUED,
    });
    expect(await prisma.reviewCommentDelivery.findFirstOrThrow({
      where: { foundationJobId: completedJobId, idempotencyKey: `${runId}-failed-feedback` },
    })).toMatchObject({ status: "PENDING", errorCode: null });
    expect(publishRetry).toHaveBeenCalledTimes(3);
  });

  it("settles a queued retry request after the operational worker completes", async () => {
    await processFoundationJob(
      { data: { foundationJobId: failedJobId }, attemptsMade: 0 } as Job<FoundationQueuePayload>,
      {
        processOperationalReview: async (foundationJobId) => {
          await prisma.foundationJob.update({
            where: { id: foundationJobId },
            data: { status: JobStatus.COMPLETED, completedAt: new Date() },
          });
          return {
            status: "COMPLETED",
            findingCount: 0,
            postedCount: 0,
            deliveryFailureCount: 0,
            replayed: false,
          };
        },
      },
    );

    expect(await prisma.reviewRetryRequest.findFirstOrThrow({
      where: { foundationJobId: failedJobId },
    })).toMatchObject({
      status: ReviewRetryStatus.COMPLETED,
      errorCode: null,
      completedAt: expect.any(Date),
    });
  });

  it("rejects a wrong delete confirmation, then deletes only history after exact confirmation", async () => {
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { connectionStatus: ConnectionStatus.CONNECTED },
    });
    await expect(deleteRepositoryHistoryForSession(
      session,
      { repositoryId, expectedRepositoryName: repositoryFullName },
      { authorize },
    )).resolves.toEqual({ ok: false, error: "repository_not_disconnected", retryable: false });
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { connectionStatus: ConnectionStatus.DISCONNECTED },
    });

    await expect(deleteRepositoryHistoryForSession(
      session,
      { repositoryId, expectedRepositoryName: "not-this-repository" },
      { authorize },
    )).resolves.toEqual({ ok: false, error: "repository_name_mismatch", retryable: false });
    expect(await prisma.finding.count({ where: { id: findingId } })).toBe(1);

    const deleted = await deleteRepositoryHistoryForSession(
      session,
      { repositoryId, expectedRepositoryName: repositoryFullName },
      { authorize },
    );
    expect(deleted).toMatchObject({
      ok: true,
      data: { repositoryId, deleted: { pullRequests: 3, jobs: 3, findings: 1, feedbackDeliveries: 2, retryRequests: 3 } },
    });
    expect(await prisma.repository.findUnique({ where: { id: repositoryId } })).toMatchObject({
      id: repositoryId,
      connectionStatus: ConnectionStatus.DISCONNECTED,
    });
    expect(await prisma.foundationJob.count({ where: { pullRequest: { repositoryId } } })).toBe(0);
    expect(await prisma.findingDismissal.count({ where: { findingId } })).toBe(0);
  });
});
