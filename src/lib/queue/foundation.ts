import { Queue } from "bullmq";

import { getRedisConnection } from "@/lib/queue/connection";

export const FOUNDATION_QUEUE_NAME = "foundation-events";

export type FoundationQueuePayload = {
  foundationJobId: string;
};

let queue: Queue<FoundationQueuePayload> | undefined;

export function getFoundationQueue(): Queue<FoundationQueuePayload> {
  queue ??= new Queue<FoundationQueuePayload>(FOUNDATION_QUEUE_NAME, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: false,
      removeOnFail: false,
    },
  });
  return queue;
}

export async function closeFoundationQueue(): Promise<void> {
  if (!queue) return;
  await queue.close();
  queue = undefined;
}
