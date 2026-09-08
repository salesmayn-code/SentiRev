"use server";

import {
  ConnectionStatus,
  ConsentMode,
  JobStatus,
  Prisma,
  ReviewFeedbackStatus,
} from "@prisma/client";
import { z } from "zod";

import { getSession } from "@/lib/auth/session";
import {
  DashboardAccessError,
  requireAuthorizedRepository,
  type DashboardDataDependencies,
} from "@/lib/dashboard/data";
import { prisma } from "@/lib/db/client";
import { publishFoundationJobRetry } from "@/lib/queue/foundation";

import {
  DASHBOARD_MAX_DISMISSAL_NOTE_LENGTH,
  type ConsentUpdateResult,
  type DashboardActionFailure,
  type DashboardActionResult,
  type DeleteHistoryResult,
  type DismissFindingResult,
  type DisconnectRepositoryResult,
  type RetryReviewResult,
  type UndoDismissalResult,
} from "./types";

const repositoryIdSchema = z.string().trim().min(1).max(128);
const findingIdSchema = z.string().trim().min(1).max(128);

const dismissInputSchema = z.object({
  findingId: findingIdSchema,
  note: z
    .string()
    .trim()
    .min(1)
    .max(DASHBOARD_MAX_DISMISSAL_NOTE_LENGTH),
});

const undoInputSchema = z.object({
  findingId: findingIdSchema,
  dismissalId: z.string().trim().min(1).max(128).optional(),
});

const consentInputSchema = z.object({
  repositoryId: repositoryIdSchema,
  mode: z.enum([ConsentMode.AI_ALLOWED, ConsentMode.STATIC_ONLY]),
});

const repositoryInputSchema = z.object({ repositoryId: repositoryIdSchema });

const deleteHistoryInputSchema = z.object({
  repositoryId: repositoryIdSchema,
  /** Exact repository name or exact owner/name, never a partial confirmation. */
  expectedRepositoryName: z.string().min(1).max(512),
});

const retryInputSchema = z.object({
  repositoryId: repositoryIdSchema,
  foundationJobId: z.string().trim().min(1).max(128),
});

export type DashboardActionDependencies = DashboardDataDependencies & {
  now?: () => Date;
  publishRetry?: (foundationJobId: string, retryRequestId: string) => Promise<void>;
};

function now(dependencies: DashboardActionDependencies): Date {
  return dependencies.now?.() ?? new Date();
}

function failure(
  error: DashboardActionFailure["error"],
  retryable = false,
): DashboardActionFailure {
  return { ok: false, error, retryable };
}

function mapFailure(
  error: unknown,
  fallback: DashboardActionFailure["error"] = "operation_failed",
): DashboardActionFailure {
  if (error instanceof DashboardAccessError) {
    return failure(error.code, error.retryable);
  }
  return failure(fallback, true);
}

function repositoryIdFromFindingQuery(finding: {
  foundationJob: { pullRequest: { repositoryId: string } };
}): string {
  return finding.foundationJob.pullRequest.repositoryId;
}

async function findAuthorizedFinding(
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>,
  findingId: string,
  dependencies: DashboardActionDependencies,
) {
  const finding = await prisma.finding.findFirst({
    where: {
      id: findingId,
      foundationJob: {
        pullRequest: {
          repository: { installation: { ownerUserId: session.userId } },
        },
      },
    },
    select: {
      id: true,
      foundationJob: { select: { pullRequest: { select: { repositoryId: true } } } },
    },
  });
  if (!finding) return null;
  await requireAuthorizedRepository(
    session,
    repositoryIdFromFindingQuery(finding),
    dependencies,
  );
  return finding;
}

