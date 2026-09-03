import { JobStatus } from "@prisma/client";
import { Worker, type Job } from "bullmq";

import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "@/lib/queue/connection";
import {
  FOUNDATION_QUEUE_NAME,
  type FoundationQueuePayload,
} from "@/lib/queue/foundation";
import { reconcileQueuedFoundationJobs } from "@/lib/queue/outbox";

export type FoundationWorkerOptions = {
  beforeComplete?: (
    payload: FoundationQueuePayload,
    attemptNumber: number,
  ) => Promise<void>;
};

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "Unknown worker failure";
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
    await options.beforeComplete?.(job.data, job.attemptsMade + 1);
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
