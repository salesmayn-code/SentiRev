import { JobStatus, ReviewRetryStatus } from "@prisma/client";
import { Worker, type Job } from "bullmq";

import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "@/lib/queue/connection";
import {
  FOUNDATION_QUEUE_NAME,
  type FoundationQueuePayload,
} from "@/lib/queue/foundation";
import { reconcileQueuedFoundationJobs } from "@/lib/queue/outbox";
import {
  processOperationalReview,
  type OperationalReviewResult,
} from "@/lib/review/operational";

export type FoundationWorkerOptions = {
  beforeComplete?: (
    payload: FoundationQueuePayload,
    attemptNumber: number,
  ) => Promise<void>;
  /** Test seam for the Phase 004 operational boundary. */
  processOperationalReview?: (foundationJobId: string) => Promise<OperationalReviewResult>;
};

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "Unknown worker failure";
}

async function finishQueuedRetryRequests(
  foundationJobId: string,
  result: OperationalReviewResult,
): Promise<void> {
  const retryFailed = result.status === "FAILED" || result.deliveryFailureCount > 0;
  await prisma.reviewRetryRequest.updateMany({
    where: { foundationJobId, status: ReviewRetryStatus.QUEUED },
    data: {
      status: retryFailed ? ReviewRetryStatus.FAILED : ReviewRetryStatus.COMPLETED,
      completedAt: new Date(),
      errorCode: retryFailed ? "retry_review_failed" : null,
    },
  });
}

export async function processFoundationJob(
  job: Job<FoundationQueuePayload>,
  options: FoundationWorkerOptions = {},
): Promise<void> {
  const { foundationJobId } = job.data;
  const started = await prisma.foundationJob.updateMany({
    where: {
      id: foundationJobId,
      status: { in: [JobStatus.QUEUED, JobStatus.FAILED] },
    },
    data: {
      status: JobStatus.RUNNING,
      attempts: { increment: 1 },
      completedAt: null,
      failureReason: null,
    },
  });

  // A retained BullMQ job or concurrent delivery replay may invoke the same
  // durable identifier again. A completed or already-running row is a no-op.
  if (started.count === 0) return;

  try {
    // Phase 001 tests provide their explicit completion hook. Production jobs
    // take the bounded review/feedback path and retain its terminal status
    // (including partial or failed) rather than overwriting it as completed.
    if (options.beforeComplete) {
      await options.beforeComplete(job.data, job.attemptsMade + 1);
    } else {
      const result = await (options.processOperationalReview ?? processOperationalReview)(
        foundationJobId,
      );
      await finishQueuedRetryRequests(foundationJobId, result);
      return;
    }
    await prisma.foundationJob.updateMany({
      where: { id: foundationJobId, status: JobStatus.RUNNING },
      data: { status: JobStatus.COMPLETED, completedAt: new Date() },
    });
  } catch (error) {
    await prisma.foundationJob.updateMany({
      where: { id: foundationJobId, status: JobStatus.RUNNING },
      data: {
        status: JobStatus.FAILED,
        failureReason: failureMessage(error),
      },
    });
    throw error;
  }
}

export async function startFoundationWorker(
  options: FoundationWorkerOptions = {},
): Promise<Worker<FoundationQueuePayload>> {
  await reconcileQueuedFoundationJobs();
  return new Worker<FoundationQueuePayload>(
    FOUNDATION_QUEUE_NAME,
    async (job) => processFoundationJob(job, options),
    { connection: getRedisConnection() },
  );
}