export async function dismissFindingForSession(
  session: Awaited<ReturnType<typeof getSession>>,
  input: unknown,
  dependencies: DashboardActionDependencies = {},
): Promise<DashboardActionResult<DismissFindingResult>> {
  const parsed = dismissInputSchema.safeParse(input);
  if (!parsed.success) return failure("invalid_input");
  if (!session) return failure("authentication_required");

  try {
    const finding = await findAuthorizedFinding(session, parsed.data.findingId, dependencies);
    if (!finding) return failure("finding_not_found");

    const dismissedAt = now(dependencies);
    const dismissal = await prisma.$transaction(async (tx) => {
      const active = await tx.findingDismissal.findFirst({
        where: { findingId: finding.id, undoneAt: null },
        orderBy: { dismissedAt: "desc" },
        select: { id: true },
      });
      if (active) return { alreadyDismissed: true as const, dismissal: null };

      const created = await tx.findingDismissal.create({
        data: {
          findingId: finding.id,
          note: parsed.data.note,
          dismissedById: session.userId,
          dismissedAt,
        },
        select: { id: true },
      });
      return { alreadyDismissed: false as const, dismissal: created };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    if (dismissal.alreadyDismissed || !dismissal.dismissal) {
      return failure("finding_already_dismissed");
    }
    return {
      ok: true,
      data: {
        findingId: finding.id,
        dismissalId: dismissal.dismissal.id,
        note: parsed.data.note,
        dismissedAt: dismissedAt.toISOString(),
      },
    };
  } catch (error) {
    return mapFailure(error);
  }
}

export async function dismissFinding(
  input: unknown,
): Promise<DashboardActionResult<DismissFindingResult>> {
  return dismissFindingForSession(await getSession(), input);
}

export async function undoFindingDismissalForSession(
  session: Awaited<ReturnType<typeof getSession>>,
  input: unknown,
  dependencies: DashboardActionDependencies = {},
): Promise<DashboardActionResult<UndoDismissalResult>> {
  const parsed = undoInputSchema.safeParse(input);
  if (!parsed.success) return failure("invalid_input");
  if (!session) return failure("authentication_required");

  try {
    const finding = await findAuthorizedFinding(session, parsed.data.findingId, dependencies);
    if (!finding) return failure("finding_not_found");

    const undoneAt = now(dependencies);
    const updated = await prisma.$transaction(async (tx) => {
      const active = await tx.findingDismissal.findFirst({
        where: {
          findingId: finding.id,
          undoneAt: null,
          ...(parsed.data.dismissalId ? { id: parsed.data.dismissalId } : {}),
        },
        orderBy: { dismissedAt: "desc" },
        select: { id: true },
      });
      if (!active) return null;
      return tx.findingDismissal.update({
        where: { id: active.id },
        data: { undoneAt, undoneById: session.userId },
        select: { id: true },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    if (!updated) return failure("finding_not_dismissed");
    return {
      ok: true,
      data: {
        findingId: finding.id,
        dismissalId: updated.id,
        undoneAt: undoneAt.toISOString(),
      },
    };
  } catch (error) {
    return mapFailure(error);
  }
}

export async function undoFindingDismissal(
  input: unknown,
): Promise<DashboardActionResult<UndoDismissalResult>> {
  return undoFindingDismissalForSession(await getSession(), input);
}

export async function setRepositoryConsentForSession(
  session: Awaited<ReturnType<typeof getSession>>,
  input: unknown,
  dependencies: DashboardActionDependencies = {},
): Promise<DashboardActionResult<ConsentUpdateResult>> {
  const parsed = consentInputSchema.safeParse(input);
  if (!parsed.success) return failure("invalid_input");
  if (!session) return failure("authentication_required");

  try {
    const repository = await requireAuthorizedRepository(
      session,
      parsed.data.repositoryId,
      dependencies,
    );
    const recordedAt = now(dependencies);
    const consent = await prisma.repositoryConsent.upsert({
      where: { repositoryId: repository.id },
      update: {
        mode: parsed.data.mode,
        recordedAt,
        recordedById: session.userId,
      },
      create: {
        repositoryId: repository.id,
        mode: parsed.data.mode,
        recordedAt,
        recordedById: session.userId,
      },
      select: { mode: true, recordedAt: true },
    });
    return {
      ok: true,
      data: {
        repositoryId: repository.id,
        mode: consent.mode,
        recordedAt: consent.recordedAt.toISOString(),
      },
    };
  } catch (error) {
    return mapFailure(error);
  }
}

export async function setRepositoryConsent(
  input: unknown,
): Promise<DashboardActionResult<ConsentUpdateResult>> {
  return setRepositoryConsentForSession(await getSession(), input);
}

export async function disconnectRepositoryForSession(
  session: Awaited<ReturnType<typeof getSession>>,
  input: unknown,
  dependencies: DashboardActionDependencies = {},
): Promise<DashboardActionResult<DisconnectRepositoryResult>> {
  const parsed = repositoryInputSchema.safeParse(input);
  if (!parsed.success) return failure("invalid_input");
  if (!session) return failure("authentication_required");

  try {
    const repository = await requireAuthorizedRepository(
      session,
      parsed.data.repositoryId,
      dependencies,
    );
    const updated = await prisma.repository.update({
      where: { id: repository.id },
      data: { connectionStatus: ConnectionStatus.DISCONNECTED },
      select: { id: true, connectionStatus: true },
    });
    return {
      ok: true,
      data: {
        repositoryId: updated.id,
        connectionStatus: updated.connectionStatus,
      },
    };
  } catch (error) {
    return mapFailure(error);
  }
}

export async function disconnectRepository(
  input: unknown,
): Promise<DashboardActionResult<DisconnectRepositoryResult>> {
  return disconnectRepositoryForSession(await getSession(), input);
}

export async function deleteRepositoryHistoryForSession(
  session: Awaited<ReturnType<typeof getSession>>,
  input: unknown,
  dependencies: DashboardActionDependencies = {},
): Promise<DashboardActionResult<DeleteHistoryResult>> {
  const parsed = deleteHistoryInputSchema.safeParse(input);
  if (!parsed.success) return failure("invalid_input");
  if (!session) return failure("authentication_required");

  try {
    const repository = await requireAuthorizedRepository(
      session,
      parsed.data.repositoryId,
      dependencies,
    );
    if (
      parsed.data.expectedRepositoryName !== repository.name
      && parsed.data.expectedRepositoryName !== repository.fullName
    ) {
      return failure("repository_name_mismatch");
    }
    if (repository.connectionStatus !== ConnectionStatus.DISCONNECTED) {
      return failure("repository_not_disconnected");
    }

    const deleted = await prisma.$transaction(async (tx) => {
      const foundationJobFilter = {
        foundationJob: { pullRequest: { repositoryId: repository.id } },
      };
      const findingFilter = {
        finding: { foundationJob: { pullRequest: { repositoryId: repository.id } } },
      };
      const deliveries = await tx.reviewCommentDelivery.deleteMany({
        where: foundationJobFilter,
      });
      const retryRequests = await tx.reviewRetryRequest.deleteMany({
        where: foundationJobFilter,
      });
      const provenance = await tx.findingProvenance.deleteMany({ where: findingFilter });
      const dismissals = await tx.findingDismissal.deleteMany({ where: findingFilter });
      const findings = await tx.finding.deleteMany({
        where: { foundationJob: { pullRequest: { repositoryId: repository.id } } },
      });
      const engineRuns = await tx.engineRun.deleteMany({
        where: foundationJobFilter,
      });
      const jobs = await tx.foundationJob.deleteMany({
        where: { pullRequest: { repositoryId: repository.id } },
      });
      await tx.webhookDelivery.deleteMany({ where: { repositoryId: repository.id } });
      const pullRequests = await tx.pullRequest.deleteMany({
        where: { repositoryId: repository.id },
      });
      // Keep the repository and its current consent/connection record. This is
      // history deletion, not disconnect or repository removal.
      void provenance;
      void dismissals;
      void engineRuns;
      return {
        pullRequests: pullRequests.count,
        jobs: jobs.count,
        findings: findings.count,
        feedbackDeliveries: deliveries.count,
        retryRequests: retryRequests.count,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    return { ok: true, data: { repositoryId: repository.id, deleted } };
  } catch (error) {
    return mapFailure(error);
  }
}

export async function deleteRepositoryHistory(
  input: unknown,
): Promise<DashboardActionResult<DeleteHistoryResult>> {
  return deleteRepositoryHistoryForSession(await getSession(), input);
}

export async function requestReviewRetryForSession(
  session: Awaited<ReturnType<typeof getSession>>,
  input: unknown,
  dependencies: DashboardActionDependencies = {},
): Promise<DashboardActionResult<RetryReviewResult>> {
  const parsed = retryInputSchema.safeParse(input);
  if (!parsed.success) return failure("invalid_input");
  if (!session) return failure("authentication_required");

  try {
    const repository = await requireAuthorizedRepository(
      session,
      parsed.data.repositoryId,
      dependencies,
    );
    const job = await prisma.foundationJob.findFirst({
      where: {
        id: parsed.data.foundationJobId,
        pullRequest: { repositoryId: repository.id },
      },
      select: {
        id: true,
        status: true,
        feedbackDeliveries: {
          where: { status: ReviewFeedbackStatus.FAILED },
          select: { id: true },
        },
      },
    });
    if (!job) return failure("job_not_found");
    const canRetryReview = job.status === JobStatus.FAILED || job.status === JobStatus.PARTIAL;
    const hasFailedDelivery = job.feedbackDeliveries.length > 0;
    const retryKey = `dashboard-retry:${job.id}`;
    const existing = await prisma.reviewRetryRequest.findUnique({
      where: { idempotencyKey: retryKey },
      select: { id: true, foundationJobId: true, status: true },
    });
    // Repeated clicks while the durable request is already queued are a
    // successful idempotent read, even though the job has already moved to
    // QUEUED and is no longer a terminal retry candidate.
    if (!canRetryReview && !hasFailedDelivery && existing?.status !== "QUEUED") {
      return failure("retry_not_available");
    }
    const request = existing?.status === "QUEUED"
      ? existing
      : existing
        ? await prisma.reviewRetryRequest.update({
          where: { id: existing.id },
          data: {
            requestedById: session.userId,
            status: "REQUESTED",
            errorCode: null,
            requestedAt: now(dependencies),
            completedAt: null,
          },
          select: { id: true, foundationJobId: true, status: true },
        })
        : await prisma.reviewRetryRequest.create({
          data: {
            foundationJobId: job.id,
            requestedById: session.userId,
            idempotencyKey: retryKey,
            status: "REQUESTED",
          },
          select: { id: true, foundationJobId: true, status: true },
        });

    // Claim the durable request before publishing. A concurrent click sees the
    // queued state and cannot add a second BullMQ retry job.
    const claim = await prisma.$transaction(async (tx) => {
      const claimed = await tx.reviewRetryRequest.updateMany({
        where: { id: request.id, status: "REQUESTED" },
        data: { status: "QUEUED", errorCode: null },
      });
      if (claimed.count === 0) return claimed;

      // A retry must make the job executable again. In particular, PARTIAL
      // means an AI pass was delayed; leaving it terminal would make the worker
      // silently no-op and persistence would return the stale partial result.
      await tx.foundationJob.update({
        where: { id: job.id },
        data: {
          status: JobStatus.QUEUED,
          completedAt: null,
          failureReason: null,
        },
      });
      if (hasFailedDelivery) {
        await tx.reviewCommentDelivery.updateMany({
          where: {
            foundationJobId: job.id,
            status: ReviewFeedbackStatus.FAILED,
          },
          data: { status: ReviewFeedbackStatus.PENDING, errorCode: null },
        });
      }
      return claimed;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (claim.count > 0) {
      try {
        await (dependencies.publishRetry ?? publishFoundationJobRetry)(
          request.foundationJobId,
          request.id,
        );
      } catch {
        // Do not leave a job queued when its retry message was never accepted
        // by Redis. Returning it to the previously eligible state makes the
        // failure visible and keeps a later retry possible.
        await prisma.foundationJob.updateMany({
          where: { id: job.id, status: JobStatus.QUEUED },
          data: { status: job.status },
        });
        await prisma.reviewRetryRequest.update({
          where: { id: request.id },
          data: { status: "FAILED", errorCode: "queue_publish_failed" },
        });
        return failure("operation_failed", true);
      }
    }

    const current = await prisma.reviewRetryRequest.findUniqueOrThrow({
      where: { id: request.id },
      select: { id: true, foundationJobId: true, status: true },
    });
    return {
      ok: true,
      data: {
        retryRequestId: current.id,
        foundationJobId: current.foundationJobId,
        status: current.status,
      },
    };
  } catch (error) {
    return mapFailure(error);
  }
}

export async function requestReviewRetry(
  input: unknown,
): Promise<DashboardActionResult<RetryReviewResult>> {
  return requestReviewRetryForSession(await getSession(), input);
}
