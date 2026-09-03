import { JobStatus, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import { getFoundationQueue } from "@/lib/queue/foundation";

export async function publishQueuedFoundationJob(foundationJobId: string) {
  const foundationJob = await prisma.foundationJob.findUniqueOrThrow({
    where: { id: foundationJobId },
    select: { id: true, idempotencyKey: true, status: true },
  });

  if (foundationJob.status !== JobStatus.QUEUED) {
    return foundationJob;
  }

  await getFoundationQueue().add(
    "process-foundation-event",
    { foundationJobId: foundationJob.id },
    { jobId: foundationJob.id },
  );

  return prisma.foundationJob.update({
    where: { id: foundationJob.id },
    data: { queuePublishedAt: new Date() },
  });
}

export async function reconcileQueuedFoundationJobs() {
  const queuedJobs = await prisma.foundationJob.findMany({
    where: { status: JobStatus.QUEUED },
    select: { id: true },
  });

  for (const queuedJob of queuedJobs) {
    await publishQueuedFoundationJob(queuedJob.id);
  }

  return queuedJobs.length;
}

export async function createFoundationOutboxJob(
  tx: Prisma.TransactionClient,
  input: {
    webhookDeliveryId: string;
    pullRequestId: string;
    idempotencyKey: string;
  },
) {
  return tx.foundationJob.upsert({
    where: { webhookDeliveryId: input.webhookDeliveryId },
    update: {},
    create: {
      webhookDeliveryId: input.webhookDeliveryId,
      pullRequestId: input.pullRequestId,
      idempotencyKey: input.idempotencyKey,
      status: JobStatus.QUEUED,
    },
  });
}
